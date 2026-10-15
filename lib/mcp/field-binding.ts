/**
 * Shared CMS field-binding logic for the single `bind_layer_field` tool and the
 * `bind_field` batch operation: resolves which collection a layer binds to and
 * produces the layer variables that render the field.
 */

import type { CollectionField, CollectionFieldType, Layer } from '@/types';
import { getFieldsByCollectionId } from '@/lib/repositories/collectionFieldRepository';
import { getPageById } from '@/lib/repositories/pageRepository';
import { applyBackgroundImageDesign } from '@/lib/mcp/utils';
import { findParentCollectionLayer } from '@/lib/layer-utils';

/** Layer types whose text content can be bound to a CMS field. */
export const BINDABLE_TEXT_LAYER_NAMES = new Set(['text', 'heading', 'richText']);

export type BindingSource = 'collection' | 'page';
export type BindingTarget = 'auto' | 'src' | 'alt' | 'poster' | 'background';

export interface FieldData {
  field_id: string;
  field_type: CollectionFieldType;
  relationships: string[];
  source: BindingSource;
  collection_layer_id?: string;
  format?: string;
}

/** A field variable's data payload — binds a layer's content to a CMS field. */
export function buildFieldData(
  field: CollectionField,
  source: BindingSource,
  collectionLayerId: string | undefined,
  format: string | undefined,
): FieldData {
  return {
    field_id: field.id,
    field_type: field.type,
    relationships: [],
    source,
    ...(collectionLayerId ? { collection_layer_id: collectionLayerId } : {}),
    ...(format ? { format } : {}),
  };
}

/** Wrap a field variable in the `<ycode-inline-variable>` tag used in dynamic-text strings. */
export function inlineVariableTag(fieldData: FieldData): string {
  return `<ycode-inline-variable>${JSON.stringify({ type: 'field', data: fieldData })}</ycode-inline-variable>`;
}

/** A single Tiptap inline node representing a bound field. */
export function dynamicVariableNode(fieldData: FieldData, label: string) {
  return { type: 'dynamicVariable', attrs: { variable: { type: 'field', data: fieldData }, label } };
}

/** Wrap inline nodes in a single-paragraph Tiptap doc. */
export function paragraphDoc(content: Record<string, unknown>[]) {
  return { type: 'doc', content: [{ type: 'paragraph', content }] };
}

/** Build a Tiptap rich-text doc that renders optional prefix/suffix around a bound field. */
export function buildBoundTextDoc(fieldData: FieldData, label: string, prefix?: string, suffix?: string) {
  const content: Record<string, unknown>[] = [];
  if (prefix) content.push({ type: 'text', text: prefix });
  content.push(dynamicVariableNode(fieldData, label));
  if (suffix) content.push({ type: 'text', text: suffix });
  return paragraphDoc(content);
}

/**
 * Resolve the collection a binding should pull from: the nearest ancestor
 * Collection List (source "collection") or the dynamic page's own collection
 * (source "page"). Returns the collection id plus, for the collection source,
 * the ancestor list layer id stamped onto the FieldVariable.
 */
export async function resolveBindingContext(
  layers: Layer[],
  layerId: string,
  pageId: string,
  source: BindingSource,
): Promise<{ collectionId: string; collectionLayerId?: string } | { error: string }> {
  if (source === 'collection') {
    const parent = findParentCollectionLayer(layers, layerId);
    if (!parent) {
      return { error: 'Layer is not inside a Collection List. Place it inside a bound "collection" element, or use source "page".' };
    }
    const collectionId = parent.variables?.collection?.id;
    if (!collectionId) {
      return { error: 'The ancestor Collection List is not bound yet. Call bind_collection_layer first.' };
    }
    return { collectionId, collectionLayerId: parent.id };
  }

  const page = await getPageById(pageId);
  const collectionId = page?.settings?.cms?.collection_id;
  if (!collectionId) {
    return { error: 'This page is not a dynamic CMS page. Bind it to a collection (update_page_settings.cms) or use source "collection".' };
  }
  return { collectionId };
}

