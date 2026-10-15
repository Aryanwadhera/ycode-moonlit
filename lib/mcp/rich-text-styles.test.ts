import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyTextStyleDesign, TEXT_STYLE_KEYS } from './rich-text-styles';
import { DEFAULT_TEXT_STYLES } from '../text-format-utils';

const classes = (value: string) => value.split(' ').filter(Boolean).sort();

test('element styles merge into the default style and regenerate its classes', () => {
  const h2 = applyTextStyleDesign(
    DEFAULT_TEXT_STYLES.h2,
    { typography: { isActive: true, fontSize: '32px', lineHeight: '1.2' }, spacing: { isActive: true, marginTop: '48px', marginBottom: '16px' } },
    'desktop',
    'neutral',
  );
  assert.deepEqual(classes(h2.classes!), classes('text-[32px] font-semibold leading-[1.2] mt-[48px] mb-[16px]'));
  assert.equal(h2.design?.typography?.fontSize, '32px');
  assert.equal(h2.design?.typography?.fontWeight, 'semibold', 'untouched default properties survive');
  assert.equal(h2.label, 'Heading 2');
  assert.equal(DEFAULT_TEXT_STYLES.h2.classes, 'text-[24px] font-semibold', 'defaults are not mutated');
});

test('hover designs become hover: classes on the element style', () => {
  const link = applyTextStyleDesign(DEFAULT_TEXT_STYLES.link, { typography: { isActive: true, color: '#2563eb' } }, 'desktop', 'neutral');
  const hovered = applyTextStyleDesign(link, { typography: { isActive: true, color: '#1d4ed8' } }, 'desktop', 'hover');
  assert.ok(hovered.classes!.includes('text-[#2563eb]'));
  assert.ok(hovered.classes!.includes('hover:text-[#1d4ed8]'));
  assert.ok(hovered.classes!.includes('underline'));
});

test('every editor text-style key is exposed', () => {
  for (const key of ['h1', 'h2', 'h3', 'paragraph', 'link', 'bulletList', 'orderedList', 'blockquote', 'richTextImage', 'table', 'tableCell']) {
    assert.ok(TEXT_STYLE_KEYS.includes(key), key);
  }
});
