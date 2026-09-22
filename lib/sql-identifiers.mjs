// Safe embedding of user-supplied values into ad hoc SQL text.
//
// This codebase builds every query by string interpolation: the PowerShell
// worker executes a full T-SQL batch by text (worker.ps1's Invoke-Req sets
// $cmd.CommandText = $req.sql directly), it does not support real bound
// parameters. That means every value that reaches a query built from a
// tool argument (a schema name, table name, procedure name, ...) MUST go
// through sqlLiteral() before being interpolated into SQL text. This file
// is the single place that does that escaping, so there is exactly one
// thing to get right, and one thing to unit-test (see
// test/sql-identifiers.test.mjs), instead of a `.replace(/'/g, "''")` call
// copy-pasted into every tool handler.

export function escapeSqlLiteral(value) {
  if (typeof value !== 'string') {
    throw new TypeError(`escapeSqlLiteral expects a string, got ${typeof value}`);
  }
  return value.replace(/'/g, "''");
}

// Wraps a value as a single-quoted SQL string literal, e.g. sqlLiteral("O'Brien") -> "'O''Brien'".
export function sqlLiteral(value) {
  return `'${escapeSqlLiteral(value)}'`;
}

// Builds " AND <column> = '<value>'" for an optional WHERE-clause filter
// (a schema/table/name argument the caller may or may not have supplied),
// or '' when value is falsy/omitted so the clause simply disappears.
// `column` is never user-supplied (it's always a literal column name from
// the query builder that calls this), so only `value` needs escaping.
export function optionalEqualsClause(column, value) {
  if (!value) return '';
  return ` AND ${column} = ${sqlLiteral(value)}`;
}
