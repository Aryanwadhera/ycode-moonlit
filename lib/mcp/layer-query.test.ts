import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeLink, hasLayerQuery, MAX_SEARCH_MATCHES, queryLayers } from './layer-query';
import type { Layer } from '../../types';

const richText = (text: string) => ({
  type: 'dynamic_rich_text' as const,
  data: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } },
});

const tree: Layer[] = [{
  id: 'body',
  name: 'body',
  classes: '',
  children: [
    {
      id: 'hero',
      name: 'section',
      classes: 'flex py-24',
      attributes: { id: 'top' },
      design: { spacing: { isActive: true, paddingTop: '96px' } },
      children: [
        { id: 'title', name: 'heading', classes: 'text-5xl', variables: { text: richText('Build faster') } },
        {
          id: 'row',
          name: 'div',
          classes: ['flex', 'gap-4'],
          children: [{ id: 'cta', name: 'div', customName: 'CTA', classes: 'rounded-full', children: [] }],
        },
      ],
    },
    { id: 'footer', name: 'section', classes: 'bg-black', children: [] },
  ],
}];

test('only page_id means no query, so get_layers keeps its full-tree output', () => {
  assert.equal(hasLayerQuery({}), false);
  assert.equal(hasLayerQuery({ depth: 0 }), true);
  assert.equal(hasLayerQuery({ search: '' }), false);
});

test('summary fields with a depth limit give a compact overview', () => {
  const result = queryLayers(tree, { fields: 'summary', depth: 1 });
  assert.deepEqual(result, {
    layers: [{
      id: 'body',
      name: 'body',
      children: [
        { id: 'hero', name: 'section', html_id: 'top', classes: 'flex py-24', children_count: 2 },
        { id: 'footer', name: 'section', classes: 'bg-black' },
      ],
    }],
  });
});

test('layer_id returns one subtree with full layer data', () => {
  const result = queryLayers(tree, { layerId: 'row' });
  assert.ok('layers' in result);
  const [row] = result.layers as Layer[];
  assert.equal(row.id, 'row');
  assert.deepEqual(row.classes, ['flex', 'gap-4']);
  assert.equal((row.children as Layer[])[0].id, 'cta');

  assert.deepEqual(queryLayers(tree, { layerId: 'nope' }), { error: 'Layer "nope" not found on this page.' });
});

test('search matches text, classes, names and html ids, with paths', () => {
  const byText = queryLayers(tree, { search: 'build', fields: 'summary' });
  assert.deepEqual(byText, {
    matches: [{
      parent_id: 'hero',
      path: 'body > section#top > heading',
      layer: { id: 'title', name: 'heading', text: 'Build faster', classes: 'text-5xl' },
    }],
    match_count: 1,
  });

  const byClass = queryLayers(tree, { search: 'ROUNDED-FULL', fields: 'summary' });
  assert.ok('matches' in byClass);
  assert.equal(byClass.matches[0].path, 'body > section#top > div > CTA');

  const byHtmlId = queryLayers(tree, { search: 'top', fields: 'summary' });
  assert.ok('matches' in byHtmlId);
  assert.deepEqual(byHtmlId.matches[0].layer, { id: 'hero', name: 'section', html_id: 'top', classes: 'flex py-24', children_count: 2 });
});

test('search inside a subtree keeps the full path and caps matches', () => {
  const scoped = queryLayers(tree, { layerId: 'hero', search: 'flex' });
  assert.ok('matches' in scoped);
  assert.deepEqual(scoped.matches.map((m) => m.path), ['body > section#top', 'body > section#top > div']);

  const many: Layer[] = Array.from({ length: MAX_SEARCH_MATCHES + 5 }, (_, i) => ({ id: `l${i}`, name: 'div', classes: 'card' }));
  const capped = queryLayers(many, { search: 'card' });
  assert.ok('matches' in capped);
  assert.equal(capped.matches.length, MAX_SEARCH_MATCHES);
  assert.equal(capped.match_count, MAX_SEARCH_MATCHES + 5);
  assert.equal(capped.matches_omitted, 5);
});

test('summary includes the html tag and a one-line link', () => {
  const layers: Layer[] = [{
    id: 'a',
    name: 'text',
    classes: '',
    settings: { tag: 'h2' },
    variables: { link: { type: 'url', url: { type: 'dynamic_text', data: { content: 'https://x.com' } } } },
  }];
  assert.deepEqual(queryLayers(layers, { fields: 'summary' }), {
    layers: [{ id: 'a', name: 'text', tag: 'h2', link: 'https://x.com' }],
  });
});

test('describeLink covers pages, anchors, and contact links', () => {
  assert.equal(describeLink({ type: 'page', page: { id: 'p1' } }), 'page:p1');
  assert.equal(describeLink({ type: 'url', anchor_layer_id: 'lyr_1' }), '#lyr_1');
  assert.equal(describeLink({ type: 'page', page: { id: 'p1' }, anchor_layer_id: 'lyr_1' }), 'page:p1#lyr_1');
  assert.equal(describeLink({ type: 'email', email: { type: 'dynamic_text', data: { content: 'a@b.co' } } }), 'mailto:a@b.co');
  assert.equal(describeLink({ type: 'url' }), undefined);
});
