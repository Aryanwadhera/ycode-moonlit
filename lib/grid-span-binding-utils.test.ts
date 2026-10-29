import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyGridSpanBindings, getGridSpanBindingClasses, resolveGridSpanToken } from './grid-span-binding-utils';
import type { FieldVariable, Layer } from '../types';

const fieldVar = (fieldId: string): FieldVariable => ({
  type: 'field',
  data: { field_id: fieldId, relationships: [], field_type: 'number' },
});

const values: Record<string, unknown> = { cols: 3, rows: '2', empty: '', bad: '2.5' };
const resolve = (fv: FieldVariable) => values[fv.data.field_id as string];

test('resolveGridSpanToken accepts integers 1-12 and full', () => {
  assert.equal(resolveGridSpanToken(3), '3');
  assert.equal(resolveGridSpanToken(' 12 '), '12');
  assert.equal(resolveGridSpanToken('Span 4'), '4');
  assert.equal(resolveGridSpanToken('Full'), 'full');
});

test('resolveGridSpanToken rejects empty, fractional and out-of-range values', () => {
  assert.equal(resolveGridSpanToken(''), null);
  assert.equal(resolveGridSpanToken(null), null);
  assert.equal(resolveGridSpanToken('2.5'), null);
  assert.equal(resolveGridSpanToken(0), null);
  assert.equal(resolveGridSpanToken(13), null);
  assert.equal(resolveGridSpanToken('Large'), null);
});

test('applyGridSpanBindings replaces only the base span class', () => {
  const classes = 'flex col-span-1 max-lg:col-span-2 max-md:col-span-1 row-span-1';
  const result = applyGridSpanBindings(classes, { gridColumnSpan: fieldVar('cols'), gridRowSpan: fieldVar('rows') }, resolve);
  assert.equal(result, 'flex max-lg:col-span-2 max-md:col-span-1 col-span-3 row-span-2');
});

test('applyGridSpanBindings keeps the static class when the value is empty or invalid', () => {
  const classes = 'flex col-span-2';
  assert.equal(applyGridSpanBindings(classes, { gridColumnSpan: fieldVar('empty') }, resolve), classes);
  assert.equal(applyGridSpanBindings(classes, { gridColumnSpan: fieldVar('bad') }, resolve), classes);
  assert.equal(applyGridSpanBindings(classes, undefined, resolve), classes);
});

test('getGridSpanBindingClasses lists every span class for bound properties only', () => {
  const layer = { id: 'l', name: 'div', classes: '', variables: { design: { gridColumnSpan: fieldVar('cols') } } } as Layer;
  const classes = getGridSpanBindingClasses(layer);
  assert.equal(classes.length, 13);
  assert.ok(classes.includes('col-span-1') && classes.includes('col-span-12') && classes.includes('col-span-full'));
  assert.ok(!classes.some(cls => cls.startsWith('row-span-')));
});
