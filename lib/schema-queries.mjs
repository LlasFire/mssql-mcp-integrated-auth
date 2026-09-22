// Pure SQL-text builders for schema discovery and inspection: tables,
// views, stored procedures, functions, triggers, and table constraints.
// Every builder here is a plain function (name/schema in, SQL string out)
// with no I/O, so they can be unit-tested without a SQL Server connection
// (see test/schema-queries.test.mjs) the same way lib/guards.mjs is.
//
// All identifiers/values that come from tool arguments go through
// sqlLiteral()/optionalEqualsClause() from ./sql-identifiers.mjs, never
// straight string interpolation, so a table or schema name containing a
// quote can't break out of the SQL text it's embedded in.
import { sqlLiteral, optionalEqualsClause } from './sql-identifiers.mjs';

// --- tables & views -------------------------------------------------------

// Base tables only (TABLE_TYPE = 'BASE TABLE'). INFORMATION_SCHEMA.TABLES
// on its own returns tables AND views mixed together with no visible
// distinction unless you select TABLE_TYPE, which is exactly the kind of
// ambiguity this tool should not have. Use buildListViewsSql for views.
export function buildListTablesSql(schema) {
  return `SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES ` +
    `WHERE TABLE_TYPE = 'BASE TABLE'${optionalEqualsClause('TABLE_SCHEMA', schema)} ` +
    `ORDER BY TABLE_SCHEMA, TABLE_NAME`;
}

export function buildListViewsSql(schema) {
  return `SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.VIEWS ` +
    `WHERE 1 = 1${optionalEqualsClause('TABLE_SCHEMA', schema)} ` +
    `ORDER BY TABLE_SCHEMA, TABLE_NAME`;
}

// --- stored procedures & functions ---------------------------------------

export function buildListStoredProceduresSql(schema) {
  return `SELECT ROUTINE_SCHEMA AS TABLE_SCHEMA, ROUTINE_NAME AS PROCEDURE_NAME ` +
    `FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_TYPE = 'PROCEDURE'${optionalEqualsClause('ROUTINE_SCHEMA', schema)} ` +
    `ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME`;
}

export function buildListFunctionsSql(schema) {
  return `SELECT ROUTINE_SCHEMA AS TABLE_SCHEMA, ROUTINE_NAME AS FUNCTION_NAME, DATA_TYPE AS RETURN_TYPE ` +
    `FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_TYPE = 'FUNCTION'${optionalEqualsClause('ROUTINE_SCHEMA', schema)} ` +
    `ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME`;
}

// Parameter lists are shared shape for procedures and functions:
// INFORMATION_SCHEMA.PARAMETERS keys off SPECIFIC_NAME/SPECIFIC_SCHEMA for
// both. For a scalar function this also returns one row with
// PARAMETER_NAME = NULL and ORDINAL_POSITION = 0 representing the return
// value itself, which is expected, not a bug.
export function buildDescribeParametersSql(name, schema) {
  return `SELECT PARAMETER_NAME, DATA_TYPE, PARAMETER_MODE, ORDINAL_POSITION ` +
    `FROM INFORMATION_SCHEMA.PARAMETERS ` +
    `WHERE SPECIFIC_NAME = ${sqlLiteral(name)}${optionalEqualsClause('SPECIFIC_SCHEMA', schema)} ` +
    `ORDER BY ORDINAL_POSITION`;
}

export function buildDescribeProcedureDefinitionSql(name, schema) {
  return `SELECT sm.definition AS DEFINITION, s.name AS TABLE_SCHEMA ` +
    `FROM sys.sql_modules sm ` +
    `JOIN sys.objects o ON sm.object_id = o.object_id ` +
    `JOIN sys.schemas s ON o.schema_id = s.schema_id ` +
    `WHERE o.type = 'P' AND o.name = ${sqlLiteral(name)}${optionalEqualsClause('s.name', schema)}`;
}

// o.type IN ('FN','IF','TF'): scalar, inline table-valued, and
// multi-statement table-valued functions respectively.
export function buildDescribeFunctionDefinitionSql(name, schema) {
  return `SELECT sm.definition AS DEFINITION, s.name AS TABLE_SCHEMA ` +
    `FROM sys.sql_modules sm ` +
    `JOIN sys.objects o ON sm.object_id = o.object_id ` +
    `JOIN sys.schemas s ON o.schema_id = s.schema_id ` +
    `WHERE o.type IN ('FN', 'IF', 'TF') AND o.name = ${sqlLiteral(name)}${optionalEqualsClause('s.name', schema)}`;
}

