import test from 'node:test';
import assert from 'node:assert/strict';
import { stripBom } from '../lib/json-utils.mjs';

test('stripBom: a string with no BOM is returned unchanged', () => {
  assert.equal(stripBom('[1,2,3]'), '[1,2,3]');
});

test('stripBom: a leading BOM is removed', () => {
  const withBom = '﻿[1,2,3]';
  assert.equal(stripBom(withBom), '[1,2,3]');
});

test('stripBom: the result is valid JSON.parse input when the source had a BOM', () => {
  const withBom = '﻿{"a":1}';
  assert.doesNotThrow(() => JSON.parse(stripBom(withBom)));
  assert.deepEqual(JSON.parse(stripBom(withBom)), { a: 1 });
});

test('stripBom: a BOM-like character that is not at the very start is left alone', () => {
  const notLeading = 'x﻿y';
  assert.equal(stripBom(notLeading), 'x﻿y');
});

test('stripBom: empty string does not throw', () => {
  assert.equal(stripBom(''), '');
});
