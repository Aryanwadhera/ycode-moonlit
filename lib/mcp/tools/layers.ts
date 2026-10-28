import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DesignProperties, Layer } from '@/types';
import {
  findLayerById,
  updateLayerById,
  insertLayer,
  removeLayer,
  moveLayer as moveLayerInTree,
  canHaveChildren,
  createLayerFromTemplate,
  getTiptapTextContent,
  buildTiptapDoc,
  applyDesignToLayer,
  applyBackgroundImage,
  applyImageUpdate,
  applyLayerSettings,
  buildLinkSettings,
  defaultDynamicPageItem,
  describeLink,
  resolveLinkAnchor,
} from '@/lib/mcp/utils';
import type { LinkInput, RichTextBlock } from '@/lib/mcp/utils';
import { buildAssetUrlMap, collectLayerAssetIds } from '@/lib/asset-utils';
import { layerToExportHtml } from '@/lib/html-layer-converter';
import { findLayersWithAnchorId } from '@/lib/layer-utils';
import { getAssetsByIds } from '@/lib/repositories/assetRepository';
import { renderLayerHtml } from '@/lib/mcp/rendered-export';
import { getComponentNames } from '@/lib/repositories/componentRepository';
import { getAllDraftPageFolders } from '@/lib/repositories/pageFolderRepository';
import { getAllDraftPages, getPageById } from '@/lib/repositories/pageRepository';
import { collectFontFamiliesFromDesign, ensureFontsInstalled, fontWarnings } from '@/lib/mcp/font-install';
import { hasComponentInstances, hasLayerQuery, labelComponentInstances, MAX_SEARCH_MATCHES, queryLayers } from '@/lib/mcp/layer-query';
import { getCachedLayers as getPageLayers, saveCachedLayers } from '@/lib/mcp/page-layers';
import { designSchema, richTextBlockSchema, templateEnum } from './shared-schemas';

async function savePageLayers(pageId: string, layers: Layer[]): Promise<void> {
  await saveCachedLayers(pageId, layers);
}

