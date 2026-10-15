/**
 * Pure helpers for the rendered HTML export. Kept free of repository imports so
 * they can be unit-tested; `rendered-export.ts` wires them to the page pipeline.
 */

import type { Layer } from '@/types';

export interface RenderedLayerMatch {
  layers: Layer[];
  /** True when the draft layer sits inside a Collection List and `layers` are its per-item clones. */
  cloned: boolean;
}

/**
 * The rendered tree no longer contains layers that sit inside a Collection List
 * under their draft id: the list clones them once per item with an
 * "-item-<item id>" suffix. Return the layer itself, or every clone of it.
 */
export function findRenderedLayers(layers: Layer[], layerId: string): RenderedLayerMatch {
  const exact: Layer[] = [];
  const clones: Layer[] = [];
  const prefix = `${layerId}-item-`;
  const walk = (list: Layer[]) => {
    for (const layer of list) {
      if (layer.id === layerId) {
        exact.push(layer);
      } else if (layer.id.startsWith(prefix)) {
        clones.push(layer);
        continue; // nested clones of the same layer live inside this one
      }
      if (layer.children) walk(layer.children);
    }
  };
  walk(layers);
  return exact.length > 0 ? { layers: [exact[0]], cloned: false } : { layers: clones, cloned: true };
}

/** `collection_item_id → slug` for every item the resolved tree rendered (for links to dynamic pages). */
export function collectItemSlugs(layers: Layer[], into: Record<string, string> = {}): Record<string, string> {
  for (const layer of layers) {
    if (layer._collectionItemId && layer._collectionItemSlug) into[layer._collectionItemId] = layer._collectionItemSlug;
    if (layer.children) collectItemSlugs(layer.children, into);
  }
  return into;
}

/** Responsive image candidates are noise when inspecting content; `src` is enough. */
export function compactHtml(html: string): string {
  return html.replace(/\s(?:srcset|sizes)="[^"]*"/g, '');
}
