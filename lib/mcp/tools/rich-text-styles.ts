import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { collectFontFamiliesFromDesign, ensureFontsInstalled, fontWarnings } from '@/lib/mcp/font-install';
import { LAYER_SCOPE_HINT, resolveLayerScope } from '@/lib/mcp/layer-scope';
import { designSchema } from '@/lib/mcp/tools/shared-schemas';
import { applyTextStyleDesign, TEXT_STYLE_KEYS } from '@/lib/mcp/rich-text-styles';
import { findLayerById, updateLayerById } from '@/lib/mcp/utils';
import { DEFAULT_TEXT_STYLES } from '@/lib/text-format-utils';
import type { Layer, TextStyle } from '@/types';

const uiStateEnum = z.enum(['neutral', 'hover', 'focus', 'active']);
const breakpointEnum = z.enum(['desktop', 'tablet', 'mobile']);

const styleUpdateSchema = z.object({
  design: designSchema.describe('Design to merge into this element style (same shape as update_layer_design).'),
  ui_state: uiStateEnum.optional().describe('Scope the design to a state — "hover" for link hover styles.'),
  breakpoint: breakpointEnum.optional().describe('Scope the design to tablet or mobile (desktop by default).'),
});

/** Layers whose rendered rich text takes element styles. */
function acceptsTextStyles(layer: Layer): boolean {
  return layer.name === 'richText' || layer.name === 'text' || layer.name === 'heading';
}

