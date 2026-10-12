import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lintDesign } from './design-lint';
import type { Layer } from '../../types';

const text = (id: string, classes = ''): Layer => ({ id, name: 'text', classes });
const trioWarnings = (warnings: string[]) => warnings.filter((w) => w.includes('full trio'));

test('typography set on a parent counts for the text inside it', () => {
  const page: Layer[] = [{
    id: 'btn',
    name: 'div',
    classes: 'text-sm font-semibold leading-6 text-[#ffffff] bg-[#000000]',
    children: [text('label')],
  }];
  assert.deepEqual(trioWarnings(lintDesign(page, new Set(['btn']))), []);
});

test('a text color class is not mistaken for a font size', () => {
  const page: Layer[] = [text('t', 'text-[#111111] font-bold leading-6')];
  assert.deepEqual(trioWarnings(lintDesign(page, new Set(['t']))), [
    '[t] text layer has no fontSize — always set the full trio (fontSize, fontWeight, lineHeight) on the text or a parent.',
  ]);
});

test('many text layers missing the trio collapse into one summary', () => {
  const page: Layer[] = [{
    id: 'list',
    name: 'div',
    classes: 'text-[16px]',
    children: [text('a'), text('b'), text('c'), text('d')],
  }];
  assert.deepEqual(trioWarnings(lintDesign(page, new Set(['list']))), [
    '4 text layers have no fontWeight/lineHeight on them or any parent (e.g. [a], [b], [c]) — always set the full trio (fontSize, fontWeight, lineHeight) on the text or a parent.',
  ]);
});

test('untouched layers are not linted', () => {
  const page: Layer[] = [text('a'), text('b')];
  assert.deepEqual(trioWarnings(lintDesign(page, new Set(['b']))).length, 1);
});