export function registerLayerTools(server: McpServer) {
  server.tool(
    'get_layers',
    `Get the layer tree for a page. With only page_id, returns every layer with its design
properties, text content, children, and settings.

On large pages, read in pieces instead of fetching everything:
- fields: "summary" returns only id, name, customName, html_id, tag, text, link, classes, componentId
- depth: levels of children to include (0 = just the layers themselves); deeper levels become
  children_count
- layer_id: return only that layer's subtree
- search: case-insensitive match on id, name, html id, classes, or text; returns up to
  ${MAX_SEARCH_MATCHES} matches with their parent_id and path (children excluded unless depth is set)

Typical flow: fields "summary" + depth 2 for an overview, then layer_id for the section you edit.`,
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().optional().describe('Return only this layer and its descendants'),
      depth: z.number().int().min(0).optional().describe('Levels of children to include below each returned layer'),
      search: z.string().optional().describe('Find layers whose id, name, html id, classes, or text contain this'),
      fields: z.enum(['full', 'summary']).optional().describe('"summary" for a compact view; default "full"'),
    },
    async ({ page_id, layer_id, depth, search, fields }) => {
      let layers = await getPageLayers(page_id);
      if (hasComponentInstances(layers)) {
        layers = labelComponentInstances(layers, await getComponentNames());
      }
      const query = { layerId: layer_id, depth, search, fields };
      if (!hasLayerQuery(query)) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(layers) }] };
      }
      const result = queryLayers(layers, query);
      if ('error' in result) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'add_layer',
    `Add a new element to a page.

ELEMENT TYPES:
- Structure: div, section, container, hr
- Content: heading (h1), text (paragraph), richText (rich text block with formatting)
- Media: image, video, audio, icon, iframe
- Actions: button
- Forms: form, input, textarea, select, checkbox, radio, label — native, ready-to-use fields.
  The "form" template arrives pre-populated with native fields, a submit button, and alerts.
- Utilities: htmlEmbed, slider, lightbox

FORMS:
- ALWAYS build forms from these native form elements. NEVER simulate inputs/fields with
  div, styled text, or htmlEmbed — only native fields are wired for submission and editing.

NESTING RULES:
- Leaf elements (image, text, input, video, icon, etc.) CANNOT have children
- Sections cannot contain other sections`,
    {
      page_id: z.string().describe('The page ID'),
      parent_layer_id: z.string().describe('ID of the parent layer to insert into'),
      position: z.number().optional().describe('Index within parent children. Omit to append at end.'),
      template: templateEnum.describe('Element template to create'),
      text_content: z.string().optional().describe('For text/heading/button/richText: plain display text'),
      rich_content: z.array(richTextBlockSchema).optional()
        .describe('For richText: structured content blocks. Overrides text_content.'),
      custom_name: z.string().optional().describe('Custom display name for the layer'),
    },
    async ({ page_id, parent_layer_id, position, template, text_content, rich_content, custom_name }) => {
      const layers = await getPageLayers(page_id);

      const parent = findLayerById(layers, parent_layer_id);
      if (!parent) {
        return { content: [{ type: 'text' as const, text: `Error: Parent layer "${parent_layer_id}" not found.` }], isError: true };
      }
      if (!canHaveChildren(parent)) {
        return { content: [{ type: 'text' as const, text: `Error: "${parent.customName || parent.name}" cannot have children.` }], isError: true };
      }
      if (parent.name === 'section' && template === 'section') {
        return { content: [{ type: 'text' as const, text: 'Error: Sections cannot contain other sections.' }], isError: true };
      }

      const newLayer = createLayerFromTemplate(template, {
        customName: custom_name,
        textContent: text_content,
        richContent: rich_content as RichTextBlock[] | undefined,
      });
      if (!newLayer) {
        return { content: [{ type: 'text' as const, text: `Error: Unknown template "${template}".` }], isError: true };
      }

      const updated = insertLayer(layers, parent_layer_id, newLayer, position);
      await savePageLayers(page_id, updated);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Added ${template} "${custom_name || newLayer.customName || template}" to page`,
            layer_id: newLayer.id,
            parent_layer_id,
          }),
        }],
      };
    },
  );

  server.tool(
    'update_layer_design',
    `Update the visual design of a layer. Merges design properties into existing design
and regenerates Tailwind CSS classes.

IMPORTANT: Set isActive: true on any design category you want to apply.

HOVER/FOCUS STATES: Set ui_state to apply styles only on hover, focus, active, disabled, or current.
Example: { backgrounds: { isActive: true, backgroundColor: "#3b82f6" }, ui_state: "hover" }
produces the class "hover:bg-[#3b82f6]".
The "current" state styles a navigation link when it points to the page currently
being viewed (aria-current) — use it for active nav-link and pagination styling.

GRADIENTS: Use bgGradientVars in backgrounds to set CSS gradients.
Example: { backgrounds: { isActive: true, bgGradientVars: { "--bg-img": "linear-gradient(135deg, #667eea 0%, #764ba2 100%)" } } }
For gradient text: also set backgroundClip: "text" and color to "transparent".

CURSOR: effects.cursor — "pointer", "default", "text", "grab", "wait", "not-allowed", or "auto".
Set this on the clickable layer itself (button, link, card), not a nested text child.

TEXT SHADOW: typography.textShadow — e.g. "0px_1px_2px_rgba(0,0,0,0.4)" (underscores, not spaces)
or a named size ("sm", "md", "lg"). Apply on the text/heading/button layer.`,
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID to update'),
      breakpoint: z.enum(['desktop', 'tablet', 'mobile']).default('desktop')
        .describe('Responsive breakpoint. Desktop is default.'),
      ui_state: z.enum(['neutral', 'hover', 'focus', 'active', 'disabled', 'current']).default('neutral')
        .describe('UI state to style. Use "hover" for hover effects, "focus" for focus styles, "current" for the active/current navigation link, etc.'),
      design: designSchema,
    },
    async ({ page_id, layer_id, breakpoint, ui_state, design }) => {
      const layers = await getPageLayers(page_id);

      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      const updated = updateLayerById(layers, layer_id, (l) =>
        applyDesignToLayer(l, design as Record<string, Record<string, unknown>>, breakpoint, ui_state),
      );

      await savePageLayers(page_id, updated);

      // Auto-install any Google Font this edit referenced but never added.
      const fontFamilies = new Set<string>();
      collectFontFamiliesFromDesign(design as Record<string, unknown>, fontFamilies);
      const fonts = await ensureFontsInstalled(fontFamilies);
      const warnings = fontWarnings(fonts);

      const updatedLayer = findLayerById(updated, layer_id);
      const stateLabel = ui_state !== 'neutral' ? ` (${ui_state} state)` : '';
      const bpLabel = breakpoint !== 'desktop' ? ` [${breakpoint}]` : '';
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Updated design for "${updatedLayer?.customName || updatedLayer?.name}"${stateLabel}${bpLabel}`,
            layer_id,
            classes: updatedLayer?.classes,
            design: updatedLayer?.design,
            fonts_auto_installed: fonts.installed.length > 0 ? fonts.installed : undefined,
            design_warnings: warnings.length > 0 ? warnings : undefined,
          }),
        }],
      };
    },
  );

  server.tool(
    'update_layer_text',
    'Update the text content of a text, heading, or button layer. For richText layers with formatting, use set_rich_text_content instead.',
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID to update'),
      text: z.string().describe('New text content'),
    },
    async ({ page_id, layer_id, text }) => {
      const layers = await getPageLayers(page_id);

      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      const updated = updateLayerById(layers, layer_id, (l) => ({
        ...l,
        variables: {
          ...l.variables,
          text: { type: 'dynamic_rich_text', data: { content: getTiptapTextContent(text) } },
        },
      }));

      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `Updated text for "${layer.customName || layer.name}" to "${text}"` }] };
    },
  );

  server.tool(
    'set_rich_text_content',
    `Set the content of a richText layer using structured blocks. Supports headings, paragraphs, lists, blockquotes, code blocks, and horizontal rules. Text supports inline formatting: **bold**, *italic*, [link text](url).`,
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The richText layer ID'),
      blocks: z.array(z.object({
        type: z.enum(['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'codeBlock', 'horizontalRule']),
        text: z.string().optional().describe('Text content. Supports **bold**, *italic*, [link](url).'),
        level: z.number().optional().describe('Heading level 1-6 (for heading type only)'),
        items: z.array(z.string()).optional().describe('List items (for bulletList/orderedList only)'),
      })).min(1).describe('Content blocks to set'),
    },
    async ({ page_id, layer_id, blocks }) => {
      const layers = await getPageLayers(page_id);

      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      const tiptapDoc = buildTiptapDoc(blocks as RichTextBlock[]);

      const updated = updateLayerById(layers, layer_id, (l) => ({
        ...l,
        variables: {
          ...l.variables,
          text: { type: 'dynamic_rich_text', data: { content: tiptapDoc } },
        },
      }));

      await savePageLayers(page_id, updated);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Set rich text content for "${layer.customName || layer.name}" (${blocks.length} blocks)`,
            layer_id,
          }),
        }],
      };
    },
  );

  server.tool(
    'delete_layer',
    'Remove a layer and all its children from a page',
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID to delete'),
    },
    async ({ page_id, layer_id }) => {
      const layers = await getPageLayers(page_id);

      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }
      if (layer.restrictions?.delete === false) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer.customName || layer.name}" cannot be deleted.` }], isError: true };
      }

      const updated = removeLayer(layers, layer_id);
      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `Deleted layer "${layer.customName || layer.name}" (${layer_id})` }] };
    },
  );

  server.tool(
    'move_layer',
    'Move a layer to a different parent or position within the page tree',
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID to move'),
      new_parent_id: z.string().describe('The new parent layer ID'),
      position: z.number().optional().describe('Position within new parent. Omit to append at end.'),
    },
    async ({ page_id, layer_id, new_parent_id, position }) => {
      const layers = await getPageLayers(page_id);

      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }
      const newParent = findLayerById(layers, new_parent_id);
      if (!newParent) {
        return { content: [{ type: 'text' as const, text: `Error: New parent "${new_parent_id}" not found.` }], isError: true };
      }
      if (!canHaveChildren(newParent)) {
        return { content: [{ type: 'text' as const, text: `Error: "${newParent.customName || newParent.name}" cannot have children.` }], isError: true };
      }

      const updated = moveLayerInTree(layers, layer_id, new_parent_id, position);
      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `Moved "${layer.customName || layer.name}" into "${newParent.customName || newParent.name}"` }] };
    },
  );

  server.tool(
    'update_layer_image',
    'Set the image source of an image layer on a PAGE using an asset ID (from upload_asset or list_assets). Optionally set alt text. For images inside a component, use update_component_layers with an update_image op instead.',
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The image layer ID'),
      asset_id: z.string().describe('Asset ID from the asset library'),
      alt: z.string().optional().describe('Image alt text for accessibility. Omit to keep the current alt.'),
    },
    async ({ page_id, layer_id, asset_id, alt }) => {
      const layers = await getPageLayers(page_id);
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      const updated = updateLayerById(layers, layer_id, (l) => applyImageUpdate(l, { asset_id, alt }));

      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `Set image for "${layer.customName || layer.name}" to asset ${asset_id}` }] };
    },
  );

  server.tool(
    'update_layer_link',
    `Configure a link on any layer (button, div, text, image, etc.) in the Ycode editor (see https://docs.ycode.com).
The url is stored on the layer as the link's href and is never requested by the server; no external API is called.

LINK TYPES:
- url: External URL (e.g. "https://example.com")
- page: Link to another page in the site. For a dynamic page, collection_item_id picks the item:
  "current-collection" (the item of the enclosing Collection List — the default when the layer sits
  inside a list of that collection), "current-page" (the item of the dynamic page being viewed —
  the default on such a page), "next-item" / "previous-item", or a specific item id. Without one the
  link renders the literal "/blog/{slug}".
- email: Mailto link
- phone: Tel link
- asset: Download link to an asset
- anchor: Set anchor_layer_id to jump to a section. Same page: link_type "url" with only
  anchor_layer_id (no url). Another page: link_type "page" with page_id_target. The target
  layer needs an HTML id (update_layer_settings html_id); the link renders as href="#<html id>".`,
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID'),
      link_type: z.enum(['url', 'email', 'phone', 'asset', 'page']).describe('Type of link'),
      url: z.string().optional().describe('For url type: the target URL'),
      page_id_target: z.string().optional().describe('For page type: the target page ID'),
      collection_item_id: z.string().optional().describe('For dynamic page links: "current-collection", "current-page", "next-item", "previous-item", or a collection item id. Defaults to "current-collection" inside a list of that collection and "current-page" on its dynamic page.'),
      email: z.string().optional().describe('For email type: the email address'),
      phone: z.string().optional().describe('For phone type: the phone number'),
      asset_id: z.string().optional().describe('For asset type: the asset ID to download'),
      anchor_layer_id: z.string().optional().describe('Layer to scroll to: its layer ID or its HTML id. The layer must have an HTML id (set via update_layer_settings html_id). With link_type "url" and no url it links within this page; with link_type "page" it links to that section on page_id_target.'),
      target: z.enum(['_blank', '_self', '_parent', '_top']).optional().describe('Link target. _blank opens new tab.'),
      rel: z.string().optional().describe('rel attribute, e.g. "noopener noreferrer", "nofollow", "sponsored", "ugc"'),
      download: z.boolean().optional().describe('When true, instruct the browser to download the linked resource instead of navigating.'),
    },
    async ({ page_id, layer_id, ...linkInput }) => {
      const layers = await getPageLayers(page_id);
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      const anchorLayers = linkInput.link_type === 'page' && linkInput.page_id_target && linkInput.page_id_target !== page_id
        ? await getPageLayers(linkInput.page_id_target)
        : layers;
      const resolved = resolveLinkAnchor(linkInput, anchorLayers);
      if ('error' in resolved) {
        return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true };
      }
      let link: LinkInput = resolved.input;
      if (link.link_type === 'page' && link.page_id_target && !link.collection_item_id) {
        const [targetPage, currentPage] = await Promise.all([getPageById(link.page_id_target), getPageById(page_id)]);
        link = defaultDynamicPageItem(link, layers, layer_id, targetPage, currentPage);
      }

      const updated = updateLayerById(layers, layer_id, (l) => ({
        ...l,
        variables: { ...l.variables, link: buildLinkSettings(link, l.variables?.link) },
      }));

      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `${describeLink(link)} on "${layer.customName || layer.name}"` }] };
    },
  );

  server.tool(
    'update_layer_video',
    'Set the video source of a video layer in the Ycode editor (see https://docs.ycode.com). Supports asset IDs, YouTube video IDs, or direct URLs. The url is stored on the layer as the video source and is never requested by the server; no external API is called.',
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The video layer ID'),
      source_type: z.enum(['asset', 'youtube', 'url']).describe('Video source type'),
      asset_id: z.string().optional().describe('For asset type: asset ID'),
      youtube_id: z.string().optional().describe('For youtube type: YouTube video ID (e.g. "dQw4w9WgXcQ")'),
      url: z.string().optional().describe('For url type: direct video URL'),
      poster_asset_id: z.string().optional().describe('Asset ID for poster/thumbnail image'),
    },
    async ({ page_id, layer_id, source_type, asset_id, youtube_id, url, poster_asset_id }) => {
      const layers = await getPageLayers(page_id);
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      let src;
      if (source_type === 'asset' && asset_id) src = { type: 'asset' as const, data: { asset_id } };
      else if (source_type === 'youtube' && youtube_id) src = { type: 'video' as const, data: { provider: 'youtube' as const, video_id: youtube_id } };
      else if (source_type === 'url' && url) src = { type: 'dynamic_text' as const, data: { content: url } };
      else return { content: [{ type: 'text' as const, text: 'Error: Provide asset_id, youtube_id, or url matching the source_type.' }], isError: true };

      const videoVar: Record<string, unknown> = { src };
      if (poster_asset_id) videoVar.poster = { type: 'asset', data: { asset_id: poster_asset_id } };

      const updated = updateLayerById(layers, layer_id, (l) => ({
        ...l,
        variables: { ...l.variables, video: videoVar },
      }));

      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `Set video source for "${layer.customName || layer.name}"` }] };
    },
  );

  server.tool(
    'update_layer_background_image',
    'Set a background image on any layer in the Ycode editor (see https://docs.ycode.com) using an asset ID or URL. The url is stored on the layer as the CSS background image and is never requested by the server; no external API is called.',
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID'),
      asset_id: z.string().optional().describe('Asset ID for the background image'),
      url: z.string().optional().describe('Direct URL for the background image'),
    },
    async ({ page_id, layer_id, asset_id, url }) => {
      const layers = await getPageLayers(page_id);
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }
      if (!asset_id && !url) {
        return { content: [{ type: 'text' as const, text: 'Error: Provide either asset_id or url.' }], isError: true };
      }

      // Sets the variable AND the design/classes that render it — the variable
      // alone only supplies the --bg-img value, nothing displays it without
      // the bg-[image:var(--bg-img)] class.
      const updated = updateLayerById(layers, layer_id, (l) => applyBackgroundImage(l, { asset_id, url }));

      await savePageLayers(page_id, updated);
      const updatedLayer = findLayerById(updated, layer_id);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Set background image for "${layer.customName || layer.name}"`,
            layer_id,
            classes: updatedLayer?.classes,
          }),
        }],
      };
    },
  );

  server.tool(
    'update_layer_settings',
    `Update layer settings like HTML tag, custom ID, custom attributes, embed code, visibility,