// --- triggers --------------------------------------------------------------

// parent_class = 1 restricts to DML triggers on tables/views, excluding
// database-level (parent_class = 0) triggers, which this tool does not
// cover.
export function buildListTriggersSql(table) {
  return `SELECT s.name AS TABLE_SCHEMA, t.name AS TABLE_NAME, tr.name AS TRIGGER_NAME, ` +
    `tr.is_disabled AS IS_DISABLED, tr.is_instead_of_trigger AS IS_INSTEAD_OF ` +
    `FROM sys.triggers tr ` +
    `JOIN sys.tables t ON tr.parent_id = t.object_id ` +
    `JOIN sys.schemas s ON t.schema_id = s.schema_id ` +
    `WHERE tr.parent_class = 1${optionalEqualsClause('t.name', table)} ` +
    `ORDER BY s.name, t.name, tr.name`;
}

export function buildDescribeTriggerSql(trigger) {
  return `SELECT sm.definition AS DEFINITION, tr.is_disabled AS IS_DISABLED, ` +
    `tr.is_instead_of_trigger AS IS_INSTEAD_OF, s.name AS TABLE_SCHEMA, t.name AS TABLE_NAME ` +
    `FROM sys.triggers tr ` +
    `JOIN sys.sql_modules sm ON tr.object_id = sm.object_id ` +
    `JOIN sys.tables t ON tr.parent_id = t.object_id ` +
    `JOIN sys.schemas s ON t.schema_id = s.schema_id ` +
    `WHERE tr.parent_class = 1 AND tr.name = ${sqlLiteral(trigger)}`;
}

// --- table columns & constraints -------------------------------------------

export function buildDescribeColumnsSql(table, schema) {
  return `SELECT TABLE_SCHEMA, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH ` +
    `FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ${sqlLiteral(table)}${optionalEqualsClause('TABLE_SCHEMA', schema)} ` +
    `ORDER BY ORDINAL_POSITION`;
}

export function buildDescribePrimaryKeySql(table, schema) {
  return `SELECT kcu.COLUMN_NAME ` +
    `FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ` +
    `JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ` +
    `ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA ` +
    `WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_NAME = ${sqlLiteral(table)}${optionalEqualsClause('tc.TABLE_SCHEMA', schema)} ` +
    `ORDER BY kcu.ORDINAL_POSITION`;
}

export function buildDescribeForeignKeysSql(table, schema) {
  return `SELECT fk.name AS CONSTRAINT_NAME, cpa.name AS COLUMN_NAME, ` +
    `refSchema.name AS REFERENCED_SCHEMA, refTable.name AS REFERENCED_TABLE, refCol.name AS REFERENCED_COLUMN ` +
    `FROM sys.foreign_keys fk ` +
    `JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id ` +
    `JOIN sys.columns cpa ON fkc.parent_object_id = cpa.object_id AND fkc.parent_column_id = cpa.column_id ` +
    `JOIN sys.tables parentTable ON fk.parent_object_id = parentTable.object_id ` +
    `JOIN sys.schemas parentSchema ON parentTable.schema_id = parentSchema.schema_id ` +
    `JOIN sys.tables refTable ON fk.referenced_object_id = refTable.object_id ` +
    `JOIN sys.schemas refSchema ON refTable.schema_id = refSchema.schema_id ` +
    `JOIN sys.columns refCol ON fkc.referenced_object_id = refCol.object_id AND fkc.referenced_column_id = refCol.column_id ` +
    `WHERE parentTable.name = ${sqlLiteral(table)}${optionalEqualsClause('parentSchema.name', schema)}`;
}

export function buildDescribeUniqueConstraintsSql(table, schema) {
  return `SELECT tc.CONSTRAINT_NAME, kcu.COLUMN_NAME ` +
    `FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ` +
    `JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA ` +
    `WHERE tc.CONSTRAINT_TYPE = 'UNIQUE' AND tc.TABLE_NAME = ${sqlLiteral(table)}${optionalEqualsClause('tc.TABLE_SCHEMA', schema)} ` +
    `ORDER BY tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`;
}

export function buildDescribeCheckConstraintsSql(table, schema) {
  return `SELECT cc.CONSTRAINT_NAME, cc.CHECK_CLAUSE ` +
    `FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc ` +
    `JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ON cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND cc.CONSTRAINT_SCHEMA = tc.TABLE_SCHEMA ` +
    `WHERE tc.TABLE_NAME = ${sqlLiteral(table)}${optionalEqualsClause('tc.TABLE_SCHEMA', schema)}`;
}
