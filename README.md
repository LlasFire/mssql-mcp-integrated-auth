# mssql-mcp-integrated-auth

An MCP server that lets Claude (or any MCP client) query SQL Server across
multiple named environments (dev, qa, prod, or whatever you call them),
using Windows-integrated authentication only. There is no username or
password anywhere in this repo or its config, on purpose: it authenticates
as whichever Windows account is running the process.

## Why this exists

Most SQL Server MCP servers assume SQL logins (username + password). If
your SQL Server instances only accept Windows/AD ("trusted connection" /
SSO) authentication, none of them work. This one shells out to
`System.Data.SqlClient` with `Integrated Security=True`, which is the
standard .NET way to authenticate with the calling process's own Windows
identity, and keeps the resulting connections open across calls instead of
reconnecting every time.

## How it works

- `mssql-server.mjs` is the MCP server (stdio transport, built on the
  official `@modelcontextprotocol/sdk`).
- It spawns one persistent PowerShell process (`worker.ps1`) that keeps a
  `SqlConnection` open per environment/database pair and reuses it across
  calls. The first query against a given environment pays a normal connect
  cost; every query after that is fast.
- `sources.json` (not committed, see setup) lists your environments: host,
  optional named instance, and default database. No credentials live here
  either, since there aren't any to store.

## Requirements

- Windows. `Integrated Security=True` relies on the Windows security
  context, so this will not work on macOS/Linux as written.
- [Node.js](https://nodejs.org/) 18 or later.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) (or another
  MCP client that supports stdio servers).
- A Windows/AD account that already has the SQL Server access you need.
  See "Which account Claude runs as" below, it matters here more than for
  most MCP servers.

## Setup

```powershell
git clone <this-repo-url>
cd mssql-mcp-integrated-auth
npm install

# Copy the example config and fill in your real environments
copy sources.example.json sources.json
notepad sources.json
```

`sources.json` is a plain array, one entry per environment:

```json
[
  { "id": "dev", "host": "sql-dev.example.internal", "instanceName": "SQLINSTANCE", "database": "master" }
]
```

`instanceName` and `database` are optional. Leave `instanceName` out for a
default instance; leave `database` out and it falls back to `master`
(every tool that needs a specific database also takes a `database`
argument at call time, so this default rarely matters in practice).

Then register it with Claude Code:

```powershell
claude mcp add mssql -s user -- node "C:\full\path\to\mssql-server.mjs"
```

Run `claude mcp get mssql` to confirm it shows as connected.

## Which account Claude runs as (read this)

Because this uses Windows-integrated auth, there are no credentials to
configure. Instead, **whatever Windows account is running `claude` is the
account that authenticates to SQL Server**, since this MCP server is a
child process of that `claude` process and inherits its security context.

Two situations:

1. **Your normal logged-in Windows account already has the SQL Server
   access you need.** Nothing special to do, just run `claude` normally
   and this MCP server works.

2. **Your normal account doesn't have access, but a different account
   does** (a service account, a different domain account, etc.). You need
   to launch `claude` under *that* account's network identity before it
   starts, so this MCP server's SQL connections carry the right identity.
   The included `Start-With-Alternate-Account.cmd` does this with
   `runas /netonly`:
   - It keeps you logged in locally as yourself (no local logoff/relogon).
   - It swaps out just the *network* credentials for the process tree it
     launches, which is exactly the child MCP server process, for the
     account you specify.
   - Edit the `DOMAIN\username` placeholder in that file before running
     it, then run it directly (double-click or run it as itself, not
     pasted into an existing shell) so the password prompt has a place to
     attach. It opens a console running `claude` under the alternate
     identity; use Claude from that console.

If you're not sure which situation you're in, just try running `claude`
normally first and ask it to run `list_environments` then `list_databases`
against one environment. A clean result means you're in situation 1; a
login/access-denied error from SQL Server means situation 2.

## Tools

| Tool | Arguments | Notes |
|---|---|---|
| `list_environments` | none | Lists the environments from `sources.json`. |
| `list_databases` | `env` | Databases visible on that environment. |
| `list_tables` | `env`, `database?`, `schema?` | From `INFORMATION_SCHEMA.TABLES`. |
| `describe_table` | `env`, `table`, `database?`, `schema?` | Columns, types, nullability, from `INFORMATION_SCHEMA.COLUMNS`. |
| `run_query` | `env`, `sql`, `database?`, `maxRows?` | Read-only only, see below. |

## Safety

- `run_query` only accepts a single `SELECT`/`WITH` statement. Anything
  with a semicolon before the end (a batched second statement), or any
  mutating keyword (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `EXEC`,
  `TRUNCATE`, `MERGE`, `CREATE`, `GRANT`, `REVOKE`, `DENY`) anywhere in the
  text, gets rejected before it reaches SQL Server.
- This is a keyword/shape heuristic, not a SQL parser. It deliberately
  fails toward over-rejecting: a legitimate query containing one of those
  words inside a string literal (e.g. `WHERE Notes LIKE '%dropped%'`) will
  also get rejected. If you need real write access or need to relax this,
  do it deliberately by editing `assertReadOnly()` in `mssql-server.mjs`,
  and prefer granting a read-only SQL/Windows login on the server side
  over loosening this check.
- Results are capped at 200 rows by default, 2000 rows maximum
  (`maxRows` argument), with a `truncated` flag in the response.
- Every `run_query` call (success or failure) is appended to
  `query-log.jsonl` next to the server: timestamp, environment, database,
  the SQL text, row count or error, and duration. That file is gitignored;
  treat it as local audit history, not something to commit or share as-is.

## Known limitations

- Named instances resolve via the SQL Server Browser service (UDP 1434).
  If that's blocked on your network, connections may fail intermittently
  or outright; ask your DBA for a fixed port and add a `port` field next
  to `host` in `sources.json` as a workaround (you'll need to extend
  `worker.ps1`'s connection string to use it).
- No cross-environment joins. Each environment is a separate SQL Server
  connection, so you can join across databases *within* one environment
  (three/four-part names), but not across dev and prod in the same query.
- Windows-integrated auth only. If you need SQL logins instead, this isn't
  the tool for that; look at other MSSQL MCP servers that take a
  connection string.

## License

Add whatever license fits how you're sharing this internally; none is
set by default.
