---
name: mssql-mcp-integrated-auth
description: "Guides Claude through using the mssql-mcp-integrated-auth MCP server (tools: list_environments, list_databases, list_tables, list_views, list_stored_procedures, list_functions, list_triggers, describe_table, describe_procedure, describe_function, describe_trigger, run_query) to explore and query SQL Server across multiple named environments over Windows-integrated auth. Covers the right discovery order, how to compare a value across environments, how to read the errors this server produces, and its read-only safety rules. Use this whenever the person asks to look up, inspect, compare, or query anything in a SQL Server database, table, view, stored procedure, function, or trigger across named environments (dev/qa/prod or similar), even if they don't name the MCP tool directly. Also use it if a query against one of these environments fails and needs troubleshooting, or if the person asks what environments/databases/tables are available."
---

# Using the mssql-mcp-integrated-auth server

This server gives you read-only, Windows-authenticated access to one or
more SQL Server environments. It has no stored credentials: it
authenticates as whatever Windows account is running Claude Code. That
matters for troubleshooting (see "When something fails" below) but not
for how you use the tools day to day.

## Discovery order — don't skip straight to guessing

The single biggest failure mode with this server is writing SQL against
a table, column, or procedure name you assumed rather than looked up.
Every `list_*`/`describe_*` tool exists specifically so you never have to
guess. Work through these in order, stopping as soon as you have what you
need:

1. **`list_environments`** — always call this first if you don't already
   know the exact environment ids. Don't assume they're called `dev`,
   `qa`, and `prod`; whoever set up this install named them in
   `sources.json`, and it could be anything.
2. **`list_databases(env)`** — if you don't already know which database
   holds what you're after.
3. **`list_tables` / `list_views` / `list_stored_procedures` /
   `list_functions` / `list_triggers`** (all take an optional `schema`
   filter) — to find the actual object name rather than assume one.
   Remember `list_tables` returns base tables only; views are separate.
4. **`describe_table` / `describe_procedure` / `describe_function` /
   `describe_trigger`** on the specific object — to see its real columns,
   types, constraints, parameters, or definition before you write a query
   about it or explain what it does.
5. **`run_query`** — the actual read-only SQL, now that you know the real
   shape of things.

If the person already told you the exact table/column names in their
message, you can skip straight to `run_query` — the point is not to
mechanically call every tool every time, it's to never fabricate a name
you haven't confirmed exists.

## Comparing something across environments

This is a common and genuinely useful pattern with this server: the same
read-only query, run against each environment in turn, to see where
something differs. For example, comparing a version string or a setting
stored in an application config/settings table across dev, qa, and prod
to see which environments are out of date.

1. Call `list_environments` once to get the real list.
2. Run the identical `run_query` (same SQL text) against each relevant
   `env`, one at a time.
3. Present the results side by side and call out which environments
   differ, rather than just dumping three separate result sets and
   leaving the comparison to the person.

## Safety rules — these are load-bearing, not suggestions

- `run_query` only executes a single read-only `SELECT`/`WITH` statement.
  Writes and multi-statement batches are rejected before they reach SQL
  Server. If a legitimate-looking query gets rejected, the likely cause
  is a mutating keyword (like "delete" or "update") appearing as a whole
  word inside a string literal — rephrase the query rather than trying to
  work around the check. Don't suggest disabling or loosening this check
  to get a query through; if someone genuinely needs write access, that's
  a deliberate decision for them to make by editing `lib/guards.mjs`
  themselves, not something to route around in a single session.
- Results are capped (200 rows by default, 2000 rows maximum via
  `maxRows`). If a result comes back `truncated`, say so plainly and
  suggest narrowing the query (a tighter `WHERE`, or `ORDER BY` + `TOP`)
  rather than just maxing out `maxRows` and hoping that's enough.
- Every `run_query` call is locally logged (`query-log.jsonl`) with the
  SQL text, timing, and outcome. That's expected audit behavior, not
  something to avoid triggering.

## When something fails

- **Login or access-denied error** on `list_databases` or `run_query`
  almost always means the Windows account running Claude Code doesn't
  have SQL Server access for that environment — not a bug in the tool.
  Say so, and point at the "Which account Claude runs as" section of the
  server's README rather than silently retrying the same call.
- **`describe_procedure`/`describe_function` returns an empty
  `definition`** — the object is encrypted (`WITH ENCRYPTION`) or the
  account lacks `VIEW DEFINITION` permission on it. That's SQL Server
  withholding the text, not a broken tool; say so rather than treating it
  as an empty/missing procedure.
- **"Unknown environment" error** — the `env` value you used doesn't
  match any id from `list_environments`. Re-check that list instead of
  guessing common names like `dev`/`test`/`stage`.
- **A table/procedure "not found" error from a `describe_*` tool** — it
  either doesn't exist, or exists but isn't visible to the current
  account/schema filter. Try again without a `schema` filter, or confirm
  the name via the matching `list_*` tool, before concluding it's missing.

## Quick reference

| You want to... | Use |
|---|---|
| See what environments exist | `list_environments` |
| See what databases exist on one | `list_databases` |
| Find a table | `list_tables` |
| Find a view | `list_views` |
| Find a stored procedure | `list_stored_procedures` |
| Find a function | `list_functions` |
| Find a trigger | `list_triggers` |
| See a table's columns/keys/constraints | `describe_table` |
| Read a procedure's parameters + body | `describe_procedure` |
| Read a function's parameters + body | `describe_function` |
| Read a trigger's body + what it's on | `describe_trigger` |
| Run your own read-only SQL | `run_query` |
