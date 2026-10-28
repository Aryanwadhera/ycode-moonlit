import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyLayerSettings } from './utils';
import type { Layer } from '../../types';

const input = (extra: Partial<Layer> = {}): Layer => ({
  id: 'field',
  name: 'input',
  classes: '',
  attributes: { type: 'text', placeholder: 'Enter text...' },
  ...extra,
} as Layer);

test('sets a form field\'s own attributes instead of custom attributes', () => {
  const layer = applyLayerSettings(input(), {
    custom_attributes: { placeholder: 'Your email', name: 'email', type: 'email', 'data-track': 'signup' },
  });

  assert.deepEqual(layer.attributes, { type: 'email', placeholder: 'Your email', name: 'email' });
  assert.deepEqual(layer.settings?.customAttributes, { 'data-track': 'signup' });
});

test('maps required / autofocus to booleans and clears with "" or "false"', () => {
  const on = applyLayerSettings(input(), { custom_attributes: { required: 'true', autofocus: '' } });
  assert.equal(on.attributes?.required, true);
  assert.equal(on.attributes?.autoFocus, true);

  const off = applyLayerSettings(on, { custom_attributes: { required: 'false', placeholder: '' } });
  assert.equal(off.attributes?.required, undefined);
  assert.equal(off.attributes?.placeholder, undefined);
  assert.equal(off.attributes?.autoFocus, true);
});

test('drops stale custom attribute copies of field attributes', () => {
  const layer = applyLayerSettings(
    input({ settings: { customAttributes: { Placeholder: 'Old override', 'data-x': '1' } } }),
    { custom_attributes: { placeholder: 'New' } },
  );

  assert.equal(layer.attributes?.placeholder, 'New');
  assert.deepEqual(layer.settings?.customAttributes, { 'data-x': '1' });
});

test('keeps name and type on the locked password input', () => {
  const layer = applyLayerSettings(
    input({ attributes: { type: 'password', name: 'password' }, restrictions: { copy: false, delete: false } }),
    { custom_attributes: { name: 'pw', type: 'text', placeholder: 'Password' } },
  );

  assert.deepEqual(layer.attributes, { type: 'password', name: 'password', placeholder: 'Password' });
});

test('leaves custom attributes on non-field layers untouched', () => {
  const layer = applyLayerSettings({ id: 'd', name: 'div', classes: '' } as Layer, { custom_attributes: { name: 'x' } });

  assert.equal(layer.attributes, undefined);
  assert.deepEqual(layer.settings?.customAttributes, { name: 'x' });
});
