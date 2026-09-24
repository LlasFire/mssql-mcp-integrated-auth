import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeSqlLiteral,
  sqlLiteral,
  optionalEqualsClause,
  assertSafeIdentifier,
  bracketIdentifier,
  sqlValueLiteral,
} from '../lib/sql-identifiers.mjs';

// --- escapeSqlLiteral -------------------------------------------------------

test('escapeSqlLiteral: plain string passes through unchanged', () => {
  assert.equal(escapeSqlLiteral('Configuration'), 'Configuration');
});

test('escapeSqlLiteral: a single embedded quote gets doubled', () => {
  assert.equal(escapeSqlLiteral("O'Brien"), "O''Brien");
});

test('escapeSqlLiteral: multiple quotes all get doubled', () => {
  assert.equal(escapeSqlLiteral("a'b'c"), "a''b''c");
});

test('escapeSqlLiteral: empty string is fine', () => {
  assert.equal(escapeSqlLiteral(''), '');
});

test('escapeSqlLiteral: rejects non-string input (number)', () => {
  assert.throws(() => escapeSqlLiteral(42), TypeError);
});

test('escapeSqlLiteral: rejects non-string input (null)', () => {
  assert.throws(() => escapeSqlLiteral(null), TypeError);
});

test('escapeSqlLiteral: rejects non-string input (undefined)', () => {
  assert.throws(() => escapeSqlLiteral(undefined), TypeError);
});

test('escapeSqlLiteral: rejects non-string input (object)', () => {
  assert.throws(() => escapeSqlLiteral({ toString: () => "x' OR 1=1" }), TypeError);
});

// --- sqlLiteral --------------------------------------------------------------

test('sqlLiteral: wraps a plain value in single quotes', () => {
  assert.equal(sqlLiteral('dbo'), "'dbo'");
});

test('sqlLiteral: escapes an embedded quote before wrapping', () => {
  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'");
});

test('sqlLiteral: a classic injection attempt is neutralized into one inert literal', () => {
  // If this were interpolated unescaped, `'; DROP TABLE Users; --` would
  // close the string early and append a second statement. Escaped, the
  // embedded quote is doubled, so the whole thing stays one literal value
  // with no way to break out of the surrounding SQL text.
  const input = "x'; DROP TABLE Users; --";
  assert.equal(sqlLiteral(input), "'x''; DROP TABLE Users; --'");
});

// --- optionalEqualsClause -----------------------------------------------------

test('optionalEqualsClause: undefined value produces no clause', () => {
  assert.equal(optionalEqualsClause('TABLE_SCHEMA', undefined), '');
});

test('optionalEqualsClause: empty string value produces no clause', () => {
  assert.equal(optionalEqualsClause('TABLE_SCHEMA', ''), '');
});

test('optionalEqualsClause: a normal value produces " AND column = \'value\'"', () => {
  assert.equal(optionalEqualsClause('TABLE_SCHEMA', 'dbo'), " AND TABLE_SCHEMA = 'dbo'");
});

test('optionalEqualsClause: escapes quotes in the value, not just sqlLiteral in isolation', () => {
  assert.equal(
    optionalEqualsClause('TABLE_SCHEMA', "weird'schema"),
    " AND TABLE_SCHEMA = 'weird''schema'"
  );
});

// --- assertSafeIdentifier -----------------------------------------------------
// A database name goes straight into worker.ps1's connection string, not into
// SQL text, so it can't be neutralized with quote-doubling like the values
// above - it must be a plain identifier or rejected outright.

test('assertSafeIdentifier: a plain name passes', () => {
  assert.doesNotThrow(() => assertSafeIdentifier('MyDatabase', 'database'));
});

test('assertSafeIdentifier: undefined/null pass (optional value)', () => {
  assert.doesNotThrow(() => assertSafeIdentifier(undefined, 'database'));
  assert.doesNotThrow(() => assertSafeIdentifier(null, 'database'));
});

test('assertSafeIdentifier: a connection-string injection attempt is rejected', () => {
  assert.throws(() => assertSafeIdentifier('master;Server=attacker,1433', 'database'), /Invalid database/);
});

test('assertSafeIdentifier: a semicolon alone is rejected', () => {
  assert.throws(() => assertSafeIdentifier('master;', 'database'));
});

// --- bracketIdentifier ---------------------------------------------------
// Used for EXEC [schema].[name] in execute_procedure, where the value is
// the callable object itself, not a WHERE-clause literal - sqlLiteral's
// quoting doesn't apply here.

test('bracketIdentifier: a plain name is wrapped in brackets', () => {
  assert.equal(bracketIdentifier('dbo'), '[dbo]');
});

test('bracketIdentifier: an embedded closing bracket is doubled, not left to close early', () => {
  // Unescaped, "Weird]Proc" would close the identifier after "Weird",
  // leaving "Proc]" as trailing SQL text instead of part of the name.
  assert.equal(bracketIdentifier('Weird]Proc'), '[Weird]]Proc]');
});

test('bracketIdentifier: rejects non-string input', () => {
  assert.throws(() => bracketIdentifier(42), TypeError);
});

// --- sqlValueLiteral -------------------------------------------------------
// Used for @param = <value> in execute_procedure, where the value can be
// any JSON scalar, not just a string.

test('sqlValueLiteral: null becomes the NULL keyword, not the string "null"', () => {
  assert.equal(sqlValueLiteral(null), 'NULL');
});

test('sqlValueLiteral: true/false become 1/0', () => {
  assert.equal(sqlValueLiteral(true), '1');
  assert.equal(sqlValueLiteral(false), '0');
});

test('sqlValueLiteral: a number is rendered as bare text', () => {
  assert.equal(sqlValueLiteral(42), '42');
  assert.equal(sqlValueLiteral(-1.5), '-1.5');
});

test('sqlValueLiteral: rejects non-finite numbers', () => {
  assert.throws(() => sqlValueLiteral(NaN), TypeError);
  assert.throws(() => sqlValueLiteral(Infinity), TypeError);
});

test('sqlValueLiteral: a string goes through sqlLiteral escaping', () => {
  assert.equal(sqlValueLiteral("O'Brien"), "'O''Brien'");
});

test('sqlValueLiteral: rejects a value of an unsupported type (object/array)', () => {
  assert.throws(() => sqlValueLiteral({}), TypeError);
  assert.throws(() => sqlValueLiteral([1, 2]), TypeError);
});
