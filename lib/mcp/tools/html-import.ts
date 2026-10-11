import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { broadcastComponentLayersUpdated } from '@/lib/mcp/broadcast';
import { collectFontFamiliesFromDesign, ensureFontsInstalled, fontWarnings } from '@/lib/mcp/font-install';
import { getCachedLayers, saveCachedLayers } from '@/lib/mcp/page-layers';
import { canHaveChildren, findLayerById, generateId, insertLayer, removeLayer } from '@/lib/mcp/utils';
import { getComponentById, updateComponent } from '@/lib/repositories/componentRepository';
import { htmlToLayersOnServer } from '@/lib/server/html-to-layers';
import type { HtmlImportWarning } from '@/lib/html-layer-converter';
import type { ComponentVariant, Layer } from '@/types';

const MAX_HTML_LENGTH = 200_000;
const MAX_WARNING_GROUPS = 60;
const MAX_LAYER_IDS_PER_WARNING = 5;

interface WarningGroup {
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
      group = { message: w.message, count: 0, paths: [] };
      byMessage.set(w.message, group);
    }
    group.count++;
    if (w.layerId && (group.layer_ids?.length ?? 0) < MAX_LAYER_IDS_PER_WARNING) {
      group.layer_ids = [...(group.layer_ids ?? []), w.layerId];
    }
    if (group.paths.length < 2) group.paths.push(w.path);
  }
  const groups = [...byMessage.values()];
  return {
    groups: groups.slice(0, MAX_WARNING_GROUPS),
    omitted: Math.max(0, groups.length - MAX_WARNING_GROUPS),
  };
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
    `Import HTML with Tailwind classes as native, editable Ycode layers in one call.
Use ONLY when the user asks for HTML import or provides HTML/Tailwind markup. Otherwise build with
add_layout and the layer tools (add_layer, batch_operations, update_layer_design).

Prefer desktop-first classes: unprefixed for desktop, "max-lg:" for tablet, "max-md:" for mobile.
Mobile-first "sm:"/"md:"/"lg:" classes are converted automatically when the same property also has
an unprefixed value ("flex-col md:flex-row" → "flex-row max-md:flex-col"); the rest stay raw and
are reported. v4 gradients (bg-linear-to-* + from/via/to) and inset-*/top-* values are converted to
editable design too. Reference color variables as
"bg-[var(--<id>)]" / "text-[var(--<id>)]". Images need absolute https URLs (or upload_asset first,
then update_layer_image).

STRUCTURE: every element becomes a layer, except inline tags (a, span, strong, …) inside running
text, which merge into the text as rich-text marks and lose their classes. Inline elements that are
the only content of their parent stay separate layers when they have their own classes or the
parent is flex/grid (nav links, button rows, pills).

LINKS: href="#id" becomes a native anchor link when an element with that id is in the HTML or
already on the page.

REFS: elements with an id or data-ref="name" are returned in "refs" as { name: layer_id }, so you
can target them afterwards without get_layers. data-ref is not kept on the layer.

ITERATING: pass replace_layer_id to swap an existing layer (e.g. a section you imported earlier) for
the new HTML in one atomic step, at the same position. Pass dry_run: true to get the layer count and
warnings without changing anything. Import large pages section by section.

Returns the ids of the created top-level layers plus warnings for anything dropped or converted
lossily (attributes, unknown tags, relative media, classes without a design-panel control). Fix
those with the layer tools. CMS bindings, components, animations, and form settings are not
expressible in HTML; add them afterwards with their tools.`,
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

      const { layers: imported, warnings, refs } = htmlToLayersOnServer(html, {
        anchorIds: collectHtmlIds(baseTree),
      });
      if (imported.length === 0) {
        return errorResult('The HTML produced no layers. Check that it contains elements inside <body> (or is a plain fragment).');
      }

      const updated = insertLayers(baseTree, parentId, imported, insertAt);
      if (typeof updated === 'string') return errorResult(updated);

      const { groups, omitted } = groupWarnings(warnings);
      const total = countLayers(imported);
      const refKeys = Object.keys(refs);

      if (dry_run) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              message: `Dry run: would import ${imported.length} top-level layer(s) (${total} total) into ${target}${replace_layer_id ? `, replacing ${replace_layer_id}` : ''}. Nothing was saved.`,
              ref_names: refKeys.length > 0 ? refKeys : undefined,
              warning_count: warnings.length,
              warnings: groups.length > 0 ? groups : undefined,
              warnings_omitted: omitted > 0 ? omitted : undefined,
            }),
          }],
        };
      }

      await saveTree(updated);

      const fontFamilies = new Set<string>();
      collectFontFamilies(imported, fontFamilies);
      const fonts = await ensureFontsInstalled(fontFamilies);
      const designWarnings = fontWarnings(fonts);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Imported ${imported.length} top-level layer(s) (${total} total) into ${target}${replace_layer_id ? `, replacing ${replace_layer_id}` : ''}`,
            layer_ids: imported.map((l) => l.id),
            parent_layer_id: parentId ?? null,
            refs: refKeys.length > 0 ? refs : undefined,
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
