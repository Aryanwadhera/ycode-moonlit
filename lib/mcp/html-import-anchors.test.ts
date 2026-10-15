import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveCrossPageAnchors } from './html-import-anchors';
import type { AnchorPageSource } from './html-import-anchors';
import { parseAnchorHref } from '../html-layer-converter';
import { htmlToLayersOnServer } from '../server/html-to-layers';
import type { Layer } from '../../types';

test('parseAnchorHref recognises same-page and site-path anchors only', () => {
  assert.deepEqual(parseAnchorHref('#features'), { anchorId: 'features' });
  assert.deepEqual(parseAnchorHref('/#features'), { anchorId: 'features', pagePath: '/' });
  assert.deepEqual(parseAnchorHref('/pricing#plans'), { anchorId: 'plans', pagePath: '/pricing' });
  assert.deepEqual(parseAnchorHref('/pricing/#plans'), { anchorId: 'plans', pagePath: '/pricing' });
  assert.equal(parseAnchorHref('#'), null);
  assert.equal(parseAnchorHref('/pricing'), null);
  assert.equal(parseAnchorHref('https://example.com/#top'), null);
  assert.equal(parseAnchorHref('//cdn.example.com/x#y'), null);
});

test('the importer resolves local anchors itself and hands the rest over', () => {
  const result = htmlToLayersOnServer(`
    <nav class="flex">
      <a href="#features" class="p-2">Features</a>
      <a href="#pricing" class="p-2">Pricing</a>
      <a href="/#top" class="p-2">Home</a>
      <a href="/pricing#plans" class="p-2">Plans</a>
      <a href="https://x.y/#z" class="p-2">Out</a>
    </nav>
    <section id="features"></section>`, { anchorIds: ['already-on-page'] });

  const nav = result.layers[0];
  const [features] = nav.children as Layer[];
  assert.equal(features.variables?.link?.anchor_layer_id, 'features');
  assert.equal(features.variables?.link?.url, undefined);

  assert.deepEqual(
    result.unresolvedAnchors.map(({ anchorId, pagePath }) => ({ anchorId, pagePath })),
    [
      { anchorId: 'pricing', pagePath: undefined },
      { anchorId: 'top', pagePath: '/' },
      { anchorId: 'plans', pagePath: '/pricing' },
    ],
  );
  // Nothing is reported yet: the caller decides after looking at the other pages.
  assert.ok(!result.warnings.some((w) => w.message.includes('kept as a URL')), JSON.stringify(result.warnings));
});

const link = (id: string, href: string): Layer => ({
  id,
  name: 'div',
  classes: '',
  variables: { link: { type: 'url', url: { type: 'dynamic_text', data: { content: href } }, target: '_self' } },
});

const pages: AnchorPageSource[] = [
  { id: 'home', path: '/', isHomepage: true, htmlIds: new Set(['features', 'top']) },
  { id: 'pricing', path: '/pricing', isHomepage: false, htmlIds: new Set(['plans', 'features']) },
  { id: 'about', path: '/about', isHomepage: false, htmlIds: new Set() },
];

test('a bare #id becomes a page + anchor link to the page holding it, preferring the homepage', () => {
  const layers = [link('a', '#features'), link('b', '#plans'), link('c', '#nowhere')];
  const result = resolveCrossPageAnchors(layers, [
    { layerId: 'a', anchorId: 'features', path: 'a' },
    { layerId: 'b', anchorId: 'plans', path: 'b' },
    { layerId: 'c', anchorId: 'nowhere', path: 'c' },
  ], { pages, currentPageId: 'about', localIds: new Set() });

  assert.deepEqual(layers[0].variables?.link, { type: 'page', page: { id: 'home' }, anchor_layer_id: 'features', target: '_self' });
  assert.deepEqual(layers[1].variables?.link, { type: 'page', page: { id: 'pricing' }, anchor_layer_id: 'plans', target: '_self' });
  assert.equal(layers[2].variables?.link?.type, 'url', 'unknown ids stay URLs');

  assert.deepEqual(result.resolved.map((r) => r.layerId), ['a', 'b']);
  const messages = result.warnings.map((w) => w.message);
  assert.equal(messages.length, 2, messages.join('\n'));
  assert.match(messages[0], /matches an id on 2 pages; it now points at "\/"/);
  assert.match(messages[1], /"#nowhere" has no element with id "nowhere" in the import or on any page/);
  assert.ok(result.warnings.every((w) => w.severity === 'warning'));
});

test('a /path#id href links to that page even when the id is not there yet', () => {
  const layers = [link('a', '/pricing#plans'), link('b', '/about#team'), link('c', '/missing#x'), link('d', '/#hero')];
  const result = resolveCrossPageAnchors(layers, [
    { layerId: 'a', anchorId: 'plans', path: 'a', pagePath: '/pricing' },
    { layerId: 'b', anchorId: 'team', path: 'b', pagePath: '/about' },
    { layerId: 'c', anchorId: 'x', path: 'c', pagePath: '/missing' },
    { layerId: 'd', anchorId: 'hero', path: 'd', pagePath: '/' },
  ], { pages, currentPageId: 'home', localIds: new Set(['hero']) });

  assert.deepEqual(layers[0].variables?.link?.page, { id: 'pricing' });
  assert.deepEqual(layers[1].variables?.link?.page, { id: 'about' });
  assert.equal(layers[2].variables?.link?.type, 'url');
  // "hero" is in the HTML being imported into the homepage, so it counts as present.
  assert.deepEqual(layers[3].variables?.link?.page, { id: 'home' });

  const messages = result.warnings.map((w) => w.message);
  assert.equal(messages.length, 2, messages.join('\n'));
  assert.match(messages[0], /nothing there has id "team" yet/);
  assert.match(messages[1], /"\/missing#x" points at a page that doesn't exist/);
});
