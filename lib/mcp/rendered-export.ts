/**
 * Renders a draft layer the way the published site will: component instances
 * expanded, Collection Lists repeated with real items, CMS fields filled in,
 * visibility conditions applied and links resolved. Reuses the same server
 * pipeline the live site and the draft preview use (`fetchPageByPath`), so the
 * output matches what publishing would produce.
 */

import { buildAnchorMap, fetchPageByPath, layerToHtml } from '@/lib/page-fetcher';
import { buildDynamicPageUrl, buildSlugPath } from '@/lib/page-utils';
import { getFieldsByCollectionId } from '@/lib/repositories/collectionFieldRepository';
import { getItemsWithValues } from '@/lib/repositories/collectionItemRepository';
import { getAllDraftPageFolders } from '@/lib/repositories/pageFolderRepository';
import { getAllDraftPages, getPageById } from '@/lib/repositories/pageRepository';
import { collectItemSlugs, compactHtml, findRenderedLayers } from '@/lib/mcp/rendered-export-core';

export interface RenderedExportInput {
  pageId: string;
  layerId: string;
  /** Dynamic pages: slug of the item to render. Defaults to the first item. */
  collectionItemSlug?: string;
}

export interface RenderedExport {
  html: string;
  /** Site path that was rendered, e.g. "/blog/hello-world". */
  path: string;
  /** Dynamic pages: the item the page was rendered for. */
  item?: { id: string; slug: string };
  /** Set when the requested layer lives inside a Collection List and its per-item clones were rendered. */
  note?: string;
}

export async function renderLayerHtml(input: RenderedExportInput): Promise<RenderedExport | { error: string }> {
  const page = await getPageById(input.pageId).catch(() => null);
  if (!page) return { error: `Page "${input.pageId}" not found.` };

  const [pages, folders] = await Promise.all([getAllDraftPages(), getAllDraftPageFolders()]);

  let itemSlug: string | undefined;
  if (page.is_dynamic) {
    const collectionId = page.settings?.cms?.collection_id;
    if (!collectionId) return { error: 'This dynamic page is not bound to a collection yet (update_page_settings cms).' };
    if (input.collectionItemSlug) {
      itemSlug = input.collectionItemSlug;
    } else {
      const [fields, { items }] = await Promise.all([
        getFieldsByCollectionId(collectionId),
        getItemsWithValues(collectionId, false, { limit: 1 }),
      ]);
      const slugFieldId = page.settings?.cms?.slug_field_id || fields.find((f) => f.key === 'slug')?.id;
      const first = items[0];
      itemSlug = first && slugFieldId ? first.values[slugFieldId] : undefined;
      if (!itemSlug) return { error: 'The collection has no items with a slug yet, so there is nothing to render. Add an item or pass collection_item_slug.' };
    }
  }

  const path = page.is_dynamic && itemSlug
    ? buildDynamicPageUrl(page, folders, itemSlug)
    : buildSlugPath(page, folders, 'page');
  const data = await fetchPageByPath(path.replace(/^\//, ''), false);
  if (!data) return { error: `Could not render ${path}${itemSlug ? ` (no item with slug "${itemSlug}"?)` : ''}.` };

  const layers = data.pageLayers.layers || [];
  const found = findRenderedLayers(layers, input.layerId);
  if (found.layers.length === 0) {
    return { error: `Layer "${input.layerId}" is not part of the rendered page (hidden layers and empty Collection Lists render nothing).` };
  }

  const slugs = collectItemSlugs(layers, { ...data.pageCollectionSortedItemSlugs });
  if (data.collectionItem && data.collectionFields) {
    const slugField = data.collectionFields.find((f) => f.key === 'slug');
    if (slugField && data.collectionItem.values[slugField.id]) slugs[data.collectionItem.id] = data.collectionItem.values[slugField.id];
  }

  const anchorMap = buildAnchorMap(layers);
  const rawHtml = found.layers
    .map((layer) => layerToHtml(
      layer,
      undefined,
      pages,
      folders,
      slugs,
      data.locale,
      data.translations,
      anchorMap,
      undefined,
      data.collectionItem?.values,
      undefined,
      undefined,
      data.components,
      undefined,
      false,
      {
        pageCollectionItemId: data.collectionItem?.id,
        pageCollectionSortedItemIds: data.pageCollectionSortedItemIds,
        currentPageId: page.id,
      },
    ))
    .join('\n');

  return {
    html: compactHtml(rawHtml),
    path,
    ...(data.collectionItem && itemSlug ? { item: { id: data.collectionItem.id, slug: itemSlug } } : {}),
    ...(found.cloned ? { note: `"${input.layerId}" is inside a Collection List and renders once per item — ${found.layers.length} clone(s) below, ids suffixed with "-item-<item id>".` } : {}),
  };
}