export function registerRichTextStyleTools(server: McpServer) {
  server.tool(
    'update_rich_text_styles',
    `Style the elements INSIDE rich text — every h2, paragraph, list, blockquote, link, image,
table cell… rendered by a richText layer (including CMS rich_text fields bound to it). Use this
instead of custom CSS when headings, lists or links inside long-form / CMS content look unstyled.

Each key is an element or inline mark; its design merges into that element's style and is
written as Tailwind classes, exactly like update_layer_design. Styles are per layer: pass every
richText layer that should share them in layer_ids (or create one richText, style it, and turn
it into a component / style it before duplicating). Keys: ${TEXT_STYLE_KEYS.join(', ')}.

Examples:
- Headings + body: styles: { h2: { design: { typography: { isActive: true, fontSize: "32px", fontWeight: "600", lineHeight: "1.2" }, spacing: { isActive: true, marginTop: "48px", marginBottom: "16px" } } }, paragraph: { design: { typography: { isActive: true, fontSize: "18px", lineHeight: "1.7" }, spacing: { isActive: true, marginBottom: "24px" } } } }
- Links with hover: styles: { link: { design: { typography: { isActive: true, color: "#2563eb", textDecoration: "underline" } } } }, hover_styles: { link: { typography: { isActive: true, color: "#1d4ed8" } } }
- Lists and quotes: styles: { bulletList: { design: { spacing: { isActive: true, paddingLeft: "24px", marginBottom: "24px" } } }, blockquote: { design: { borders: { isActive: true, borderLeftWidth: "3px", borderColor: "#e5e7eb" }, typography: { isActive: true, fontStyle: "italic" } } } }
- Reset to defaults: reset: ["h2", "link"].

${LAYER_SCOPE_HINT}`,
    {
      page_id: z.string().optional().describe('Page containing the rich text layers.'),
      component_id: z.string().optional().describe('Component master containing the rich text layers.'),
      variant_id: z.string().optional().describe('Component variant (only with component_id).'),
      layer_ids: z.array(z.string()).min(1).describe('richText (or text) layers to style. All receive the same element styles.'),
      styles: z.record(z.string(), styleUpdateSchema).optional()
        .describe('Element styles to merge, keyed by element: { h2: { design }, link: { design, ui_state: "hover" }, … }.'),
      hover_styles: z.record(z.string(), designSchema).optional()
        .describe('Shortcut for hover designs keyed by element, e.g. { link: { typography: { isActive: true, color: "#1d4ed8" } } }.'),
      reset: z.array(z.string()).optional().describe('Element keys to reset to Ycode defaults.'),
    },
    async ({ page_id, component_id, variant_id, layer_ids, styles, hover_styles, reset }) => {
      const scope = await resolveLayerScope({ page_id, component_id, variant_id });
      if ('error' in scope) return { content: [{ type: 'text' as const, text: `Error: ${scope.error}` }], isError: true };

      const hasChanges = (styles && Object.keys(styles).length > 0) || (hover_styles && Object.keys(hover_styles).length > 0) || (reset && reset.length > 0);
      if (!hasChanges) return { content: [{ type: 'text' as const, text: 'Error: pass styles, hover_styles, or reset.' }], isError: true };

      const unknownKeys = [...Object.keys(styles ?? {}), ...Object.keys(hover_styles ?? {}), ...(reset ?? [])]
        .filter((key) => !(key in DEFAULT_TEXT_STYLES));
      if (unknownKeys.length > 0) {
        return { content: [{ type: 'text' as const, text: `Error: unknown element key(s) ${unknownKeys.map((k) => `"${k}"`).join(', ')}. Valid keys: ${TEXT_STYLE_KEYS.join(', ')}.` }], isError: true };
      }

      const updates: Array<{ key: string; design: Record<string, Record<string, unknown>>; breakpoint: 'desktop' | 'tablet' | 'mobile'; uiState: 'neutral' | 'hover' | 'focus' | 'active' }> = [];
      for (const [key, update] of Object.entries(styles ?? {})) {
        updates.push({ key, design: update.design as Record<string, Record<string, unknown>>, breakpoint: update.breakpoint ?? 'desktop', uiState: update.ui_state ?? 'neutral' });
      }
      for (const [key, design] of Object.entries(hover_styles ?? {})) {
        updates.push({ key, design: design as Record<string, Record<string, unknown>>, breakpoint: 'desktop', uiState: 'hover' });
      }

      const missing = layer_ids.filter((id) => !findLayerById(scope.layers, id));
      if (missing.length > 0) {
        return { content: [{ type: 'text' as const, text: `Error: layer(s) ${missing.join(', ')} not found in ${scope.label}.` }], isError: true };
      }
      const wrongType = layer_ids.map((id) => findLayerById(scope.layers, id)!).filter((l) => !acceptsTextStyles(l));
      if (wrongType.length > 0) {
        return { content: [{ type: 'text' as const, text: `Error: ${wrongType.map((l) => `"${l.customName || l.name}" (${l.name})`).join(', ')} do not render rich text. Pass richText layers.` }], isError: true };
      }

      let layers = scope.layers;
      const results: Record<string, Record<string, string>> = {};
      for (const layerId of layer_ids) {
        layers = updateLayerById(layers, layerId, (layer) => {
          // The editor seeds the full default set on first edit so every key is explicit.
          const textStyles: Record<string, TextStyle> = { ...DEFAULT_TEXT_STYLES, ...layer.textStyles };
          for (const key of reset ?? []) textStyles[key] = { ...DEFAULT_TEXT_STYLES[key] };
          for (const update of updates) {
            textStyles[update.key] = applyTextStyleDesign(textStyles[update.key], update.design, update.breakpoint, update.uiState);
          }
          results[layerId] = Object.fromEntries(
            [...new Set([...updates.map((u) => u.key), ...(reset ?? [])])].map((key) => [key, textStyles[key].classes ?? '']),
          );
          return { ...layer, textStyles };
        });
      }
      await scope.save(layers);

      const fontFamilies = new Set<string>();
      for (const update of updates) collectFontFamiliesFromDesign(update.design, fontFamilies);
      const fonts = await ensureFontsInstalled(fontFamilies);
      const warnings = fontWarnings(fonts);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Updated rich text element styles on ${layer_ids.length} layer(s) in ${scope.label}`,
            element_classes: results,
            fonts_auto_installed: fonts.installed.length > 0 ? fonts.installed : undefined,
            design_warnings: warnings.length > 0 ? warnings : undefined,
          }),
        }],
      };
    },
  );
}