and per-element configuration (slider, lightbox, map, select options, filter, placeholder option).

COMMON USES:
- Change heading level: tag "h1", "h2", "h3", etc.
- Set HTML embed code: html_embed_code "<script>..."
- Add custom attributes: custom_attributes { "data-analytics": "hero" }
- Set form field input / textarea / select attributes: custom_attributes { "placeholder": "Your email", "name": "email", "type": "email", "required": "true" }
- Set custom HTML ID: html_id "my-section"
- Hide a layer from the canvas: hidden true
- Configure slider: slider { autoplay: true, delay: "5", loop: "loop", pagination: true }
- Configure lightbox: lightbox { thumbnails: true, zoom: true, navigation: true }
- Bind lightbox to a CMS multi-image field: lightbox { files_source: "cms", files_field_id: "<field id>" }
- Configure map: map { provider: "mapbox", latitude: 40.7128, longitude: -74.006, zoom: 12 }
- Bind select / checkbox / radio to a CMS collection: options_source { collection_id: "<id>", sort_field_id: "<id>", sort_order: "asc" }
- Mark a <option> as the placeholder: is_placeholder true
- Trigger filter element on every change: filter_on_change true`,
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID'),
      tag: z.string().optional().describe('HTML tag override: h1, h2, h3, h4, h5, h6, p, span, div, section, nav, footer, header, main, aside, article'),
      html_id: z.string().optional().describe('Custom HTML element ID (for anchor links, CSS targeting)'),
      html_embed_code: z.string().optional().describe('For htmlEmbed layers: the HTML/CSS/JS code to embed. Runs in a sandboxed iframe on the published site — it cannot overlay the page or access the parent DOM'),
      custom_attributes: z.record(z.string(), z.string()).optional().describe('Custom HTML attributes as { name: value } pairs. On input / textarea / select, type, name, placeholder, value, required and autofocus set the field\'s own settings ("" clears, required/autofocus "false" turns off).'),
      custom_name: z.string().optional().describe('Display name for the layer in the builder'),
      hidden: z.boolean().optional().describe('Hide the layer everywhere (canvas and published site — not rendered). If an interaction targets it with display "visible", or keep_in_html is set, it is instead rendered collapsed so it can be revealed.'),
      keep_in_html: z.boolean().optional().describe('When hidden, keep the element in the HTML collapsed (display: none) instead of omitting it, so custom code can reveal it. Interaction reveal targets are kept automatically.'),
      filter_on_change: z.boolean().optional().describe('For filter layers: trigger filtering on every input change (debounced).'),
      is_placeholder: z.boolean().optional().describe('For <option> children of <select>: mark this option as the disabled placeholder.'),
      slider: z.object({
        navigation: z.boolean().optional().describe('Show prev/next arrows'),
        pagination: z.boolean().optional().describe('Show pagination bullets'),
        pagination_type: z.enum(['bullets', 'fraction']).optional().describe('Pagination style'),
        pagination_clickable: z.boolean().optional(),
        autoplay: z.boolean().optional().describe('Auto-advance slides'),
        pause_on_hover: z.boolean().optional().describe('Pause autoplay on hover'),
        delay: z.string().optional().describe('Autoplay delay in seconds (e.g. "3", "5")'),
        loop: z.enum(['none', 'loop', 'rewind']).optional().describe('Loop mode'),
        animation_effect: z.enum(['slide', 'fade', 'cube', 'coverflow', 'flip', 'cards']).optional(),
        duration: z.string().optional().describe('Transition duration in seconds (e.g. "0.5")'),
        easing: z.string().optional(),
        centered: z.boolean().optional().describe('Center active slide'),
        mousewheel: z.boolean().optional().describe('Navigate with scroll wheel'),
        touch_events: z.boolean().optional(),
        slide_to_clicked: z.boolean().optional(),
        slides_per_group: z.number().optional(),
        group_slide: z.number().optional(),
      }).optional().describe('Slider settings (only for slider layers)'),
      lightbox: z.object({
        files_source: z.enum(['files', 'cms']).optional().describe('"files" for a hand-picked list, "cms" to bind to a multi-image CMS field'),
        files: z.array(z.string()).optional().describe('For files_source "files": array of asset IDs or external URLs'),
        files_field_id: z.string().nullable().optional().describe('For files_source "cms": the CMS field ID to read images from (must be a multi-asset field on the surrounding collection layer)'),
        thumbnails: z.boolean().optional().describe('Show thumbnails strip'),
        navigation: z.boolean().optional().describe('Show prev/next arrows'),
        pagination: z.boolean().optional().describe('Show pagination'),
        zoom: z.boolean().optional().describe('Enable pinch-to-zoom'),
        double_tap_zoom: z.boolean().optional().describe('Enable double-tap zoom'),
        mousewheel: z.boolean().optional().describe('Navigate with scroll wheel'),
        overlay: z.enum(['light', 'dark']).optional().describe('Overlay background style'),
        group_id: z.string().optional().describe('Links multiple lightboxes into one shared gallery'),
        animation_effect: z.enum(['slide', 'fade', 'cube', 'coverflow', 'flip', 'cards']).optional(),
        easing: z.string().optional(),
        duration: z.string().optional().describe('Transition duration in seconds'),
      }).optional().describe('Lightbox settings (only for lightbox layers)'),
      map: z.object({
        provider: z.enum(['mapbox', 'google']).optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        zoom: z.number().optional(),
        marker_color: z.string().nullable().optional(),
        search: z.string().optional().describe('Address / place to geocode (alternative to lat/lng)'),
        style: z.string().optional().describe('Provider-specific style key. Sets <provider>.style.'),
        interactive: z.boolean().optional(),
        scroll_zoom: z.boolean().optional(),
        show_nav_control: z.boolean().optional(),
        show_scale_bar: z.boolean().optional(),
      }).optional().describe('Map settings (only for map layers)'),
      options_source: z.object({
        collection_id: z.string().describe('Collection to source options from'),
        default_item_id: z.string().optional().describe('Item ID to pre-select (for <select>)'),
        default_item_ids: z.array(z.string()).optional().describe('Item IDs to pre-check (for checkbox groups)'),
        sort_field_id: z.string().optional().describe('Field ID to sort by (omit for manual order)'),
        sort_order: z.enum(['asc', 'desc']).optional(),
      }).nullable().optional().describe('Bind a select / checkbox / radio element to a CMS collection. Pass null to clear.'),
    },
    async ({
      page_id, layer_id, tag, html_id, html_embed_code, custom_attributes, custom_name,
      hidden, keep_in_html, filter_on_change, is_placeholder, slider, lightbox, map, options_source,
    }) => {
      const layers = await getPageLayers(page_id);
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      const updated = updateLayerById(layers, layer_id, (rawLayer) => {
        // Element-agnostic settings share a helper with the batch `update_settings` op.
        const l = applyLayerSettings(rawLayer, { tag, html_id, custom_name, hidden, keep_in_html, custom_attributes, html_embed_code });
        const settings = { ...l.settings };
        if (filter_on_change !== undefined) settings.filterOnChange = filter_on_change;
        if (is_placeholder !== undefined) settings.isPlaceholder = is_placeholder;
        if (slider) {
          const existing = settings.slider || {} as Record<string, unknown>;
          settings.slider = {
            ...existing,
            ...(slider.navigation !== undefined && { navigation: slider.navigation }),
            ...(slider.pagination !== undefined && { pagination: slider.pagination }),
            ...(slider.pagination_type !== undefined && { paginationType: slider.pagination_type }),
            ...(slider.pagination_clickable !== undefined && { paginationClickable: slider.pagination_clickable }),
            ...(slider.autoplay !== undefined && { autoplay: slider.autoplay }),
            ...(slider.pause_on_hover !== undefined && { pauseOnHover: slider.pause_on_hover }),
            ...(slider.delay !== undefined && { delay: slider.delay }),
            ...(slider.loop !== undefined && { loop: slider.loop }),
            ...(slider.animation_effect !== undefined && { animationEffect: slider.animation_effect }),
            ...(slider.duration !== undefined && { duration: slider.duration }),
            ...(slider.easing !== undefined && { easing: slider.easing }),
            ...(slider.centered !== undefined && { centered: slider.centered }),
            ...(slider.mousewheel !== undefined && { mousewheel: slider.mousewheel }),
            ...(slider.touch_events !== undefined && { touchEvents: slider.touch_events }),
            ...(slider.slide_to_clicked !== undefined && { slideToClicked: slider.slide_to_clicked }),
            ...(slider.slides_per_group !== undefined && { slidesPerGroup: slider.slides_per_group }),
            ...(slider.group_slide !== undefined && { groupSlide: slider.group_slide }),
          } as typeof settings.slider;
        }
        if (lightbox) {
          const existing = (settings.lightbox || {}) as Record<string, unknown>;
          const next = { ...existing } as Record<string, unknown>;
          if (lightbox.files_source !== undefined) next.filesSource = lightbox.files_source;
          if (lightbox.files !== undefined) next.files = lightbox.files;
          if (lightbox.files_field_id !== undefined) {
            next.filesField = lightbox.files_field_id
              ? { type: 'field', data: { field_id: lightbox.files_field_id, field_type: 'image', relationships: [] } }
              : null;
          }
          if (lightbox.thumbnails !== undefined) next.thumbnails = lightbox.thumbnails;
          if (lightbox.navigation !== undefined) next.navigation = lightbox.navigation;
          if (lightbox.pagination !== undefined) next.pagination = lightbox.pagination;
          if (lightbox.zoom !== undefined) next.zoom = lightbox.zoom;
          if (lightbox.double_tap_zoom !== undefined) next.doubleTapZoom = lightbox.double_tap_zoom;
          if (lightbox.mousewheel !== undefined) next.mousewheel = lightbox.mousewheel;
          if (lightbox.overlay !== undefined) next.overlay = lightbox.overlay;
          if (lightbox.group_id !== undefined) next.groupId = lightbox.group_id;
          if (lightbox.animation_effect !== undefined) next.animationEffect = lightbox.animation_effect;
          if (lightbox.easing !== undefined) next.easing = lightbox.easing;
          if (lightbox.duration !== undefined) next.duration = lightbox.duration;
          settings.lightbox = next as unknown as typeof settings.lightbox;
        }
        if (map) {
          const existing = (settings.map || {}) as Record<string, unknown>;
          const next = { ...existing } as Record<string, unknown>;
          if (map.provider !== undefined) next.provider = map.provider;
          if (map.latitude !== undefined) next.latitude = map.latitude;
          if (map.longitude !== undefined) next.longitude = map.longitude;
          if (map.zoom !== undefined) next.zoom = map.zoom;
          if (map.marker_color !== undefined) next.markerColor = map.marker_color;
          if (map.search !== undefined) next.search = map.search;
          const providerKey = (map.provider || existing.provider || 'mapbox') as 'mapbox' | 'google';
          const providerSettings = { ...((existing[providerKey] as Record<string, unknown>) || {}) };
          if (map.style !== undefined) providerSettings.style = map.style;
          if (map.interactive !== undefined) providerSettings.interactive = map.interactive;
          if (map.scroll_zoom !== undefined) providerSettings.scrollZoom = map.scroll_zoom;
          if (map.show_nav_control !== undefined) providerSettings.showNavControl = map.show_nav_control;
          if (map.show_scale_bar !== undefined) providerSettings.showScaleBar = map.show_scale_bar;
          if (Object.keys(providerSettings).length > 0) next[providerKey] = providerSettings;
          settings.map = next as unknown as typeof settings.map;
        }
        if (options_source !== undefined) {
          settings.optionsSource = options_source === null ? undefined : {
            collectionId: options_source.collection_id,
            ...(options_source.default_item_id !== undefined && { defaultItemId: options_source.default_item_id }),
            ...(options_source.default_item_ids !== undefined && { defaultItemIds: options_source.default_item_ids }),
            ...(options_source.sort_field_id !== undefined && { sortFieldId: options_source.sort_field_id }),
            ...(options_source.sort_order !== undefined && { sortOrder: options_source.sort_order }),
          };
        }

        return { ...l, settings };
      });

      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `Updated settings for "${layer.customName || layer.name}"` }] };
    },
  );

  server.tool(
    'update_form_settings',
    `Configure how a form layer handles submissions.

