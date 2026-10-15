import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lintDesign } from './design-lint';
import type { DesignIssue } from './design-lint';
import type { Layer } from '../../types';

const text = (id: string, classes = ''): Layer => ({ id, name: 'text', classes });
const messages = (issues: DesignIssue[]) => issues.map((issue) => issue.message);
const trioWarnings = (issues: DesignIssue[]) => messages(issues).filter((w) => w.includes('full trio'));

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

const link = (id: string, classes: string, children: Layer[] = []): Layer => ({
  id,
  name: 'div',
  classes,
  variables: { link: { type: 'url', url: { type: 'dynamic_text', data: { content: 'https://x.y' } } } },
  children,
});
const hoverWarnings = (issues: DesignIssue[]) => messages(issues).filter((w) => w.includes('hover state'));

test('links and buttons without a hover treatment are reported once', () => {
  const page: Layer[] = [{
    id: 'row',
    name: 'div',
    classes: 'flex flex-row',
    children: [
      link('a', 'text-[#111111]'),
      { id: 'b', name: 'button', classes: 'bg-[#000000]' },
      link('ok-class', 'text-[#111111] hover:text-[#ff0000]'),
      link('ok-child', 'text-[#111111]', [text('t', 'group-hover:underline')]),
      link('ok-style', 'text-[#111111]', []),
    ],
  }];
  (page[0].children![4] as Layer).styleIds = ['nav-link'];
  assert.deepEqual(hoverWarnings(lintDesign(page, new Set(['row']))), [
    '2 clickable layers have no hover state (e.g. [a], [b]) — give every link and button a hover state (ui_state "hover": color, background, opacity or underline) plus a transition.',
  ]);
});

test('a multi-column grid on a Collection List layer is flagged', () => {
  const collection: Layer = {
    id: 'list',
    name: 'div',
    classes: 'grid grid-cols-3 gap-[24px]',
    variables: { collection: { id: 'col-1' } },
    children: [text('t', 'text-[16px] font-medium leading-6')],
  };
  const warnings = messages(lintDesign([{ id: 'wrap', name: 'div', classes: '', children: [collection] }], new Set(['wrap'])));
  assert.ok(warnings.some((w) => w.startsWith('[list] is a Collection List') && w.includes('3-column grid')), warnings.join('\n'));

  const fixed: Layer = { ...collection, classes: 'flex flex-col gap-[8px]' };
  const none = messages(lintDesign([{ id: 'wrap', name: 'div', classes: 'grid grid-cols-3', children: [fixed] }], new Set(['wrap'])));
  assert.ok(!none.some((w) => w.includes('Collection List')), none.join('\n'));
});

test('a nav that hides links on small screens without a click toggle is flagged', () => {
  const nav = (interactions?: Layer['interactions']): Layer => ({
    id: 'nav',
    name: 'div',
    classes: 'flex flex-row',
    settings: { tag: 'nav' },
    children: [
      { id: 'links', name: 'div', classes: 'flex flex-row max-lg:hidden', children: [] },
      { id: 'toggle', name: 'button', classes: 'hidden max-lg:flex hover:opacity-80', interactions },
    ],
  });
  const flagged = messages(lintDesign([nav()], new Set(['nav'])));
  assert.ok(flagged.some((w) => w.includes('hides links on tablet/mobile')), flagged.join('\n'));

  const ok = messages(lintDesign([nav([{ id: 'i', trigger: 'click', timeline: { breakpoints: ['mobile'], repeat: 0, yoyo: true }, tweens: [] }])], new Set(['nav'])));
  assert.ok(!ok.some((w) => w.includes('hides links on tablet/mobile')), ok.join('\n'));
});

test('issues carry a severity and are ordered errors → warnings → hints', () => {
  const page: Layer[] = [{
    id: 'sec',
    name: 'section',
    classes: 'flex',
    children: [
      // content directly in a section: error
      text('title', 'text-[32px] font-bold leading-tight'),
      // flex without a direction (on the section itself): hint
      text('sub', 'text-[16px] font-normal leading-6'),
    ],
  }];
  const issues = lintDesign(page, new Set(['sec']));
  const severities = issues.map((issue) => issue.severity);
  assert.equal(severities[0], 'error', JSON.stringify(issues));
  assert.ok(severities.includes('hint'), JSON.stringify(issues));
  const order = { error: 0, warning: 1, hint: 2 };
  assert.deepEqual(severities, [...severities].sort((a, b) => order[a] - order[b]));
});
