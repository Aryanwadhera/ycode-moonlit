import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { collectItemSlugs, compactHtml, findRenderedLayers } from './rendered-export-core';

import type { Layer } from '@/types';

const layer = (id: string, children?: Layer[], extra?: Partial<Layer>): Layer => ({
  id,
  name: children ? 'div' : 'text',
  classes: '',
  ...(children ? { children } : {}),
  ...extra,
});

// A resolved tree: the grid holds the collection layer cloned once per item,
// and each clone carries its own copies of the card's children.
const resolved: Layer[] = [
  layer('body', [
    layer('grid', [
      layer('card-item-a', [layer('title-item-a'), layer('nested-item-a', [layer('deep-item-a-item-x')])], { _collectionItemId: 'a', _collectionItemSlug: 'alpha' }),
      layer('card-item-b', [layer('title-item-b'), layer('nested-item-b', [layer('deep-item-b-item-y')])], { _collectionItemId: 'b', _collectionItemSlug: 'beta' }),
    ]),
    layer('footer'),
  ]),
];

describe('findRenderedLayers', () => {
  it('returns the layer itself when it survives rendering under its draft id', () => {
    const found = findRenderedLayers(resolved, 'grid');
    assert.equal(found.cloned, false);
    assert.deepEqual(found.layers.map((l) => l.id), ['grid']);
  });

  it('returns every per-item clone of a layer that lives inside a Collection List', () => {
    const cards = findRenderedLayers(resolved, 'card');
    assert.equal(cards.cloned, true);
    assert.deepEqual(cards.layers.map((l) => l.id), ['card-item-a', 'card-item-b']);

    const titles = findRenderedLayers(resolved, 'title');
    assert.deepEqual(titles.layers.map((l) => l.id), ['title-item-a', 'title-item-b']);
  });

  it('does not descend into a clone looking for further clones of the same layer', () => {
    const nested = findRenderedLayers(resolved, 'nested');
    assert.deepEqual(nested.layers.map((l) => l.id), ['nested-item-a', 'nested-item-b']);
  });

  it('returns no layers for ids that rendered nothing', () => {
    const missing = findRenderedLayers(resolved, 'hidden');
    assert.equal(missing.layers.length, 0);
  });

  it('does not treat a similarly prefixed id as a clone', () => {
    const tree = [layer('card-extra'), layer('card')];
    assert.deepEqual(findRenderedLayers(tree, 'card').layers.map((l) => l.id), ['card']);
    assert.equal(findRenderedLayers([layer('cardinal-item-a')], 'card').layers.length, 0);
  });
});

describe('collectItemSlugs', () => {
  it('maps every rendered collection item to its slug, merging into the seed map', () => {
    const slugs = collectItemSlugs(resolved, { z: 'zeta' });
    assert.deepEqual(slugs, { z: 'zeta', a: 'alpha', b: 'beta' });
  });
});

describe('compactHtml', () => {
  it('strips srcset and sizes but keeps src and other attributes', () => {
    const html = '<img class="w-full" src="/a/x.webp?width=1920" srcset="/a/x.webp?width=320 320w, /a/x.webp?width=640 640w" sizes="(max-width: 768px) 100vw, 1600px" alt="Cover" />';
    assert.equal(compactHtml(html), '<img class="w-full" src="/a/x.webp?width=1920" alt="Cover" />');
  });
});