success_action: "message" (default) shows the form's alert child; "redirect" sends the visitor to redirect_url.
email_notification: when enabled, each submission emails the configured address. Requires SMTP set up in site settings.
redirect_url: used when success_action is "redirect". Accepts an internal path "/thank-you" or an external URL.`,
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The form layer ID'),
      success_action: z.enum(['message', 'redirect']).optional(),
      redirect_url: z.string().optional()
        .describe('For success_action "redirect": the URL to send the user to.'),
      email_notification: z.object({
        enabled: z.boolean(),
        to: z.string().describe('Email address that receives a notification on each submission'),
        subject: z.string().optional().describe('Subject line of the notification email'),
      }).optional(),
    },
    async ({ page_id, layer_id, success_action, redirect_url, email_notification }) => {
      const layers = await getPageLayers(page_id);
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      const updated = updateLayerById(layers, layer_id, (l) => {
        const settings = { ...l.settings };
        const existingForm = (settings.form || {}) as Record<string, unknown>;
        const nextForm: Record<string, unknown> = { ...existingForm };
        if (success_action !== undefined) nextForm.success_action = success_action;
        if (email_notification !== undefined) nextForm.email_notification = email_notification;
        if (redirect_url !== undefined) {
          nextForm.redirect_url = { type: 'dynamic_text', data: { content: redirect_url } };
        }
        settings.form = nextForm as typeof settings.form;
        return { ...l, settings };
      });

      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `Updated form settings for "${layer.customName || layer.name}"` }] };
    },
  );

  server.tool(
    'export_layer_html',
    `Render a layer (and its descendants) to a self-contained HTML string with Tailwind
