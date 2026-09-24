import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExecProcedureSql, buildTvpMetadataSql, groupTvpMetadata } from '../lib/procedure-exec.mjs';

test('buildExecProcedureSql: no schema, no params', () => {
  assert.equal(buildExecProcedureSql('RefreshCache', undefined, undefined), 'EXEC [RefreshCache]');
});

test('buildExecProcedureSql: with schema, no params', () => {
  assert.equal(buildExecProcedureSql('RefreshCache', 'dbo', undefined), 'EXEC [dbo].[RefreshCache]');
});

test('buildExecProcedureSql: with params, in insertion order', () => {
  assert.equal(
    buildExecProcedureSql('GetOrder', 'dbo', { OrderId: 42, IncludeLines: true }),
    "EXEC [dbo].[GetOrder] @OrderId = 42, @IncludeLines = 1"
  );
});

test('buildExecProcedureSql: string parameter is quoted and escaped', () => {
  assert.equal(
    buildExecProcedureSql('FindCustomer', 'dbo', { Name: "O'Brien" }),
    "EXEC [dbo].[FindCustomer] @Name = 'O''Brien'"
  );
});

test('buildExecProcedureSql: null parameter renders as NULL, not the string "null"', () => {
  assert.equal(
    buildExecProcedureSql('SetNote', 'dbo', { Note: null }),
    'EXEC [dbo].[SetNote] @Note = NULL'
  );
});

test('buildExecProcedureSql: empty params object behaves like no params', () => {
  assert.equal(buildExecProcedureSql('RefreshCache', 'dbo', {}), 'EXEC [dbo].[RefreshCache]');
});

test('buildExecProcedureSql: a bracket in the procedure name is doubled, not left to close early', () => {
  assert.equal(buildExecProcedureSql('Weird]Proc', 'dbo', undefined), 'EXEC [dbo].[Weird]]Proc]');
});

test('buildExecProcedureSql: a bracket in the schema name is doubled too', () => {
  assert.equal(buildExecProcedureSql('Proc', 'my]schema', undefined), 'EXEC [my]]schema].[Proc]');
});

test('buildExecProcedureSql: an unsafe parameter name is rejected, not interpolated raw', () => {
  // If this were allowed through, "x = 1; DROP TABLE t --" as a param *name*
  // would let the value's own quoting be sidestepped entirely.
  assert.throws(() => buildExecProcedureSql('Proc', 'dbo', { 'x; DROP TABLE t --': 1 }));
});

// --- table-valued parameters ------------------------------------------------
// This is the reported real-world case: @GROUP_NAMES AUTHZ.STRING250, a
// single-column table type, was being passed as a plain string/scalar and
// failing with "Operand type clash: varchar is incompatible with STRING250".

const groupNamesMeta = { '@GROUP_NAMES': { typeSchema: 'AUTHZ', typeName: 'STRING250', columns: ['Value'] } };

test('buildExecProcedureSql: a single-column TVP declares, inserts, and passes the variable', () => {
  const sql = buildExecProcedureSql('GetUsersInGroups', 'dbo', { GROUP_NAMES: ['Admins', 'Users'] }, groupNamesMeta);
  assert.equal(
    sql,
    'DECLARE @GROUP_NAMES [AUTHZ].[STRING250];\n' +
    "INSERT INTO @GROUP_NAMES ([Value]) VALUES ('Admins'), ('Users');\n" +
    'EXEC [dbo].[GetUsersInGroups] @GROUP_NAMES = @GROUP_NAMES'
  );
});

test('buildExecProcedureSql: an empty TVP array still declares the variable, with no INSERT', () => {
  const sql = buildExecProcedureSql('GetUsersInGroups', 'dbo', { GROUP_NAMES: [] }, groupNamesMeta);
  assert.equal(
    sql,
    'DECLARE @GROUP_NAMES [AUTHZ].[STRING250];\n' +
    'EXEC [dbo].[GetUsersInGroups] @GROUP_NAMES = @GROUP_NAMES'
  );
});

