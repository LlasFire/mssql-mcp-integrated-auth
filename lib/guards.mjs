// Pure, dependency-free safety-guard logic for run_query.
// Split out from mssql-server.mjs so it can be unit-tested without a
// SQL Server connection, a PowerShell worker, or the MCP SDK.
//
// Heuristic, not a parser: rejects anything with a semicolon before the
// end (so a stray ';DROP TABLE ...' after a SELECT gets refused), and
// requires the statement to start with SELECT/WITH with no mutating
// keyword anywhere. This favors over-rejecting a legitimate query over
// under-blocking a write. See README "Safety" section for the documented
// false-positive case (a mutating keyword inside a string literal).

export const MAX_ROWS_DEFAULT = 200;
export const MAX_ROWS_CEILING = 2000;

export function isSingleStatement(sql) {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  return !trimmed.includes(';');
}

export function isReadOnly(sql) {
  const t = sql.trim();
  return (
    /^(SELECT|WITH)\b/i.test(t) &&
    !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|EXEC|EXECUTE|TRUNCATE|MERGE|CREATE|GRANT|REVOKE|DENY)\b/i.test(t)
  );
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
