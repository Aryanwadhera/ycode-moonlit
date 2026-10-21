import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, createInversePatch, createPatch } from '@/lib/version-utils';
import type { Layer } from '@/types';

const leaf = (id: string): Layer => ({ id, name: 'text', classes: '' });
const section = (id: string, children: Layer[]): Layer => ({ id, name: 'section', classes: '', children });
const body = (children: Layer[]): Layer[] => [{ id: 'body', name: 'body', classes: '', children }];

/** Assert redo and undo patches round-trip between the two states. */
function assertRoundTrip(prev: Layer[], next: Layer[]) {
  const redo = createPatch(prev, next);
  const undo = createInversePatch(prev, redo);

  assert.deepEqual(applyPatch(prev, redo), next, 'redo');
  assert.deepEqual(applyPatch(next, undo), prev, 'undo');
}

test('moving a layer into its next sibling round-trips without duplicating it', () => {
  assertRoundTrip(
    body([leaf('x'), section('a', [leaf('a1')]), section('b', [leaf('b1')])]),
    body([section('a', [leaf('a1'), leaf('x')]), section('b', [leaf('b1')])]),
  );
});

test('inserting a layer before a modified sibling round-trips', () => {
  assertRoundTrip(
    body([section('a', [leaf('a1')]), section('b', [leaf('b1')])]),
    body([leaf('n'), section('a', [leaf('a1'), leaf('a2')]), section('b', [leaf('b1')])]),
  );
});

test('removing a layer alongside a modified sibling round-trips', () => {
  assertRoundTrip(
    body([section('a', [leaf('a1')]), section('b', [leaf('b1'), leaf('b2')])]),
    body([section('b', [leaf('b1')])]),
  );
});

test('moving a nested layer up to the parent level round-trips', () => {
  assertRoundTrip(
    body([section('a', [leaf('a1'), leaf('x')]), section('b', [leaf('b1')])]),
    body([leaf('x'), section('a', [leaf('a1')]), section('b', [leaf('b1')])]),
  );
});

test('modifications in separate subtrees keep fine-grained patches', () => {
  const prev = body([section('a', [leaf('a1')]), section('b', [leaf('b1')])]);
  const next = body([section('a', [leaf('a1'), leaf('a2')]), section('b', [])]);
  const redo = createPatch(prev, next);

  assert.ok(redo.every(op => op.path !== '/0/children'), 'body children are not replaced');
  assertRoundTrip(prev, next);
});
