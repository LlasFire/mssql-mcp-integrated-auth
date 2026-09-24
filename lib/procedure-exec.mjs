// Pure SQL-text builders for execute_procedure. Kept separate from
// schema-queries.mjs because it builds an EXEC call, not a metadata SELECT:
// name/schema are embedded as identifiers (bracketIdentifier), not as
// WHERE-clause literals, and parameter values need type-aware rendering
// (sqlValueLiteral), not just string escaping.
import { bracketIdentifier, sqlValueLiteral, sqlLiteral, optionalEqualsClause, assertSafeIdentifier } from './sql-identifiers.mjs';

// A table-valued parameter (e.g. `@GROUP_NAMES AUTHZ.STRING250`) can't be
// passed as a literal the way a scalar can - T-SQL has no TVP literal
// syntax in a textual EXEC call. It has to be built up as a table variable
// first: DECLARE it as the parameter's real table type, INSERT the rows,
// then pass the variable by name. That means execute_procedure needs to
// know the parameter's real schema-qualified type name and column list
// before it can build anything, which buildTvpMetadataSql looks up from
// SQL Server's own catalog views rather than asking the caller to know it.
export function buildTvpMetadataSql(name, schema) {
  return `SELECT p.name AS PARAMETER_NAME, ts.name AS TYPE_SCHEMA, tt.name AS TYPE_NAME, ` +
    `c.name AS COLUMN_NAME ` +
    `FROM sys.parameters p ` +
    `JOIN sys.objects o ON p.object_id = o.object_id ` +
    `JOIN sys.schemas os ON o.schema_id = os.schema_id ` +
    `JOIN sys.table_types tt ON p.user_type_id = tt.user_type_id ` +
    `JOIN sys.schemas ts ON tt.schema_id = ts.schema_id ` +
    `JOIN sys.columns c ON c.object_id = tt.type_table_object_id ` +
    `WHERE o.type = 'P' AND o.name = ${sqlLiteral(name)}${optionalEqualsClause('os.name', schema)} ` +
    `ORDER BY p.parameter_id, c.column_id`;
}

// Groups buildTvpMetadataSql's flat rows into { '@ParamName': { typeSchema,
// typeName, columns: [...] } }, one entry per table-valued parameter the
// procedure actually has. Column order is whatever order the rows arrived
// in (the query above already orders by c.column_id), not re-sorted here.
export function groupTvpMetadata(rows) {
  const meta = {};
  for (const row of rows) {
    const key = row.PARAMETER_NAME;
    if (!meta[key]) meta[key] = { typeSchema: row.TYPE_SCHEMA, typeName: row.TYPE_NAME, columns: [] };
    meta[key].columns.push(row.COLUMN_NAME);
  }
  return meta;
}

// Renders one TVP row as "(v1, v2, ...)" in column order. A plain scalar
// row (not an object) is only valid for a single-column type - e.g.
// GROUP_NAMES: ['Admins', 'Users'] for a type with one column - since
// there's no column name to key it by otherwise.
function buildTvpRowSql(row, columns) {
  if (row !== null && typeof row === 'object') {
    const values = columns.map((col) => {
      if (!(col in row)) {
        throw new Error(`Table-valued parameter row is missing column '${col}' (expected: ${columns.join(', ')}).`);
      }
      return sqlValueLiteral(row[col]);
    });
    return `(${values.join(', ')})`;
  }
  if (columns.length !== 1) {
    throw new Error(
      `A table-valued parameter row must be an object keyed by column name (expected: ${columns.join(', ')}), ` +
      `not a plain value, because this type has ${columns.length} columns.`
    );
  }
  return `(${sqlValueLiteral(row)})`;
}

// Builds the full EXEC batch: "EXEC [schema].[name] @p1 = 'a', @p2 = 2" for
// scalar-only params, or a multi-statement batch of DECLARE/INSERT
// statements (one per table-valued parameter) followed by the EXEC when
// any parameter value is an array. `tvpMeta` is the shape groupTvpMetadata
// returns, and must have an entry for every parameter passed as an array -
// the caller (mssql-server.mjs) is expected to have looked it up first via
// buildTvpMetadataSql, since this function stays pure/DB-free.
//
// Only input parameters are supported - there is no way to get an OUTPUT
// parameter's value back through this textual call, and only the
// procedure's first result set is captured (the worker never calls
// SqlDataReader.NextResult()).
export function buildExecProcedureSql(name, schema, params, tvpMeta = {}) {
  const qualifiedName = schema
    ? `${bracketIdentifier(schema)}.${bracketIdentifier(name)}`
    : bracketIdentifier(name);
  const entries = Object.entries(params || {});
  const declares = [];
  const inserts = [];
  const execArgs = entries.map(([paramName, value]) => {
    assertSafeIdentifier(paramName, 'parameter name');
    if (!Array.isArray(value)) {
      return `@${paramName} = ${sqlValueLiteral(value)}`;
    }
    const meta = tvpMeta[`@${paramName}`];
    if (!meta) {
      throw new Error(`No table-valued parameter '@${paramName}' found on '${name}'; can't determine its type.`);
    }
    const typeRef = `${bracketIdentifier(meta.typeSchema)}.${bracketIdentifier(meta.typeName)}`;
    declares.push(`DECLARE @${paramName} ${typeRef};`);
    if (value.length > 0) {
      const columnList = meta.columns.map(bracketIdentifier).join(', ');
      const rows = value.map((row) => buildTvpRowSql(row, meta.columns));
      inserts.push(`INSERT INTO @${paramName} (${columnList}) VALUES ${rows.join(', ')};`);
    }
    return `@${paramName} = @${paramName}`;
  });
  const execStatement = execArgs.length ? `EXEC ${qualifiedName} ${execArgs.join(', ')}` : `EXEC ${qualifiedName}`;
  return [...declares, ...inserts, execStatement].join('\n');
}
