import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { broadcastComponentCreated, broadcastComponentLayersUpdated } from '@/lib/mcp/broadcast';
import { lintDesign } from '@/lib/mcp/design-lint';
import { collectFontFamiliesFromDesign, ensureFontsInstalled, fontWarnings } from '@/lib/mcp/font-install';
import { extractMarkedComponents } from '@/lib/mcp/html-import-components';
import type { ImportedComponent } from '@/lib/mcp/html-import-components';
import { resolveCrossPageLinks } from '@/lib/mcp/html-import-links';
import type { LinkPageSource } from '@/lib/mcp/html-import-links';
import { applyCmsMarks, applyToggleMarks } from '@/lib/mcp/html-import-marks';
import type { ImportedCollectionList, ImportedToggle } from '@/lib/mcp/html-import-marks';
import { getCachedLayers, saveCachedLayers } from '@/lib/mcp/page-layers';
import { canHaveChildren, findLayerById, generateId, insertLayer, removeLayer } from '@/lib/mcp/utils';
import { getFieldsByCollectionId } from '@/lib/repositories/collectionFieldRepository';
import { getAllCollections } from '@/lib/repositories/collectionRepository';
import { createComponent, getAllComponents, getComponentById, updateComponent } from '@/lib/repositories/componentRepository';
import { getAllDraftPageFolders } from '@/lib/repositories/pageFolderRepository';
import { getAllDraftLayers } from '@/lib/repositories/pageLayersRepository';
import { getAllDraftPages, getAllPages, getPageById } from '@/lib/repositories/pageRepository';
import { htmlToLayersOnServer } from '@/lib/server/html-to-layers';
import { buildSlugPath } from '@/lib/page-utils';
import type { HtmlImportSeverity, HtmlImportWarning } from '@/lib/html-layer-converter';
import type { ComponentVariant, Layer } from '@/types';

const MAX_HTML_LENGTH = 200_000;
const MAX_WARNING_GROUPS = 60;
const MAX_LAYER_IDS_PER_WARNING = 5;

const SEVERITY_ORDER: Record<HtmlImportSeverity, number> = { error: 0, warning: 1, hint: 2 };

interface WarningGroup {
  severity: HtmlImportSeverity;
  message: string;
  count: number;
  layer_ids?: string[];
  paths: string[];
}

/** Collapse repeated warnings (e.g. one class used on many layers) into one entry each. */
function groupWarnings(warnings: HtmlImportWarning[]): { groups: WarningGroup[]; omitted: number } {
  const byMessage = new Map<string, WarningGroup>();
  for (const w of warnings) {
    let group = byMessage.get(w.message);
    if (!group) {
      group = { severity: w.severity ?? 'warning', message: w.message, count: 0, paths: [] };
      byMessage.set(w.message, group);
    }
    group.count++;
    if (w.layerId && (group.layer_ids?.length ?? 0) < MAX_LAYER_IDS_PER_WARNING) {
      group.layer_ids = [...(group.layer_ids ?? []), w.layerId];
    }
    if (group.paths.length < 2) group.paths.push(w.path);
  }
  // Errors first, so truncation drops hints before anything that lost content.
  const groups = [...byMessage.values()].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return {
    groups: groups.slice(0, MAX_WARNING_GROUPS),
    omitted: Math.max(0, groups.length - MAX_WARNING_GROUPS),
  };
}

/**
 * Every draft page with its path and html ids, for pointing `/path` links at
 * the page with that path and `#id` links at the page that holds the id. The
 * page being imported into uses the in-memory tree.
 */
async function loadLinkPageSources(currentPageId: string | undefined, currentTree: Layer[]): Promise<LinkPageSource[]> {
  const [pages, folders, allLayers] = await Promise.all([getAllDraftPages(), getAllDraftPageFolders(), getAllDraftLayers()]);
  const layersByPage = new Map(allLayers.map((row) => [row.page_id, row.layers ?? []] as const));
  return pages
    .filter((page) => !page.error_page)
    .map((page) => ({
      id: page.id,
      path: buildSlugPath(page, folders, 'page'),
      isHomepage: Boolean(page.is_index && !page.page_folder_id),
      htmlIds: collectHtmlIds(page.id === currentPageId ? currentTree : (layersByPage.get(page.id) ?? [])),
    }));
}

