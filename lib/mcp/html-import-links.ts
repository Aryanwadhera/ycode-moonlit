/**
 * Cross-page link resolution for the HTML import.
 *
 * Marketing sites link to pages with `href="/pricing"` and to sections with
 * `href="#features"` or `/#features`. A URL link breaks when the page's slug
 * changes, and an anchor only works on the page holding the id — in a shared
 * navbar component it goes nowhere on every other page. This turns such links
 * into page links (`type: "page"`, plus `anchor_layer_id` for anchors), which
 * the renderer prints as `/path` or `/path#id` from any page, so the markup can
 * stay as the designer wrote it.
 */

import { findLayerById } from '@/lib/mcp/utils';

import type { HtmlImportWarning, HtmlUnresolvedLink } from '@/lib/html-layer-converter';
import type { Layer, LinkSettings } from '@/types';

export interface LinkPageSource {
  id: string;
  /** Site path, e.g. "/" or "/pricing". Dynamic pages carry their placeholder and never match. */
  path: string;
  isHomepage: boolean;
  /** Every html id on the page's draft layers. */
  htmlIds: Set<string>;
}

export interface CrossPageLinkDeps {
  pages: LinkPageSource[];
  /** The page being imported into, when any. */
  currentPageId?: string;
  /** Html ids inside the imported HTML itself (they land on the current page). */
  localIds: Set<string>;
}

export interface CrossPageLinkResult {
  layers: Layer[];
  /** Links converted to a page link (with `anchorId` when the href had a hash). */
  resolved: Array<{ layerId: string; pageId: string; anchorId?: string }>;
  warnings: HtmlImportWarning[];
}

function pageLink(existing: LinkSettings | undefined, pageId: string, anchorId: string | undefined): LinkSettings {
  const link: LinkSettings = { ...existing, type: 'page', page: { id: pageId } };
  delete link.url;
  delete link.anchor_layer_id;
  if (anchorId !== undefined) link.anchor_layer_id = anchorId;
  return link;
}

function hasId(page: LinkPageSource, anchorId: string, deps: CrossPageLinkDeps): boolean {
  return page.htmlIds.has(anchorId) || (page.id === deps.currentPageId && deps.localIds.has(anchorId));
}

/**
 * Mutates the matching layers in `layers` (which may already include the
 * imported ones) and reports what happened.
 */
export function resolveCrossPageLinks(
  layers: Layer[],
  unresolved: HtmlUnresolvedLink[],
  deps: CrossPageLinkDeps,
): CrossPageLinkResult {
  const result: CrossPageLinkResult = { layers, resolved: [], warnings: [] };
  const byPath = new Map(deps.pages.map((page) => [page.path, page] as const));

  for (const entry of unresolved) {
    const layer = findLayerById(layers, entry.layerId);
    if (!layer) continue;
    const { anchorId, pagePath } = entry;
    const href = `${pagePath ?? ''}${anchorId !== undefined ? `#${anchorId}` : ''}`;
    const warn = (message: string, severity: HtmlImportWarning['severity'] = 'warning') =>
      result.warnings.push({ message, severity, path: entry.path, layerId: entry.layerId });

    let target: LinkPageSource | undefined;
    if (pagePath !== undefined) {
      target = byPath.get(pagePath);
      if (!target) {
        // A plain path may be a CMS item URL (/blog/my-post) or a page still to be
        // built; the URL renders fine either way, so only hint.
        const severity = anchorId === undefined ? 'hint' : 'warning';
        warn(`Link "${href}" points at a page that doesn't exist, so it was kept as a URL. Create the page first, or link with update_layer_link`, severity);
        continue;
      }
      if (anchorId !== undefined && !hasId(target, anchorId, deps)) {
        warn(`Link "${href}" targets page "${pagePath}", but nothing there has id "${anchorId}" yet — it scrolls to the top until that id exists`);
      }
    } else if (anchorId !== undefined) {
      const holders = deps.pages.filter((page) => hasId(page, anchorId, deps));
      if (holders.length === 0) {
        warn(`Link "${href}" has no element with id "${anchorId}" in the import or on any page, so it was kept as a URL`);
        continue;
      }
      target = holders.find((page) => page.isHomepage) ?? holders[0];
      if (holders.length > 1) {
        warn(`Link "${href}" matches an id on ${holders.length} pages; it now points at "${target.path}". Use update_layer_link to pick another`);
      }
    } else {
      continue;
    }

    layer.variables = { ...layer.variables, link: pageLink(layer.variables?.link, target.id, anchorId) };
    result.resolved.push({ layerId: entry.layerId, pageId: target.id, ...(anchorId !== undefined ? { anchorId } : {}) });
  }

  return result;
}
