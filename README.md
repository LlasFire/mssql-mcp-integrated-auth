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
- `lib/guards.mjs` holds the read-only/single-statement safety checks,
  `lib/sql-identifiers.mjs` holds the SQL-escaping helpers, and
  `lib/schema-queries.mjs` holds the SQL-text builders for every
  `list_*`/`describe_*` tool. All three are plain, dependency-free
  functions with their own unit tests (see Testing below), imported by
  `mssql-server.mjs` rather than inlined into the tool handlers.

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

Three groups: list objects, inspect one object deeply, or run your own
read-only query once you know the shape of the data.

| Tool | Arguments | Notes |
|---|---|---|
| `list_environments` | none | Lists the environments from `sources.json`. |
| `list_databases` | `env` | Databases visible on that environment. |
| `list_tables` | `env`, `database?`, `schema?` | Base tables only (`TABLE_TYPE = 'BASE TABLE'`). Views are excluded on purpose; use `list_views`. |
| `list_views` | `env`, `database?`, `schema?` | Views only, from `INFORMATION_SCHEMA.VIEWS`. |
| `list_stored_procedures` | `env`, `database?`, `schema?` | Names only, from `INFORMATION_SCHEMA.ROUTINES`. |
| `list_functions` | `env`, `database?`, `schema?` | Scalar, inline table-valued, and multi-statement table-valued functions, with return type. |
| `list_triggers` | `env`, `database?`, `table?` | DML triggers on tables only (not database/server-level triggers). Shows which table, INSTEAD OF vs AFTER, and enabled/disabled. |
| `describe_table` | `env`, `table`, `database?`, `schema?` | Columns, primary key, foreign keys (with the referenced table/column), unique constraints, and check constraints. |
| `describe_procedure` | `env`, `name`, `database?`, `schema?` | Parameters and the full `CREATE PROCEDURE` body. |
| `describe_function` | `env`, `name`, `database?`, `schema?` | Parameters and the full `CREATE FUNCTION` body. |
| `describe_trigger` | `env`, `trigger`, `database?` | The full trigger body, its table, and INSTEAD OF/disabled flags. |
| `run_query` | `env`, `sql`, `database?`, `maxRows?` | Ad hoc read-only queries. Write the T-SQL yourself once the tools above have told you what's there; see Safety below. |

`describe_procedure` and `describe_function` come back with an empty
`definition` field if the object is encrypted (`WITH ENCRYPTION`) or you
lack `VIEW DEFINITION` permission on it. That's SQL Server withholding the
text, not a bug in this tool.

Note on scope: schema discovery (the `list_*` tools), deep inspection (the
`describe_*` tools), and ad hoc querying (`run_query`) are kept as three
separate concerns on purpose. There's no single tool that writes,
explains, and runs a query for you; instead, the `list_*`/`describe_*`
tools give an MCP client (Claude, or anything else) enough context about
the real schema to write correct T-SQL itself, and `run_query` is what
actually executes it, read-only, with the same safety rules as everything
else here.

## Safety

- `run_query` only accepts a single `SELECT`/`WITH` statement. Anything
  with a semicolon before the end (a batched second statement), or any
  mutating keyword (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `EXEC`,
  `TRUNCATE`, `MERGE`, `CREATE`, `GRANT`, `REVOKE`, `DENY`) anywhere in the
  text, gets rejected before it reaches SQL Server.
- This is a keyword/shape heuristic, not a SQL parser. It deliberately
  fails toward over-rejecting: the keyword check matches on word
  boundaries, so `LIKE '%dropped%'` is fine (`drop` isn't a whole word
  there), but a mutating keyword that *is* a whole word inside a string
  literal, e.g. `WHERE Notes LIKE '%please delete this%'`, still gets
  rejected. If you need real write access or need to relax this, do it
  deliberately by editing `assertReadOnly()` in `lib/guards.mjs`, and
  prefer granting a read-only SQL/Windows login on the server side over
  loosening this check.
- Every `list_*`/`describe_*` tool builds its SQL by interpolating your
  arguments (a schema, table, or procedure name) into a query string,
  since the PowerShell worker executes a full T-SQL batch by text and has
  no real parameter binding. Those values all go through
  `sqlLiteral()`/`optionalEqualsClause()` in `lib/sql-identifiers.mjs`
  first, which is the one place that escapes embedded quotes so a name
  like `Orders'; DROP TABLE Orders; --` can't break out of the string it's
  placed in. See `test/sql-identifiers.test.mjs` for the exact injection
  case this defends against.
- Results are capped at 200 rows by default, 2000 rows maximum
  (`maxRows` argument), with a `truncated` flag in the response.
- Every `run_query` call (success or failure) is appended to
  `query-log.jsonl` next to the server: timestamp, environment, database,
  the SQL text, row count or error, and duration. That file is gitignored;
  treat it as local audit history, not something to commit or share as-is.

## Testing

There are two tiers, because only one of them can run without a real SQL
Server behind it:

1. **Unit tests (`npm test`)** run three files with Node's built-in test
   runner, no extra dependencies, no network, no SQL Server:
   - `test/guards.test.mjs` covers the safety guard logic in
     `lib/guards.mjs` (`isSingleStatement`, `isReadOnly`, `assertReadOnly`,
     `clampMaxRows`).
   - `test/sql-identifiers.test.mjs` covers the escaping helpers in
     `lib/sql-identifiers.mjs`, including a real SQL-injection string to
     confirm it comes out as one inert literal.
   - `test/schema-queries.test.mjs` covers every SQL-text builder in
     `lib/schema-queries.mjs` (the `list_*`/`describe_*` tools): that
     optional filters are appended correctly, that `list_tables` actually
     excludes views now, and that a malicious schema/table/procedure name
     comes out escaped in the generated SQL rather than raw.

   These run in CI (`.github/workflows/test.yml`, on `windows-latest`) on
   every push and pull request. This is what actually protects
   `run_query` and the schema tools: if someone loosens the read-only
   check or drops the escaping, a test should fail before it ships.

   `npm test` lists each test file explicitly
   (`node --test test/guards.test.mjs test/sql-identifiers.test.mjs
   test/schema-queries.test.mjs`) rather than a directory glob, because
   Node's test runner auto-discovers any file matching `*.test.mjs` or
   `*-test.mjs` on its own; a bare `node --test` would otherwise also
   pick up `scripts/smoke-check.mjs` if it were named `smoke-test.mjs`.
   If you add a new test file under `test/`, add it to this script too.

2. **Smoke test (`npm run smoke-test`, runs `scripts/smoke-check.mjs`)**
   is a manual, local, end-to-end check. It spawns the real server,
   performs the actual MCP `initialize` handshake over stdio (not a
   shortcut), then calls `list_environments` and `list_databases` against
   a real environment. Run it yourself after `sources.json` is set up,
   and again after touching `worker.ps1` or the connection-handling code
   in `mssql-server.mjs`, since that's the part unit tests can't reach.
   (It's named `smoke-check.mjs` rather than `smoke-test.mjs` on purpose:
   Node's test runner auto-discovers any `*-test.mjs` file by default, and
   this script needs a live SQL Server, so it must never run by accident
   as part of `npm test` or a bare `node --test`.)

   ```powershell
   npm run smoke-test
   npm run smoke-test -- --env dev
   ```

   It exits non-zero on failure, so it's fine to chain after `npm install`
   when you just want a quick "does this actually work" check.

What's **not** covered by either tier, and is still worth checking by hand
after a change: the PowerShell worker's connection-reuse behavior (first
query slow, repeat queries fast), and the row-cap/`truncated` flag on a
query that actually returns more rows than the cap.

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