function countLayers(layers: Layer[]): number {
  return layers.reduce((sum, l) => sum + 1 + countLayers(l.children ?? []), 0);
}

function collectFontFamilies(layers: Layer[], into: Set<string>): void {
  for (const layer of layers) {
    collectFontFamiliesFromDesign(layer.design as Record<string, unknown> | undefined, into);
    if (layer.children) collectFontFamilies(layer.children, into);
  }
}

/**
 * Insert `newLayers` under `parentId` (or at the tree root when it is undefined),
 * keeping their order. Returns an error message instead when the parent is invalid.
 */
function insertLayers(
  tree: Layer[],
  parentId: string | undefined,
  newLayers: Layer[],
  position: number | undefined,
): Layer[] | string {
  if (!parentId) {
    const result = [...tree];
    result.splice(position ?? result.length, 0, ...newLayers);
    return result;
  }

  const parent = findLayerById(tree, parentId);
  if (!parent) return `Parent "${parentId}" not found.`;
  if (!canHaveChildren(parent)) return `"${parent.customName || parent.name}" cannot have children.`;

  const start = position ?? (parent.children?.length ?? 0);
  return newLayers.reduce(
    (acc, layer, i) => insertLayer(acc, parentId, layer, start + i),
    tree,
  );
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/** Html ids (the anchor targets links point at) used anywhere in the tree. */
function collectHtmlIds(layers: Layer[], into = new Set<string>()): Set<string> {
  for (const layer of layers) {
    const htmlId = layer.settings?.id || layer.attributes?.id;
    if (typeof htmlId === 'string' && htmlId) into.add(htmlId);
    if (layer.children) collectHtmlIds(layer.children, into);
  }
  return into;
}

/** Parent id (undefined at the tree root) and index of a layer, or null when it isn't in the tree. */
function findPlacement(
  layers: Layer[],
  id: string,
  parentId?: string,
): { parentId: string | undefined; index: number } | null {
  for (let i = 0; i < layers.length; i++) {
    if (layers[i].id === id) return { parentId, index: i };
    const found = findPlacement(layers[i].children ?? [], id, layers[i].id);
    if (found) return found;
  }
  return null;
}

export function registerHtmlImportTools(server: McpServer) {
  server.tool(
    'import_html',
    `Import HTML with Tailwind classes as native, editable Ycode layers in one call (see https://docs.ycode.com).
The HTML is parsed on the server and converted to layers; it is not sent to any external API and the URLs in it are not requested. The only outside lookup is installing Google Fonts named in the classes (see FONTS).
Use ONLY when the user asks for HTML import or provides HTML/Tailwind markup. Otherwise build with
add_layout and the layer tools (add_layer, batch_operations, update_layer_design).

CLASSES: both mobile-first ("sm:"/"md:"/"lg:") and desktop-first (unprefixed = desktop, "max-lg:" =
tablet, "max-md:" = mobile) Tailwind work. Mobile-first classes are converted to desktop-first
automatically ("flex-col md:flex-row" → "flex-row max-md:flex-col"); without an unprefixed value the
mobile value is the CSS default ("md:col-span-2" → "col-span-2 max-md:col-span-1"). Only font and color
classes need an explicit base value; otherwise they stay raw and are reported. "xl:"/"2xl:" have no
Ycode breakpoint and stay raw. v4 gradients (bg-linear-to-* + from/via/to), inset-*/top-*, and italic
convert to editable design too. Reference color variables as "bg-[var(--<id>)]" / "text-[var(--<id>)]".

FONTS: Google Fonts used via font-['Family_Name'] are installed automatically (see
fonts_auto_installed in the response) — no add_font call needed.

IMAGES: need absolute https URLs (or upload_asset first, then update_layer_image).

STRUCTURE: every element becomes a layer, except inline tags (a, span, strong, …) inside running
text, which merge into the text as rich-text marks and lose their classes. Inline elements that are
the only content of their parent stay separate layers when they have their own classes or the
parent is flex/grid (nav links, button rows, pills).

LINKS: href="/pricing" becomes a page link to the page at that path, so it survives slug changes;
paths with no page (CMS item URLs, pages not built yet) stay URLs with a hint. href="#id" becomes
a native anchor link when an element with that id is in the HTML or already on the page.
Otherwise, and for "/#id" or "/pricing#plans", it becomes a page + anchor link to the page holding
that id (so a shared navbar scrolls correctly from every page). "page_links" in the response
counts the hrefs converted this way.

REFS: elements with an id or data-ref="name" are returned in "refs" as { name: layer_id }, so you
can target them afterwards without get_layers. data-ref is not kept on the layer. header, footer, nav,
main, aside and section elements without one are returned by tag in document order: the first
<section> is "section", the third "section[3]".

COMPONENTS (page imports only): data-ycode-component="Name" on an element creates a component from
it and leaves an instance in its place. Returned in "components" as
{ Name: { component_id, created, instance_layer_ids, refs } } — refs inside the component point at
master layers; edit them with update_component_layers. A name that matches an existing component, or
repeats within the HTML, becomes another instance of it (its own markup is discarded), so mark one
copy and give per-instance content through component variables afterwards.

MOBILE MENU: data-ycode-toggle="menu" on the menu button plus data-ycode-menu="menu" on the panel
creates the native click interaction (yoyo, display hidden→visible, applied on load) that shows and
hides the panel — the same pattern as the navigation-001 layout. The breakpoints come from the
markup: a panel with "max-lg:hidden" (or "hidden lg:flex") toggles on tablet + mobile, "max-md:hidden"
on mobile only, no hidden class at all on every breakpoint. Never write <script> toggles.

CMS (page imports only): mark the ONE repeated item with data-ycode-collection="Collection name or
id" — that element becomes the Collection List, cloned once per item, so keep the grid/flex layout on
its parent. Optional data-ycode-limit="6", data-ycode-sort="Field:desc" (or manual/random) and
data-ycode-filter="Field=value; Other!=value". Inside it, data-ycode-field="Field name" on a text,
heading, image, video, or link element binds that field (image alt: data-ycode-field-alt, background
image: data-ycode-field-bg), and data-ycode-link="item" on a card or button links to the
collection's dynamic page. Mark the other static copies with data-ycode-preview-only so they are
dropped. On a dynamic page, data-ycode-field outside any collection binds the page's own item.
The collection must already exist (create_collection + add_collection_field first); unresolved
names or fields are reported and left static. Results are returned in "cms".

ITERATING: pass replace_layer_id to swap an existing layer (e.g. a section you imported earlier) for
the new HTML in one atomic step, at the same position. Pass dry_run: true to get the layer count and
warnings without changing anything. Import large pages section by section.

Returns the ids of the created top-level layers plus warnings for anything dropped or converted
lossily, each with a severity: "error" = content or a binding was lost (fix it), "warning" =
converted or approximated (check it), "hint" = renders as written but has no design-panel control
(fine to leave). Component variables, other animations, and form settings are not expressible in
HTML; add them afterwards with their tools.`,
    {
      page_id: z.string().optional().describe('Page to import into. Provide page_id or component_id.'),
      component_id: z.string().optional().describe('Component to import into (its primary variant unless variant_id is set).'),
      variant_id: z.string().optional().describe('Component variant to import into. Only with component_id.'),
      parent_layer_id: z.string().optional()
        .describe('Parent layer ID. Defaults to the page body; for components, the component root.'),
      position: z.number().int().min(0).optional().describe('Index within the parent. Omit to append at the end.'),
      replace_layer_id: z.string().optional()
        .describe('Layer to replace with the imported layers, at the same position. Not combinable with parent_layer_id/position.'),
      dry_run: z.boolean().optional()
        .describe('Convert and report layer count, warnings and refs without saving anything.'),
      html: z.string().min(1).max(MAX_HTML_LENGTH)
        .describe('HTML with Tailwind classes: one section or a full page body.'),
    },
    async ({ page_id, component_id, variant_id, parent_layer_id, position, replace_layer_id, dry_run, html }) => {
      if (!page_id === !component_id) {
        return errorResult('Provide exactly one of page_id or component_id.');
      }
      if (replace_layer_id && (parent_layer_id || position !== undefined)) {
        return errorResult('replace_layer_id already sets the position; omit parent_layer_id and position.');
      }

      let tree: Layer[];
      let target: string;
      let saveTree: (layers: Layer[]) => Promise<void>;

      if (page_id) {
        tree = await getCachedLayers(page_id);
        target = `page ${page_id}`;
        saveTree = async (layers) => {
          await saveCachedLayers(page_id, layers);
        };
      } else {
        const component = await getComponentById(component_id!);
        if (!component) return errorResult(`Component "${component_id}" not found.`);

        const variants: ComponentVariant[] = component.variants && component.variants.length > 0
          ? component.variants
          : [{ id: generateId(), name: 'Default', layers: component.layers || [] }];
        const idx = variant_id ? variants.findIndex((v) => v.id === variant_id) : 0;
        if (idx === -1) return errorResult(`Variant "${variant_id}" not found.`);

        tree = variants[idx].layers || [];
        target = `component "${component.name}"`;
        saveTree = async (layers) => {
          const updatedVariants = variants.map((v, i) => (i === idx ? { ...v, layers } : v));
          await updateComponent(component_id!, { variants: updatedVariants });
          broadcastComponentLayersUpdated(component_id!, updatedVariants[0].layers).catch(() => {});
        };
      }

      let parentId = parent_layer_id;
      let insertAt = position;
      let baseTree = tree;

      if (replace_layer_id) {
        const placement = findPlacement(tree, replace_layer_id);
        if (!placement) return errorResult(`Layer "${replace_layer_id}" not found in ${target}.`);
        const replaced = findLayerById(tree, replace_layer_id);
        if (replaced?.name === 'body' || replaced?.id === 'body') {
          return errorResult('The page body cannot be replaced; replace its sections instead.');
        }
        parentId = placement.parentId;
        insertAt = placement.index;
        baseTree = removeLayer(tree, replace_layer_id);
      } else if (page_id) {
        parentId ??= tree.find((l) => l.id === 'body' || l.name === 'body')?.id;
      }

      const converted = htmlToLayersOnServer(html, {
        anchorIds: collectHtmlIds(baseTree),
      });
      const { warnings, componentMarks, ycodeMarks } = converted;
      if (converted.layers.length === 0) {
        return errorResult('The HTML produced no layers. Check that it contains elements inside <body> (or is a plain fragment).');
      }

      const cmsMarks = ycodeMarks.filter((m) => m.kind === 'collection' || m.kind === 'field' || m.kind === 'item-link');
      if (cmsMarks.length > 0 && !page_id) {
        for (const mark of cmsMarks) {
          warnings.push({ message: 'data-ycode-collection / -field / -link only work when importing into a page; ignored', severity: 'error', path: mark.path, layerId: mark.layerId });
        }
      }

      // Menu toggles are pure layer data, so they apply before component extraction
      // (the interaction then lives inside the navbar component's master).
      let toggles: ImportedToggle[] = [];
      if (ycodeMarks.some((m) => m.kind === 'toggle' || m.kind === 'menu')) {
        const toggled = applyToggleMarks(converted.layers, ycodeMarks);
        converted.layers = toggled.layers;
        toggles = toggled.toggles;
        warnings.push(...toggled.warnings);
      }

      // "/path" and "#id" links to other pages become page (+ anchor) links, so
      // they survive slug changes and a navbar that turns into a shared component
      // keeps working on every page. Pure layer data, so it runs before
      // component extraction.
      let pageLinksResolved = 0;
      if (converted.unresolvedLinks.length > 0) {
        const sources = await loadLinkPageSources(page_id, baseTree);
        const linked = resolveCrossPageLinks(converted.layers, converted.unresolvedLinks, {
          pages: sources,
          currentPageId: page_id,
          localIds: collectHtmlIds(converted.layers),
        });
        converted.layers = linked.layers;
        pageLinksResolved = linked.resolved.length;
        warnings.push(...linked.warnings);
      }

      if (componentMarks.length > 0 && !page_id) {
        for (const mark of componentMarks) {
          warnings.push({ message: 'data-ycode-component only works when importing into a page; ignored', severity: 'error', path: mark.path, layerId: mark.layerId });
        }
      }
      const extractComponents = componentMarks.length > 0 && !!page_id && !dry_run;

      const fontFamilies = new Set<string>();
      collectFontFamilies(converted.layers, fontFamilies);
      const total = countLayers(converted.layers);
      const topLevelCount = converted.layers.length;

      if (dry_run) {
        const updated = insertLayers(baseTree, parentId, converted.layers, insertAt);
        if (typeof updated === 'string') return errorResult(updated);
        const { groups, omitted } = groupWarnings(warnings);
        const refKeys = Object.keys(converted.refs);
        const componentNames = page_id ? [...new Set(componentMarks.map((m) => m.name))] : [];
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              message: `Dry run: would import ${topLevelCount} top-level layer(s) (${total} total) into ${target}${replace_layer_id ? `, replacing ${replace_layer_id}` : ''}. Nothing was saved.`,
              ref_names: refKeys.length > 0 ? refKeys : undefined,
              component_names: componentNames.length > 0 ? componentNames : undefined,
              menu_toggles: toggles.length > 0 ? toggles.length : undefined,
              page_links: pageLinksResolved > 0 ? pageLinksResolved : undefined,
              cms_marks: page_id && cmsMarks.length > 0 ? cmsMarks.length : undefined,
              warning_count: warnings.length,
              warnings: groups.length > 0 ? groups : undefined,
              warnings_omitted: omitted > 0 ? omitted : undefined,
            }),
          }],
        };
      }

      let imported = converted.layers;
      let refs = converted.refs;
      let components: Record<string, ImportedComponent> = {};
      if (extractComponents) {
        // Validate the placement before creating components, so a bad parent doesn't leave orphans.
        const check = insertLayers(baseTree, parentId, imported, insertAt);
        if (typeof check === 'string') return errorResult(check);

        const existing = await getAllComponents();
        const extraction = await extractMarkedComponents(imported, componentMarks, refs, existing, async (name, layers) => {
          const component = await createComponent({ name, layers });
          broadcastComponentCreated(component).catch(() => {});
          return component.id;
        });
        imported = extraction.layers;
        refs = extraction.refs;
        components = extraction.components;
        warnings.push(...extraction.warnings);
      }

      let updated = insertLayers(baseTree, parentId, imported, insertAt);
      if (typeof updated === 'string') return errorResult(updated);

      let cms: { collection_lists: ImportedCollectionList[]; fields_bound: number; item_links: number } | undefined;
      if (page_id && cmsMarks.length > 0) {
        const page = await getPageById(page_id);
        const applied = await applyCmsMarks(updated, cmsMarks, {
          getCollections: () => getAllCollections({ deleted: false }),
          getFields: (collectionId) => getFieldsByCollectionId(collectionId),
          getPages: () => getAllPages({ is_published: false }),
          pageCollectionId: page?.is_dynamic ? page.settings?.cms?.collection_id : undefined,
        });
        updated = applied.layers;
        warnings.push(...applied.warnings);
        cms = { collection_lists: applied.collection_lists, fields_bound: applied.fields_bound, item_links: applied.item_links };
      }

      await saveTree(updated);

      const { groups, omitted } = groupWarnings(warnings);
      const refKeys = Object.keys(refs);
      const fonts = await ensureFontsInstalled(fontFamilies);
      // Lint the imported subtree (hover states, collection lists, mobile nav, structure)
      // the same way batch_operations does, so problems surface before publishing.
      const designWarnings = [...fontWarnings(fonts), ...lintDesign(updated, new Set(imported.map((l) => l.id)))];

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Imported ${topLevelCount} top-level layer(s) (${total} total) into ${target}${replace_layer_id ? `, replacing ${replace_layer_id}` : ''}`,
            layer_ids: imported.map((l) => l.id),
            parent_layer_id: parentId ?? null,
            refs: refKeys.length > 0 ? refs : undefined,
            components: Object.keys(components).length > 0 ? components : undefined,
            menu_toggles: toggles.length > 0 ? toggles : undefined,
            page_links: pageLinksResolved > 0 ? pageLinksResolved : undefined,
            cms,
            warning_count: warnings.length,
            warnings: groups.length > 0 ? groups : undefined,
            warnings_omitted: omitted > 0 ? omitted : undefined,
            fonts_auto_installed: fonts.installed.length > 0 ? fonts.installed : undefined,
            design_warnings: designWarnings.length > 0 ? designWarnings : undefined,
          }),
        }],
      };
    },
  );
}