export interface FieldBindingInput {
  field_id: string;
  source: BindingSource;
  target: BindingTarget;
  format?: string;
  prefix?: string;
  suffix?: string;
}

/** Per-call cache so a batch binding many layers fetches each collection's fields once. */
export type FieldCache = Map<string, Promise<CollectionField[]>>;

export function getFieldsCached(collectionId: string, cache?: FieldCache): Promise<CollectionField[]> {
  if (!cache) return getFieldsByCollectionId(collectionId);
  let pending = cache.get(collectionId);
  if (!pending) {
    pending = getFieldsByCollectionId(collectionId);
    cache.set(collectionId, pending);
  }
  return pending;
}

/**
 * Resolve the field and compute the bound layer. Returns the updated layer and a
 * short summary, or an error describing why the layer cannot take the binding.
 */
export async function bindLayerToField(
  layers: Layer[],
  layer: Layer,
  pageId: string,
  input: FieldBindingInput,
  cache?: FieldCache,
): Promise<{ layer: Layer; summary: string; field: CollectionField } | { error: string }> {
  const ctx = await resolveBindingContext(layers, layer.id, pageId, input.source);
  if ('error' in ctx) return ctx;

  const fields = await getFieldsCached(ctx.collectionId, cache);
  const field = fields.find((f) => f.id === input.field_id);
  if (!field) {
    return { error: `Field "${input.field_id}" not found in the ${input.source === 'page' ? 'page' : 'list'} collection.` };
  }

  const fieldData = buildFieldData(field, input.source, ctx.collectionLayerId, input.format);
  const { target, prefix, suffix } = input;
  const isText = BINDABLE_TEXT_LAYER_NAMES.has(layer.name);

  let nextVariables: Layer['variables'];
  let summary: string;

  if (target === 'background') {
    nextVariables = { ...layer.variables, backgroundImage: { src: { type: 'field', data: fieldData } } };
    summary = `background image → "${field.name}"`;
  } else if (isText && (target === 'auto' || target === 'src')) {
    nextVariables = {
      ...layer.variables,
      text: { type: 'dynamic_rich_text', data: { content: buildBoundTextDoc(fieldData, field.name, prefix, suffix) } },
    };
    summary = `text → "${field.name}"`;
  } else if (layer.name === 'image') {
    const existing = layer.variables?.image;
    if (target === 'alt') {
      nextVariables = {
        ...layer.variables,
        image: {
          src: existing?.src ?? { type: 'asset', data: { asset_id: null } },
          alt: { type: 'dynamic_text', data: { content: `${prefix ?? ''}${inlineVariableTag(fieldData)}${suffix ?? ''}` } },
        },
      };
      summary = `image alt → "${field.name}"`;
    } else {
      nextVariables = {
        ...layer.variables,
        image: {
          src: { type: 'field', data: fieldData },
          alt: existing?.alt ?? { type: 'dynamic_text', data: { content: '' } },
        },
      };
      summary = `image src → "${field.name}"`;
    }
  } else if (layer.name === 'video') {
    const existing = layer.variables?.video;
    if (target === 'poster') {
      nextVariables = { ...layer.variables, video: { ...existing, poster: { type: 'field', data: fieldData } } };
      summary = `video poster → "${field.name}"`;
    } else {
      nextVariables = { ...layer.variables, video: { ...existing, src: { type: 'field', data: fieldData } } };
      summary = `video src → "${field.name}"`;
    }
  } else if (layer.name === 'audio') {
    nextVariables = { ...layer.variables, audio: { ...layer.variables?.audio, src: { type: 'field', data: fieldData } } };
    summary = `audio src → "${field.name}"`;
  } else {
    return {
      error: `Layer "${layer.customName || layer.name}" (${layer.name}) cannot bind a "${target}" field. Use a text, heading, image, video, or audio layer, or target "background".`,
    };
  }

  const next = { ...layer, variables: nextVariables };
  // Background bindings also need the design/classes that render the
  // --bg-img variable, otherwise the bound image never displays.
  return { layer: target === 'background' ? applyBackgroundImageDesign(next) : next, summary, field };
}
