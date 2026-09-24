import test from 'node:test';
import assert from 'node:assert/strict';
import { isExecutePermissionDenied } from '../lib/sql-errors.mjs';

test('isExecutePermissionDenied: matches SQL Server\'s real error 229 wording', () => {
  const message = "The EXECUTE permission was denied on the object 'GetOrder', database 'Sales', schema 'dbo'.";
  assert.equal(isExecutePermissionDenied(message), true);
});

test('isExecutePermissionDenied: match is case-insensitive', () => {
  assert.equal(isExecutePermissionDenied('the execute permission was denied on the object x'), true);
});

test('isExecutePermissionDenied: an unrelated error does not match', () => {
  assert.equal(isExecutePermissionDenied("Invalid object name 'GetOrder'."), false);
});

test('isExecutePermissionDenied: a different permission error (e.g. SELECT) does not match', () => {
  assert.equal(isExecutePermissionDenied("The SELECT permission was denied on the object 'Orders'."), false);
});

test('isExecutePermissionDenied: non-string input is false, not a throw', () => {
  assert.equal(isExecutePermissionDenied(undefined), false);
  assert.equal(isExecutePermissionDenied(null), false);
});