test('buildExecProcedureSql: a TVP alongside a scalar parameter', () => {
  const sql = buildExecProcedureSql('GetUsersInGroups', 'dbo', { IncludeInactive: true, GROUP_NAMES: ['Admins'] }, groupNamesMeta);
  assert.equal(
    sql,
    'DECLARE @GROUP_NAMES [AUTHZ].[STRING250];\n' +
    "INSERT INTO @GROUP_NAMES ([Value]) VALUES ('Admins');\n" +
    'EXEC [dbo].[GetUsersInGroups] @IncludeInactive = 1, @GROUP_NAMES = @GROUP_NAMES'
  );
});

test('buildExecProcedureSql: a multi-column TVP takes rows keyed by column name', () => {
  const meta = { '@Items': { typeSchema: 'dbo', typeName: 'ItemList', columns: ['Sku', 'Qty'] } };
  const sql = buildExecProcedureSql('AddItems', 'dbo', { Items: [{ Sku: 'A1', Qty: 3 }, { Sku: 'B2', Qty: 1 }] }, meta);
  assert.equal(
    sql,
    'DECLARE @Items [dbo].[ItemList];\n' +
    "INSERT INTO @Items ([Sku], [Qty]) VALUES ('A1', 3), ('B2', 1);\n" +
    'EXEC [dbo].[AddItems] @Items = @Items'
  );
});

test('buildExecProcedureSql: a plain scalar row against a multi-column type is rejected', () => {
  const meta = { '@Items': { typeSchema: 'dbo', typeName: 'ItemList', columns: ['Sku', 'Qty'] } };
  assert.throws(() => buildExecProcedureSql('AddItems', 'dbo', { Items: ['A1'] }, meta));
});

test('buildExecProcedureSql: a row object missing a required column is rejected', () => {
  const meta = { '@Items': { typeSchema: 'dbo', typeName: 'ItemList', columns: ['Sku', 'Qty'] } };
  assert.throws(() => buildExecProcedureSql('AddItems', 'dbo', { Items: [{ Sku: 'A1' }] }, meta));
});

test('buildExecProcedureSql: an array parameter with no matching TVP metadata is rejected', () => {
  assert.throws(() => buildExecProcedureSql('GetUsersInGroups', 'dbo', { GROUP_NAMES: ['Admins'] }, {}));
});

test('buildTvpMetadataSql: embeds the procedure name and optional schema, escaped', () => {
  const sql = buildTvpMetadataSql("Weird'Proc", "my'schema");
  assert.match(sql, /o\.name = 'Weird''Proc'/);
  assert.match(sql, /AND os\.name = 'my''schema'/);
});

test('buildTvpMetadataSql: with no schema, has no schema filter', () => {
  const sql = buildTvpMetadataSql('GetUsersInGroups', undefined);
  assert.doesNotMatch(sql, /os\.name/);
});

test('groupTvpMetadata: groups flat rows by parameter, preserving column order', () => {
  const rows = [
    { PARAMETER_NAME: '@GROUP_NAMES', TYPE_SCHEMA: 'AUTHZ', TYPE_NAME: 'STRING250', COLUMN_NAME: 'Value' },
    { PARAMETER_NAME: '@Items', TYPE_SCHEMA: 'dbo', TYPE_NAME: 'ItemList', COLUMN_NAME: 'Sku' },
    { PARAMETER_NAME: '@Items', TYPE_SCHEMA: 'dbo', TYPE_NAME: 'ItemList', COLUMN_NAME: 'Qty' },
  ];
  assert.deepEqual(groupTvpMetadata(rows), {
    '@GROUP_NAMES': { typeSchema: 'AUTHZ', typeName: 'STRING250', columns: ['Value'] },
    '@Items': { typeSchema: 'dbo', typeName: 'ItemList', columns: ['Sku', 'Qty'] },
  });
});

test('groupTvpMetadata: no rows means no table-valued parameters', () => {
  assert.deepEqual(groupTvpMetadata([]), {});
});
