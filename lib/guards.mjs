// Pure, dependency-free safety-guard logic for run_query.
// Split out from mssql-server.mjs so it can be unit-tested without a
// SQL Server connection, a PowerShell worker, or the MCP SDK.
//
// Heuristic, not a parser: rejects anything with a semicolon before the
// end (so a stray ';DROP TABLE ...' after a SELECT gets refused), and
// requires the statement to start with SELECT/WITH with no mutating
// keyword outside a string literal. OPENROWSET/OPENQUERY/OPENDATASOURCE
// are blocked too: syntactically they're just SELECT, but they let a
// "read-only" query read arbitrary files (OPENROWSET BULK) or run
// anything on a linked server (OPENQUERY), defeating the read-only intent.

export const MAX_ROWS_DEFAULT = 200;
export const MAX_ROWS_CEILING = 2000;

const BLOCKED_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|EXEC|EXECUTE|TRUNCATE|MERGE|CREATE|GRANT|REVOKE|DENY|OPENROWSET|OPENQUERY|OPENDATASOURCE)\b/i;

// Blanks out single-quoted string literals (doubled '' escapes included)
// before keyword scanning, so a legitimate SELECT ... WHERE col = 'DELETE'
// isn't blocked just because a mutating word appears inside a value.
function stripStringLiterals(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

export function isSingleStatement(sql) {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  return !stripStringLiterals(trimmed).includes(';');
}

export function isReadOnly(sql) {
  const t = sql.trim();
  if (!/^(SELECT|WITH)\b/i.test(t)) return false;
  return !BLOCKED_KEYWORDS.test(stripStringLiterals(t));
}

export function assertReadOnly(sql) {
  if (!isSingleStatement(sql)) {
    throw new Error('Only a single SQL statement is allowed (found a semicolon before the end).');
  }
  if (!isReadOnly(sql)) {
    throw new Error('Only read-only SELECT/WITH statements are allowed through this tool.');
  }
}

export function clampMaxRows(n) {
  if (!n) return MAX_ROWS_DEFAULT;
  return Math.min(Math.max(1, n), MAX_ROWS_CEILING);
}
