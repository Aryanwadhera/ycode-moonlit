/**
 * Filtering for the get_layers MCP tool: subtree, depth limit, search, and a
 * compact summary shape, so agents can read large pages in small pieces.
 */

import { getClassesString } from '@/lib/layer-utils';
import { extractPlainTextFromTiptap } from '@/lib/tiptap-utils';
import type { Layer, LinkSettings } from '@/types';

export type LayerFields = 'full' | 'summary';

export interface LayerQuery {
  layerId?: string;
  depth?: number;
  search?: string;
  fields?: LayerFields;
}

export interface LayerSummary {
  id: string;
  name: string;
  customName?: string;
  html_id?: string;
  tag?: string;
  text?: string;
  link?: string;
  classes?: string;
  componentId?: string;
  children?: unknown[];
  children_count?: number;
}

export interface LayerMatch {
  parent_id: string | null;
  path: string;
  layer: unknown;
}

export type LayerQueryResult =
  | { layers: unknown[] }
  | { matches: LayerMatch[]; match_count: number; matches_omitted?: number }
  | { error: string };

export const MAX_SEARCH_MATCHES = 50;
const MAX_SUMMARY_TEXT = 200;

export function hasLayerQuery(query: LayerQuery): boolean {
  return query.layerId !== undefined || query.depth !== undefined
    || !!query.search || query.fields !== undefined;
}

export function getLayerPlainText(layer: Layer): string {
  const variable = layer.variables?.text;
  if (!variable) return '';
  const content = variable.data?.content;
  if (typeof content === 'string') return content;
  return extractPlainTextFromTiptap(content);
}

function getHtmlId(layer: Layer): string | undefined {
  const htmlId = layer.settings?.id || layer.attributes?.id;
  return typeof htmlId === 'string' && htmlId ? htmlId : undefined;
}

/** One-line link target: a URL, "mailto:"/"tel:", "page:<id>", "asset:<id>", "field", or "#<layer id>". */
export function describeLink(link: LinkSettings | undefined): string | undefined {
  if (!link) return undefined;
  const anchor = link.anchor_layer_id ? `#${link.anchor_layer_id}` : '';
  const target = (() => {
    switch (link.type) {
      case 'url': return link.url?.data?.content ?? '';
      case 'email': return link.email?.data?.content ? `mailto:${link.email.data.content}` : '';
      case 'phone': return link.phone?.data?.content ? `tel:${link.phone.data.content}` : '';
      case 'page': return link.page?.id ? `page:${link.page.id}` : '';
      case 'asset': return link.asset?.id ? `asset:${link.asset.id}` : '';
      case 'field': return 'field';
      default: return '';
    }
  })();
  return target || anchor ? `${target}${anchor}` : undefined;
}

function summarize(layer: Layer): LayerSummary {
  const text = getLayerPlainText(layer);
  const classes = getClassesString(layer);
  const htmlId = getHtmlId(layer);
  const tag = layer.settings?.tag;
  const link = describeLink(layer.variables?.link);
  return {
    id: layer.id,
    name: layer.name,
    ...(layer.customName ? { customName: layer.customName } : {}),
    ...(htmlId ? { html_id: htmlId } : {}),
    ...(tag ? { tag } : {}),
    ...(text ? { text: text.length > MAX_SUMMARY_TEXT ? `${text.slice(0, MAX_SUMMARY_TEXT)}…` : text } : {}),
    ...(link ? { link } : {}),
    ...(classes ? { classes } : {}),
    ...(layer.componentId ? { componentId: layer.componentId } : {}),
  };
}

/** Renders a layer in the requested shape, cutting children below `depth` levels to a count. */
function shapeLayer(layer: Layer, fields: LayerFields, depth: number | undefined): unknown {
  const children = layer.children ?? [];
  const base: Record<string, unknown> = fields === 'summary' ? { ...summarize(layer) } : { ...layer };
  delete base.children;

  if (children.length === 0) {
    return fields === 'full' && layer.children ? { ...base, children: [] } : base;
  }
  if (depth !== undefined && depth <= 0) {
    return { ...base, children_count: children.length };
  }
  const nextDepth = depth === undefined ? undefined : depth - 1;
  return { ...base, children: children.map((child) => shapeLayer(child, fields, nextDepth)) };
}

function pathLabel(layer: Layer): string {
  const htmlId = getHtmlId(layer);
  return `${layer.customName || layer.name}${htmlId ? `#${htmlId}` : ''}`;
}

function matchesSearch(layer: Layer, needle: string): boolean {
  const haystack = [
    layer.id,
    layer.name,
    layer.customName,
    getHtmlId(layer),
    getClassesString(layer),
    getLayerPlainText(layer),
  ];
  return haystack.some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
}

function findWithAncestors(layers: Layer[], id: string, ancestors: Layer[] = []): { layer: Layer; ancestors: Layer[] } | null {
  for (const layer of layers) {
    if (layer.id === id) return { layer, ancestors };
    const found = findWithAncestors(layer.children ?? [], id, [...ancestors, layer]);
    if (found) return found;
  }
  return null;
}

export function queryLayers(tree: Layer[], query: LayerQuery): LayerQueryResult {
  const fields = query.fields ?? 'full';
  let roots = tree;
  let rootAncestors: Layer[] = [];

  if (query.layerId) {
    const found = findWithAncestors(tree, query.layerId);
    if (!found) return { error: `Layer "${query.layerId}" not found on this page.` };
    roots = [found.layer];
    rootAncestors = found.ancestors;
  }

  const needle = query.search?.trim().toLowerCase();
  if (!needle) {
    return { layers: roots.map((layer) => shapeLayer(layer, fields, query.depth)) };
  }

  const matches: LayerMatch[] = [];
  let matchCount = 0;
  const walk = (layers: Layer[], ancestors: Layer[]) => {
    for (const layer of layers) {
      if (matchesSearch(layer, needle)) {
        matchCount++;
        if (matches.length < MAX_SEARCH_MATCHES) {
          const parent = ancestors[ancestors.length - 1];
          matches.push({
            parent_id: parent?.id ?? null,
            path: [...ancestors, layer].map(pathLabel).join(' > '),
            layer: shapeLayer(layer, fields, query.depth ?? 0),
          });
        }
      }
      if (layer.children) walk(layer.children, [...ancestors, layer]);
    }
  };
  walk(roots, rootAncestors);

  return {
    matches,
    match_count: matchCount,
    ...(matchCount > matches.length ? { matches_omitted: matchCount - matches.length } : {}),
  };
}
