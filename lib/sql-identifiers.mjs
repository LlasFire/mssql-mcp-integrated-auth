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

// A database name is never embedded in SQL text (sqlLiteral/optionalEqualsClause
// don't apply to it) - it goes straight into the connection string worker.ps1
// builds for SqlConnection (Server=...;Database=<value>;...). A value like
// "master;Server=attacker,1433" there overrides the Server= key and redirects
// the whole Windows-integrated auth handshake to an attacker-chosen host, so
// it must be restricted to a plain identifier instead of escaped.
const SAFE_IDENTIFIER = /^[A-Za-z0-9_$#@]+$/;

export function assertSafeIdentifier(value, label) {
  if (value !== undefined && value !== null && !SAFE_IDENTIFIER.test(value)) {
    throw new Error(`Invalid ${label} '${value}': must contain only letters, digits, or _ $ # @`);
  }
}

// Wraps a value as a bracket-quoted SQL Server identifier, e.g.
// bracketIdentifier("My]Proc") -> "[My]]Proc]". Unlike sqlLiteral (a string
// *compared against* a column in a WHERE clause), this is for a name used
// as the actual callable/object being referenced - e.g. EXEC <name> - where
// a quoted literal isn't valid syntax; SQL Server's own doubled-bracket
// escaping is the correct way to neutralize a stray ']' or reserved word.
export function bracketIdentifier(value) {
  if (typeof value !== 'string') {
    throw new TypeError(`bracketIdentifier expects a string, got ${typeof value}`);
  }
  return `[${value.replace(/]/g, ']]')}]`;
}

// Renders a parameter value for a T-SQL "@name = <value>" argument. Strings
// go through sqlLiteral(); numbers/booleans/null are safe as bare text since
// they can't contain a quote or semicolon to begin with.
export function sqlValueLiteral(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`sqlValueLiteral expects a finite number, got ${value}`);
    }
    return String(value);
  }
  if (typeof value === 'string') return sqlLiteral(value);
  throw new TypeError(`sqlValueLiteral expects a string, number, boolean, or null, got ${typeof value}`);
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
