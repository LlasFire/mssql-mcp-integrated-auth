import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildListTablesSql,
  buildListViewsSql,
  buildListStoredProceduresSql,
  buildListFunctionsSql,
  buildListTriggersSql,
  buildDescribeParametersSql,
  buildDescribeProcedureDefinitionSql,
  buildDescribeFunctionDefinitionSql,
  buildDescribeTriggerSql,
  buildDescribeColumnsSql,
  buildDescribePrimaryKeySql,
  buildDescribeForeignKeysSql,
  buildDescribeUniqueConstraintsSql,
  buildDescribeCheckConstraintsSql,
} from '../lib/schema-queries.mjs';

// --- tables & views: the ambiguity fix ----------------------------------------

test('buildListTablesSql: restricts to BASE TABLE, so views are excluded', () => {
  assert.match(buildListTablesSql(undefined), /TABLE_TYPE = 'BASE TABLE'/);
  assert.doesNotMatch(buildListTablesSql(undefined), /INFORMATION_SCHEMA\.VIEWS/);
});

test('buildListTablesSql: with no schema, has no schema filter', () => {
  assert.doesNotMatch(buildListTablesSql(undefined), /AND TABLE_SCHEMA/);
});

test('buildListTablesSql: with a schema, filters to it', () => {
  assert.match(buildListTablesSql('dbo'), /AND TABLE_SCHEMA = 'dbo'/);
});

test('buildListViewsSql: queries INFORMATION_SCHEMA.VIEWS, not TABLES', () => {
  assert.match(buildListViewsSql(undefined), /INFORMATION_SCHEMA\.VIEWS/);
});

test('buildListViewsSql: a schema name with a quote is escaped, not left raw', () => {
  const sql = buildListViewsSql("weird'schema");
  assert.match(sql, /TABLE_SCHEMA = 'weird''schema'/);
  // The raw, unescaped value must never appear in the generated SQL.
  assert.doesNotMatch(sql, /TABLE_SCHEMA = 'weird'schema'/);
});

// --- routines --------------------------------------------------------------

test('buildListStoredProceduresSql: filters ROUTINE_TYPE to PROCEDURE', () => {
  assert.match(buildListStoredProceduresSql(undefined), /ROUTINE_TYPE = 'PROCEDURE'/);
});

test('buildListFunctionsSql: filters ROUTINE_TYPE to FUNCTION and selects a return type', () => {
  const sql = buildListFunctionsSql(undefined);
  assert.match(sql, /ROUTINE_TYPE = 'FUNCTION'/);
  assert.match(sql, /RETURN_TYPE/);
});

test('buildDescribeParametersSql: a procedure name with a quote is escaped', () => {
  const sql = buildDescribeParametersSql("sp_it's_broken", undefined);
  assert.match(sql, /SPECIFIC_NAME = 'sp_it''s_broken'/);
});

test('buildDescribeProcedureDefinitionSql: restricts object type to P (procedures only)', () => {
  assert.match(buildDescribeProcedureDefinitionSql('GetThing', undefined), /o\.type = 'P'/);
});

test('buildDescribeFunctionDefinitionSql: restricts object type to FN/IF/TF (functions only)', () => {
  assert.match(buildDescribeFunctionDefinitionSql('GetThing', undefined), /o\.type IN \('FN', 'IF', 'TF'\)/);
});

// --- triggers ----------------------------------------------------------------

test('buildListTriggersSql: restricts to parent_class = 1 (table triggers only)', () => {
  assert.match(buildListTriggersSql(undefined), /tr\.parent_class = 1/);
});

test('buildListTriggersSql: with a table filter, escapes it', () => {
  const sql = buildListTriggersSql("Orders'; DROP TABLE Orders; --");
  assert.match(sql, /t\.name = 'Orders''; DROP TABLE Orders; --'/);
});

test('buildDescribeTriggerSql: also restricts to parent_class = 1', () => {
  assert.match(buildDescribeTriggerSql('trg_Audit'), /tr\.parent_class = 1/);
});

// --- table columns & constraints ----------------------------------------------

test('buildDescribeColumnsSql: filters by table name, escaped', () => {
  const sql = buildDescribeColumnsSql("Notes' OR '1'='1", undefined);
  assert.match(sql, /TABLE_NAME = 'Notes'' OR ''1''=''1'/);
});

test('buildDescribeColumnsSql: with a schema, adds the schema filter', () => {
  assert.match(buildDescribeColumnsSql('Configuration', 'dbo'), /AND TABLE_SCHEMA = 'dbo'/);
});

test('buildDescribePrimaryKeySql: filters CONSTRAINT_TYPE to PRIMARY KEY', () => {
  assert.match(buildDescribePrimaryKeySql('Configuration', undefined), /CONSTRAINT_TYPE = 'PRIMARY KEY'/);
});

test('buildDescribeUniqueConstraintsSql: filters CONSTRAINT_TYPE to UNIQUE', () => {
  assert.match(buildDescribeUniqueConstraintsSql('Configuration', undefined), /CONSTRAINT_TYPE = 'UNIQUE'/);
});

test('buildDescribeForeignKeysSql: joins through to the referenced table/column', () => {
  const sql = buildDescribeForeignKeysSql('Orders', 'dbo');
  assert.match(sql, /REFERENCED_SCHEMA/);
  assert.match(sql, /REFERENCED_TABLE/);
  assert.match(sql, /REFERENCED_COLUMN/);
  assert.match(sql, /parentSchema\.name = 'dbo'/);
});

test('buildDescribeCheckConstraintsSql: selects the CHECK_CLAUSE text', () => {
  assert.match(buildDescribeCheckConstraintsSql('Configuration', undefined), /CHECK_CLAUSE/);
});
