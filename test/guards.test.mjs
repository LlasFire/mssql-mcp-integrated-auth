import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSingleStatement,
  isReadOnly,
  assertReadOnly,
  clampMaxRows,
  MAX_ROWS_DEFAULT,
  MAX_ROWS_CEILING,
} from '../lib/guards.mjs';

test('isSingleStatement: plain SELECT has no semicolon', () => {
  assert.equal(isSingleStatement('SELECT 1'), true);
});

test('isSingleStatement: single trailing semicolon is fine', () => {
  assert.equal(isSingleStatement('SELECT 1;'), true);
});

test('isSingleStatement: semicolon before the end is rejected', () => {
  assert.equal(isSingleStatement('SELECT 1; DROP TABLE Foo'), false);
});

test('isReadOnly: SELECT is read-only', () => {
  assert.equal(isReadOnly('SELECT * FROM Configuration'), true);
});

test('isReadOnly: WITH (CTE) is read-only', () => {
  assert.equal(isReadOnly('WITH cte AS (SELECT 1 AS x) SELECT * FROM cte'), true);
});

test('isReadOnly: DELETE is rejected', () => {
  assert.equal(isReadOnly('DELETE FROM Configuration WHERE KeyName = \'x\''), false);
});

test('isReadOnly: bare mutating statement with no SELECT/WITH prefix is rejected', () => {
  assert.equal(isReadOnly('UPDATE Configuration SET Value = 1'), false);
});

test('isReadOnly: word-boundary check does not flag a keyword as a substring', () => {
  // "dropped" contains "drop" but not as a whole word, so the \bDROP\b
  // check correctly leaves this alone.
  assert.equal(isReadOnly("SELECT * FROM Notes WHERE Body LIKE '%dropped%'"), true);
});

test('isReadOnly: mutating keyword as a whole word inside a string literal is not a false positive', () => {
  // "delete" is a whole word here, but it's inside a string literal, not a
  // real DELETE statement. stripStringLiterals() blanks the literal out
  // before the keyword scan, so this no longer gets rejected.
  assert.equal(isReadOnly("SELECT * FROM Notes WHERE Body LIKE '%please delete this%'"), true);
});

test('isSingleStatement: a semicolon inside a string literal is not a false positive', () => {
  assert.equal(isSingleStatement("SELECT * FROM Notes WHERE Body = 'a;b'"), true);
});

test('isReadOnly: OPENROWSET is rejected even though it is syntactically a SELECT', () => {
  assert.equal(isReadOnly("SELECT * FROM OPENROWSET(BULK 'C:\\secret.txt', SINGLE_CLOB) AS x"), false);
});

test('isReadOnly: OPENQUERY is rejected even though it is syntactically a SELECT', () => {
  assert.equal(isReadOnly("SELECT * FROM OPENQUERY(LinkedServer, 'SELECT 1')"), false);
});

test('isReadOnly: OPENDATASOURCE is rejected even though it is syntactically a SELECT', () => {
  assert.equal(isReadOnly("SELECT * FROM OPENDATASOURCE('SQLNCLI', 'Server=x;').db.dbo.t"), false);
});

test('assertReadOnly: allows a plain SELECT', () => {
  assert.doesNotThrow(() => assertReadOnly('SELECT TOP 1 * FROM Configuration'));
});

test('assertReadOnly: allows a SELECT with one trailing semicolon', () => {
  assert.doesNotThrow(() => assertReadOnly('SELECT TOP 1 * FROM Configuration;'));
});

test('assertReadOnly: rejects a batched second statement', () => {
  assert.throws(
    () => assertReadOnly("SELECT 1; DROP TABLE Configuration"),
    /single SQL statement/
  );
});

test('assertReadOnly: rejects DELETE', () => {
  assert.throws(
    () => assertReadOnly("DELETE FROM Configuration WHERE KeyName = 'DynamiteVersion'"),
    /read-only/
  );
});

test('clampMaxRows: falsy input falls back to the default', () => {
  assert.equal(clampMaxRows(undefined), MAX_ROWS_DEFAULT);
  assert.equal(clampMaxRows(0), MAX_ROWS_DEFAULT);
  assert.equal(clampMaxRows(null), MAX_ROWS_DEFAULT);
});

test('clampMaxRows: values within range pass through unchanged', () => {
  assert.equal(clampMaxRows(50), 50);
});

test('clampMaxRows: negative or zero-ish values floor at 1', () => {
  assert.equal(clampMaxRows(-5), 1);
});

test('clampMaxRows: values above the ceiling get clamped down', () => {
  assert.equal(clampMaxRows(999999), MAX_ROWS_CEILING);
});

test('clampMaxRows: the ceiling itself passes through unchanged', () => {
  assert.equal(clampMaxRows(MAX_ROWS_CEILING), MAX_ROWS_CEILING);
});