classes preserved. Useful for copying a section, sharing markup, or seeding another
page via the HTML import flow. Links render as <a href> with the same href the published
page uses (page, anchor, url, email, phone, asset), so you can check link setup here.

By default this is the raw draft: component instances stay as placeholders and a Collection
List renders its template once with empty bindings. Pass rendered: true to get what the
published page would show instead — components expanded, Collection Lists repeated with the
real draft items, CMS fields filled in (text, images, links), visibility conditions applied,
rich text with element styles. Use it to verify a CMS section or a dynamic page without
publishing. On a dynamic page it renders the first item unless collection_item_slug is set.
The rendered HTML is for inspection, not re-import (ids carry per-item suffixes).`,
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID to export'),
      rendered: z.boolean().optional().describe('Render like the published site: components expanded, collection items and CMS fields resolved. Default false (raw draft).'),
      collection_item_slug: z.string().optional().describe('Dynamic pages with rendered: true — slug of the collection item to render. Defaults to the first item.'),
    },
    async ({ page_id, layer_id, rendered, collection_item_slug }) => {
      if (rendered) {
        const result = await renderLayerHtml({ pageId: page_id, layerId: layer_id, collectionItemSlug: collection_item_slug });
        if ('error' in result) {
          return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
        }
        const header = [
          `<!-- rendered: ${result.path}${result.item ? ` (item ${result.item.slug})` : ''} -->`,
          ...(result.note ? [`<!-- ${result.note} -->`] : []),
        ].join('\n');
        return { content: [{ type: 'text' as const, text: `${header}\n${result.html}` }] };
      }
      const layers = await getPageLayers(page_id);
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }
      const assetIds = [...collectLayerAssetIds([layer], [])];
      const [assets, pages, folders] = await Promise.all([
        getAssetsByIds(assetIds),
        getAllDraftPages(),
        getAllDraftPageFolders(),
      ]);
      const anchorMap = Object.fromEntries(
        findLayersWithAnchorId(layers).map(({ layer: target, id }) => [target.id, id]),
      );
      const html = layerToExportHtml(layer, buildAssetUrlMap(Object.values(assets)), {
        pages,
        folders,
        anchorMap,
        pageId: page_id,
      });
      return { content: [{ type: 'text' as const, text: html }] };
    },
  );

  server.tool(
    'update_layer_iframe',
    'Set the source URL for an iframe layer in the Ycode editor (see https://docs.ycode.com). The url is stored on the layer as the iframe src and is never requested by the server; no external API is called.',
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The iframe layer ID'),
      url: z.string().describe('The URL to embed in the iframe'),
    },
    async ({ page_id, layer_id, url }) => {
      const layers = await getPageLayers(page_id);
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      const updated = updateLayerById(layers, layer_id, (l) => ({
        ...l,
        variables: {
          ...l.variables,
          iframe: { src: { type: 'dynamic_text' as const, data: { content: url } } },
        },
      }));

      await savePageLayers(page_id, updated);
      return { content: [{ type: 'text' as const, text: `Set iframe URL for "${layer.customName || layer.name}" to "${url}"` }] };
    },
  );
}
