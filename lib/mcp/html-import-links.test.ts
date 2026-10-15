import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveCrossPageLinks } from './html-import-links';
import type { LinkPageSource } from './html-import-links';
import { parseSiteHref } from '../html-layer-converter';
import { htmlToLayersOnServer } from '../server/html-to-layers';
import type { Layer } from '../../types';

test('parseSiteHref recognises site paths and anchors only', () => {
  assert.deepEqual(parseSiteHref('#features'), { anchorId: 'features' });
  assert.deepEqual(parseSiteHref('/#features'), { anchorId: 'features', pagePath: '/' });
  assert.deepEqual(parseSiteHref('/pricing#plans'), { anchorId: 'plans', pagePath: '/pricing' });
  assert.deepEqual(parseSiteHref('/pricing/#plans'), { anchorId: 'plans', pagePath: '/pricing' });
  assert.deepEqual(parseSiteHref('/'), { pagePath: '/' });
  assert.deepEqual(parseSiteHref('/pricing'), { pagePath: '/pricing' });
  assert.deepEqual(parseSiteHref('/blog/post/'), { pagePath: '/blog/post' });
  assert.equal(parseSiteHref('#'), null);
  assert.equal(parseSiteHref('/pricing#'), null);
  assert.equal(parseSiteHref('/pricing?plan=pro'), null);
  assert.equal(parseSiteHref('/sitemap.xml'), null);
  assert.equal(parseSiteHref('https://example.com/#top'), null);
  assert.equal(parseSiteHref('//cdn.example.com/x#y'), null);
  assert.equal(parseSiteHref('mailto:hi@example.com'), null);
});

test('the importer resolves local anchors itself and hands the rest over', () => {
  const result = htmlToLayersOnServer(`
    <nav class="flex">
      <a href="#features" class="p-2">Features</a>
      <a href="#pricing" class="p-2">Pricing</a>
      <a href="/#top" class="p-2">Home</a>
      <a href="/pricing#plans" class="p-2">Plans</a>
      <a href="/about" class="p-2">About</a>
      <a href="https://x.y/#z" class="p-2">Out</a>
    </nav>
    <section id="features"></section>`, { anchorIds: ['already-on-page'] });

  const nav = result.layers[0];
  const [features] = nav.children as Layer[];
  assert.equal(features.variables?.link?.anchor_layer_id, 'features');
  assert.equal(features.variables?.link?.url, undefined);

  assert.deepEqual(
    result.unresolvedLinks.map(({ anchorId, pagePath }) => ({ anchorId, pagePath })),
    [
      { anchorId: 'pricing', pagePath: undefined },
      { anchorId: 'top', pagePath: '/' },
      { anchorId: 'plans', pagePath: '/pricing' },
      { anchorId: undefined, pagePath: '/about' },
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

const pages: LinkPageSource[] = [
  { id: 'home', path: '/', isHomepage: true, htmlIds: new Set(['features', 'top']) },
  { id: 'pricing', path: '/pricing', isHomepage: false, htmlIds: new Set(['plans', 'features']) },
  { id: 'about', path: '/about', isHomepage: false, htmlIds: new Set() },
];

test('a bare #id becomes a page + anchor link to the page holding it, preferring the homepage', () => {
  const layers = [link('a', '#features'), link('b', '#plans'), link('c', '#nowhere')];
  const result = resolveCrossPageLinks(layers, [
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
  const result = resolveCrossPageLinks(layers, [
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

test('a plain /path href becomes a page link; unknown paths stay URLs with a hint', () => {
  const layers = [link('a', '/pricing'), link('b', '/'), link('c', '/blog/hello-world')];
  const result = resolveCrossPageLinks(layers, [
    { layerId: 'a', path: 'a', pagePath: '/pricing' },
    { layerId: 'b', path: 'b', pagePath: '/' },
    { layerId: 'c', path: 'c', pagePath: '/blog/hello-world' },
  ], { pages, currentPageId: 'about', localIds: new Set() });

  assert.deepEqual(layers[0].variables?.link, { type: 'page', page: { id: 'pricing' }, target: '_self' });
  assert.deepEqual(layers[1].variables?.link, { type: 'page', page: { id: 'home' }, target: '_self' });
  assert.equal(layers[2].variables?.link?.url?.data.content, '/blog/hello-world');

  assert.deepEqual(result.resolved, [{ layerId: 'a', pageId: 'pricing' }, { layerId: 'b', pageId: 'home' }]);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].severity, 'hint');
  assert.match(result.warnings[0].message, /"\/blog\/hello-world" points at a page that doesn't exist/);
});
