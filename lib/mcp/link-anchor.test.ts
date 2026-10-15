import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultDynamicPageItem, resolveLinkAnchor } from './utils';
import type { LinkInput } from './utils';
import { generateLinkHref, isValidLinkSettings } from '../link-utils';
import type { Layer, Page } from '../../types';

const layers: Layer[] = [{
  id: 'body',
  name: 'body',
  classes: '',
  children: [
    { id: 'lyr-features', name: 'section', classes: '', settings: { id: 'features' }, children: [] },
    { id: 'lyr-plain', name: 'section', classes: '', children: [] },
  ],
}];

test('anchor-only url links are valid and render as #anchor', () => {
  const link = { type: 'url' as const, anchor_layer_id: 'features' };
  assert.equal(isValidLinkSettings(link), true);
  assert.equal(generateLinkHref(link, {}), '#features');
  assert.equal(isValidLinkSettings({ type: 'url' }), false);
});

test('a stored layer id resolves through the settings.id anchor map', () => {
  const link = { type: 'url' as const, anchor_layer_id: 'lyr-features' };
  assert.equal(generateLinkHref(link, { anchorMap: { 'lyr-features': 'features' } }), '#features');
});

test('resolveLinkAnchor stores the target HTML id', () => {
  const byLayerId = resolveLinkAnchor({ link_type: 'url', anchor_layer_id: 'lyr-features' }, layers);
  assert.deepEqual(byLayerId, { input: { link_type: 'url', anchor_layer_id: 'features' } });

  const byHtmlId = resolveLinkAnchor({ link_type: 'url', anchor_layer_id: '#features' }, layers);
  assert.deepEqual(byHtmlId, { input: { link_type: 'url', anchor_layer_id: 'features' } });
});

test('resolveLinkAnchor rejects targets that cannot render', () => {
  const noHtmlId = resolveLinkAnchor({ link_type: 'url', anchor_layer_id: 'lyr-plain' }, layers);
  assert.ok('error' in noHtmlId && /no HTML id/.test(noHtmlId.error));

  const unknown = resolveLinkAnchor({ link_type: 'url', anchor_layer_id: 'pricing' }, layers);
  assert.ok('error' in unknown && /No layer/.test(unknown.error));

  const noAnchor = { link_type: 'url' as const, url: 'https://example.com' };
  assert.deepEqual(resolveLinkAnchor(noAnchor, layers), { input: noAnchor });
});

test('dynamic page links default to the item the layer is about', () => {
  const tree: Layer[] = [{
    id: 'body', name: 'body', classes: '', children: [
      { id: 'list', name: 'collection', classes: '', variables: { collection: { id: 'col_posts' } }, children: [
        { id: 'card', name: 'div', classes: '', children: [{ id: 'title', name: 'text', classes: '' }] },
      ] },
      { id: 'nav-link', name: 'div', classes: '' },
    ],
  }];
  const postPage = { is_dynamic: true, settings: { cms: { collection_id: 'col_posts' } } } as unknown as Page;
  const staticPage = { is_dynamic: false, settings: {} } as unknown as Page;
  const input: LinkInput = { link_type: 'page', page_id_target: 'post' };

  // Inside (or on) a list of the target collection → that list's item.
  assert.equal(defaultDynamicPageItem(input, tree, 'card', postPage).collection_item_id, 'current-collection');
  assert.equal(defaultDynamicPageItem(input, tree, 'title', postPage).collection_item_id, 'current-collection');
  assert.equal(defaultDynamicPageItem(input, tree, 'list', postPage).collection_item_id, 'current-collection');
  // Outside any list but on the collection's own dynamic page → the page's item.
  assert.equal(defaultDynamicPageItem(input, tree, 'nav-link', postPage, postPage).collection_item_id, 'current-page');
  // Nothing to infer from: leave it to the agent.
  assert.equal(defaultDynamicPageItem(input, tree, 'nav-link', postPage, staticPage).collection_item_id, undefined);
  // Explicit values and non-dynamic targets are untouched.
  assert.equal(defaultDynamicPageItem({ ...input, collection_item_id: 'item_1' }, tree, 'card', postPage).collection_item_id, 'item_1');
  assert.equal(defaultDynamicPageItem(input, tree, 'card', staticPage).collection_item_id, undefined);
  assert.equal(defaultDynamicPageItem({ link_type: 'url', url: '/x' } as LinkInput, tree, 'card', postPage).collection_item_id, undefined);
});
