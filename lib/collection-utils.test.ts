import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasCollectionValueChanges } from '@/lib/collection-utils';

const TITLE = 'fld-title';
const BODY = 'fld-body';
const UPDATED_AT = 'fld-updated-at';

test('detects a changed value', () => {
  assert.equal(
    hasCollectionValueChanges(
      { [TITLE]: 'New title' },
      { [TITLE]: 'Old title' },
      UPDATED_AT,
    ),
    true,
  );
});

test('reports no change when every value is identical', () => {
  assert.equal(
    hasCollectionValueChanges(
      { [TITLE]: 'Same title', [BODY]: 'Same body' },
      { [TITLE]: 'Same title', [BODY]: 'Same body' },
      UPDATED_AT,
    ),
    false,
  );
});

test('ignores the auto-managed updated_at field', () => {
  assert.equal(
    hasCollectionValueChanges(
      { [TITLE]: 'Same title', [UPDATED_AT]: '2026-10-15T00:00:00.000Z' },
      { [TITLE]: 'Same title', [UPDATED_AT]: '2026-09-16T00:00:00.000Z' },
      UPDATED_AT,
    ),
    false,
  );
});

test('detects a change in a sibling field even when updated_at also differs', () => {
  assert.equal(
    hasCollectionValueChanges(
      { [TITLE]: 'New title', [UPDATED_AT]: '2026-10-15T00:00:00.000Z' },
      { [TITLE]: 'Old title', [UPDATED_AT]: '2026-09-16T00:00:00.000Z' },
      UPDATED_AT,
    ),
    true,
  );
});

test('treats null, undefined and empty string as equivalent', () => {
  assert.equal(hasCollectionValueChanges({ [TITLE]: null }, { [TITLE]: '' }), false);
  assert.equal(hasCollectionValueChanges({ [TITLE]: '' }, { [TITLE]: null }), false);
  assert.equal(hasCollectionValueChanges({ [TITLE]: null }, {}), false);
  assert.equal(hasCollectionValueChanges({ [TITLE]: '' }, {}), false);
});

test('detects clearing a value', () => {
  assert.equal(hasCollectionValueChanges({ [TITLE]: null }, { [TITLE]: 'Old title' }), true);
  assert.equal(hasCollectionValueChanges({ [TITLE]: '' }, { [TITLE]: 'Old title' }), true);
});

test('detects a value written to a field that has no stored row yet', () => {
  assert.equal(hasCollectionValueChanges({ [BODY]: 'First body' }, { [TITLE]: 'Title' }), true);
});

test('compares non-string values by their string form', () => {
  // The store compares raw input against stored strings, so 7 === '7'
  assert.equal(hasCollectionValueChanges({ [TITLE]: 7 }, { [TITLE]: '7' }), false);
  assert.equal(hasCollectionValueChanges({ [TITLE]: true }, { [TITLE]: 'true' }), false);
  assert.equal(hasCollectionValueChanges({ [TITLE]: 7 }, { [TITLE]: '8' }), true);
});

test('ignores stored fields that the save does not touch', () => {
  assert.equal(
    hasCollectionValueChanges({ [TITLE]: 'Same title' }, { [TITLE]: 'Same title', [BODY]: 'Untouched' }),
    false,
  );
});

test('reports no change for an empty save', () => {
  assert.equal(hasCollectionValueChanges({}, { [TITLE]: 'Title' }), false);
});
