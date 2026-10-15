/**
 * Cross-page anchor resolution for the HTML import.
 *
 * Marketing sites link to sections with `href="#features"` or `/#features`.
 * That only works on the page holding the id — in a shared navbar component it
 * goes nowhere on every other page. This turns such links into page-plus-anchor
 * links (`type: "page"` + `anchor_layer_id`), which the renderer prints as
 * `/path#id` from any page, so the markup can stay as the designer wrote it.
 */

import { findLayerById } from '@/lib/mcp/utils';

import type { HtmlImportWarning, HtmlUnresolvedAnchor } from '@/lib/html-layer-converter';
import type { Layer, LinkSettings } from '@/types';

export interface AnchorPageSource {
  id: string;
  /** Site path, e.g. "/" or "/pricing". Dynamic pages carry their placeholder and never match. */
  path: string;
  isHomepage: boolean;
  /** Every html id on the page's draft layers. */
  htmlIds: Set<string>;
}

export interface CrossPageAnchorDeps {
  pages: AnchorPageSource[];
  /** The page being imported into, when any. */
  currentPageId?: string;
  /** Html ids inside the imported HTML itself (they land on the current page). */
  localIds: Set<string>;
}

export interface CrossPageAnchorResult {
  layers: Layer[];
  /** Links converted to page + anchor. */
  resolved: Array<{ layerId: string; pageId: string; anchorId: string }>;
  warnings: HtmlImportWarning[];
}

function pageLink(existing: LinkSettings | undefined, pageId: string, anchorId: string): LinkSettings {
  const link: LinkSettings = { ...existing, type: 'page', page: { id: pageId }, anchor_layer_id: anchorId };
  delete link.url;
  return link;
}

function hasId(page: AnchorPageSource, anchorId: string, deps: CrossPageAnchorDeps): boolean {
  return page.htmlIds.has(anchorId) || (page.id === deps.currentPageId && deps.localIds.has(anchorId));
}

/**
 * Mutates the matching layers in `layers` (which may already include the
 * imported ones) and reports what happened.
 */
export function resolveCrossPageAnchors(
  layers: Layer[],
  unresolved: HtmlUnresolvedAnchor[],
  deps: CrossPageAnchorDeps,
): CrossPageAnchorResult {
  const result: CrossPageAnchorResult = { layers, resolved: [], warnings: [] };
  const byPath = new Map(deps.pages.map((page) => [page.path, page] as const));

  for (const entry of unresolved) {
    const layer = findLayerById(layers, entry.layerId);
    if (!layer) continue;
    const href = `${entry.pagePath ?? ''}#${entry.anchorId}`;
    const warn = (message: string) => result.warnings.push({ message, severity: 'warning', path: entry.path, layerId: entry.layerId });

    let target: AnchorPageSource | undefined;
    if (entry.pagePath !== undefined) {
      target = byPath.get(entry.pagePath);
      if (!target) {
        warn(`Link "${href}" points at a page that doesn't exist, so it was kept as a URL. Create the page first, or link with update_layer_link`);
        continue;
      }
      if (!hasId(target, entry.anchorId, deps)) {
        warn(`Link "${href}" targets page "${entry.pagePath}", but nothing there has id "${entry.anchorId}" yet — it scrolls to the top until that id exists`);
      }
    } else {
      const holders = deps.pages.filter((page) => hasId(page, entry.anchorId, deps));
      if (holders.length === 0) {
        warn(`Link "${href}" has no element with id "${entry.anchorId}" in the import or on any page, so it was kept as a URL`);
        continue;
      }
      target = holders.find((page) => page.isHomepage) ?? holders[0];
      if (holders.length > 1) {
        warn(`Link "${href}" matches an id on ${holders.length} pages; it now points at "${target.path}". Use update_layer_link to pick another`);
      }
    }

    layer.variables = { ...layer.variables, link: pageLink(layer.variables?.link, target.id, entry.anchorId) };
    result.resolved.push({ layerId: entry.layerId, pageId: target.id, anchorId: entry.anchorId });
  }

  return result;
}
