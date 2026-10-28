import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffFieldOptions, resolveOptionValue } from './collection-field-utils';
import { coerceCollectionItemValues } from './mcp/utils';
import type { CollectionField } from '../types';

const options = [
  { id: 'opt-a', name: 'Option A ' },
  { id: 'opt-b', name: 'Option B' },
];

test('resolveOptionValue stores an option id as its trimmed name', () => {
  assert.equal(resolveOptionValue(options, 'opt-a'), 'Option A');
});

test('resolveOptionValue keeps option names and unknown values as-is', () => {
  assert.equal(resolveOptionValue(options, 'Option B'), 'Option B');
  assert.equal(resolveOptionValue(options, 'Something else'), 'Something else');
  assert.equal(resolveOptionValue(options, ''), '');
  assert.equal(resolveOptionValue(undefined, 'opt-a'), 'opt-a');
});

test('resolveOptionValue prefers a name match when a name equals another option id', () => {
  const tricky = [{ id: 'x', name: 'Y' }, { id: 'Y', name: 'Z' }];
  assert.equal(resolveOptionValue(tricky, 'Y'), 'Y');
});

test('diffFieldOptions finds renames and removals by id', () => {
  const diff = diffFieldOptions(
    [{ id: 'a', name: 'Old A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    [{ id: 'a', name: ' New A ' }, { id: 'b', name: 'B' }, { id: 'd', name: 'D' }],
  );

  assert.deepEqual(diff, { renames: [{ oldName: 'Old A', newName: 'New A' }], removedNames: ['C'] });
});

test('coerceCollectionItemValues resolves option ids and leaves other fields alone', () => {
  const fields = [
    { id: 'f-option', type: 'option', data: { options } },
    { id: 'f-text', type: 'text', data: {} },
  ] as Pick<CollectionField, 'id' | 'type' | 'data'>[];

  assert.deepEqual(
    coerceCollectionItemValues({ 'f-option': 'opt-a', 'f-text': 'opt-a', 'f-unknown': 'opt-b' }, fields),
    { 'f-option': 'Option A', 'f-text': 'opt-a', 'f-unknown': 'opt-b' },
  );
});
