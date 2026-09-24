---
name: mssql-mcp-integrated-auth
description: "Guides Claude through using the mssql-mcp-integrated-auth MCP server (tools: list_environments, list_databases, list_tables, list_views, list_stored_procedures, list_functions, list_triggers, describe_table, describe_procedure, describe_function, describe_trigger, run_query, execute_procedure) to explore, query, and run stored procedures against SQL Server across multiple named environments over Windows-integrated auth. Covers the right discovery order, how to compare a value across environments, how to read the errors this server produces, its read-only safety rules, and the one tool (execute_procedure) that isn't read-only. Use this whenever the person asks to look up, inspect, compare, query, or run/execute anything in a SQL Server database, table, view, stored procedure, function, or trigger across named environments (dev/qa/prod or similar), even if they don't name the MCP tool directly. Also use it if a query or procedure call against one of these environments fails and needs troubleshooting, or if the person asks what environments/databases/tables are available."
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
   shape of things. Or **`execute_procedure`** if what you actually need is
   to run a stored procedure rather than query data — see "Executing a
   stored procedure" below before reaching for it.

If the person already told you the exact table/column names in their
message, you can skip straight to `run_query` — the point is not to
mechanically call every tool every time, it's to never fabricate a name
you haven't confirmed exists.

## Executing a stored procedure

`execute_procedure` is the one tool in this server that is **not
read-only** — it runs the procedure with whatever permissions the Windows
account has in that environment, and can write data if the procedure's
body does. Treat calling it with the same care you'd give any other
write-capable action, not like `run_query`.

- Always call `describe_procedure` first to read what the procedure
  actually does and what parameters it takes, unless the person has
  already told you exactly what to call and with what arguments.
- Pass parameters as a plain object, e.g. `{ "OrderId": 42, "Note": null }`.
  Only input parameters are supported — there's no way to get an `OUTPUT`
  parameter's value back through this tool — and only the procedure's
  first result set comes back if it produces more than one.
- **If a parameter's real type is a table type** (a table-valued parameter,
  e.g. `@GROUP_NAMES AUTHZ.STRING250` — `describe_procedure`'s parameter
  list will show this, and a plain scalar value fails with something like
  `Operand type clash: varchar is incompatible with STRING250`), pass an
  array instead of a plain value: `{ "GROUP_NAMES": ["Admins", "Users"] }`
  for a single-column table type, or an array of objects keyed by column
  name (e.g. `{ "Items": [{ "Sku": "A1", "Qty": 3 }] }`) for a multi-column
  one. You don't need to look up the type's real schema-qualified name
  yourself — the tool resolves it from the procedure's own metadata. If the
  parameter name you used doesn't match an actual table-valued parameter,
  the error says so.
- **If the call fails with an EXECUTE-permission error**, the error message
  says so explicitly. Don't retry, don't try to work around it by editing
  permissions yourself. Instead, *propose* to the person: read the
  procedure with `describe_procedure`, and if they still want the same
  outcome, offer to rewrite its logic as a plain `SELECT` with their
  parameter values substituted in and run that via `run_query` — but only
  if the procedure is read-only logic, only if the account has `SELECT` on
  the underlying tables, and only after the person confirms. This is a
  proposal for them to accept or decline, not something to do silently:
  your hand-rewritten query is not guaranteed to reproduce the procedure's
  real logic exactly.

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
  Server, and so are `OPENROWSET`/`OPENQUERY`/`OPENDATASOURCE` (they're
  syntactically a `SELECT` but can read arbitrary files or hit a linked
  server). Don't suggest disabling or loosening this check to get a query
  through; if someone genuinely needs write access via `run_query`, that's
  a deliberate decision for them to make by editing `lib/guards.mjs`
  themselves, not something to route around in a single session.
  `execute_procedure` is the deliberate, already-built exception to "this
  server is read-only" — see "Executing a stored procedure" above; don't
  treat that as license to loosen `run_query` too.
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
- **`execute_procedure` fails with `Operand type clash: varchar is
  incompatible with <TypeName>`** (or similar) — you passed a plain scalar
  for a parameter whose real type is a table type. Check the parameter's
  type via `describe_procedure`, then pass an array instead (see "Executing
  a stored procedure" above), not a rephrased scalar value.
- **`execute_procedure` fails with an EXECUTE-permission error** — see
  "Executing a stored procedure" above: propose the `describe_procedure` +
  hand-rewritten `run_query` fallback, don't just report the failure and
  stop, but also don't do the rewrite without the person confirming it.
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
| Run a stored procedure (not read-only) | `execute_procedure` |
