/**
 * Applies the `data-ycode-*` annotations of an HTML import:
 *
 * - `data-ycode-toggle` / `data-ycode-menu` → the native click interaction that
 *   shows and hides a mobile menu (same shape as the navigation-001 layout).
 * - `data-ycode-collection` (+ `-limit`, `-sort`, `-filter`) → a bound Collection
 *   List; `data-ycode-field`, `-field-alt`, `-field-bg` → CMS field bindings;
 *   `data-ycode-link="item"` → a link to the collection's dynamic page.
 *
 * Everything that cannot be resolved is reported as an import warning and the
 * markup stays static, so a failed annotation never loses content.
 */

import { applyFieldBinding, buildFieldData } from '@/lib/mcp/field-binding-core';
import { buildConditionGroups } from '@/lib/mcp/tools/visibility-conditions';
import { findLayerById, generateId, updateLayerById } from '@/lib/mcp/utils';
import { canConvertToCollection, canLayerHaveLink, findParentCollectionLayer } from '@/lib/layer-utils';
import type { HtmlImportWarning, HtmlYcodeMark } from '@/lib/html-layer-converter';
import type { Breakpoint, Collection, CollectionField, CollectionVariable, Layer, LayerInteraction, Page } from '@/types';

export interface ImportedToggle {
  toggle_layer_id: string;
  menu_layer_id: string;
  breakpoints: Breakpoint[];
}

export interface ImportedCollectionList {
  layer_id: string;
  collection_id: string;
  collection_name: string;
}

export interface CmsMarkResult {
  layers: Layer[];
  collection_lists: ImportedCollectionList[];
  fields_bound: number;
  item_links: number;
  warnings: HtmlImportWarning[];
}

export interface CmsMarkDeps {
  getCollections: () => Promise<Collection[]>;
  getFields: (collectionId: string) => Promise<CollectionField[]>;
  /** Draft pages, used to find the dynamic page of a collection. */
  getPages: () => Promise<Page[]>;
  /** Collection of the page being imported into, when it is a dynamic page. */
  pageCollectionId?: string;
}

const DISPLAY_VALUES = 'flex|block|inline-flex|inline-block|grid|inline';

function classList(layer: Layer): string[] {
  return (Array.isArray(layer.classes) ? layer.classes : (layer.classes || '').split(/\s+/)).filter(Boolean);
}

function setClasses(layer: Layer, classes: string[]): Layer {
  return { ...layer, classes: classes.join(' ') };
}

/**
 * Where the menu is collapsed: the menu's own hidden breakpoint wins, then the
 * breakpoint the toggle button appears on, else every breakpoint (overlay menus).
 */
function toggleBreakpoints(button: Layer, menu: Layer): Breakpoint[] {
  const menuClasses = classList(menu);
  if (menuClasses.includes('max-md:hidden')) return ['mobile'];
  if (menuClasses.includes('max-lg:hidden')) return ['tablet', 'mobile'];

  const shownAt = new RegExp(`^max-(md|lg):(${DISPLAY_VALUES})$`);
  for (const cls of classList(button)) {
    const match = cls.match(shownAt);
    if (match) return match[1] === 'md' ? ['mobile'] : ['tablet', 'mobile'];
  }
  return [];
}

/**
 * The interaction hides the menu on load (per breakpoint) and toggles it on
 * click, so a static `hidden` class on the menu would keep it closed forever.
 */
function stripMenuHiddenClasses(menu: Layer, breakpoints: Breakpoint[]): Layer {
  const scoped = breakpoints.length > 0;
  const remaining = classList(menu).filter((cls) => {
    if (cls === 'max-md:hidden' || cls === 'max-lg:hidden') return false;
    if (!scoped && cls === 'hidden') return false;
    return true;
  });
  let next = setClasses(menu, remaining);
  if (!scoped && next.design?.layout?.display === 'hidden') {
    const { display: _display, ...layout } = next.design.layout;
    void _display;
    next = { ...next, design: { ...next.design, layout } };
  }
  return next;
}

function buildToggleInteraction(menuLayerId: string, breakpoints: Breakpoint[]): LayerInteraction {
  return {
    id: generateId('int'),
    trigger: 'click',
    timeline: { breakpoints, repeat: 0, yoyo: true },
    tweens: [{
      id: generateId('twn'),
      layer_id: menuLayerId,
      position: '>',
      duration: 0,
      ease: 'power1.out',
      from: { display: 'hidden' },
      to: { display: 'visible' },
      apply_styles: { display: 'on-load' },
    }],
  };
}

function isDescendant(root: Layer, id: string): boolean {
  return (root.children ?? []).some((child) => child.id === id || isDescendant(child, id));
}

/**
 * Pairs `data-ycode-toggle="name"` buttons with `data-ycode-menu="name"` panels
 * and writes the click interaction onto the button. Pure, so it also works for
 * component imports and runs before component extraction.
 */
export function applyToggleMarks(
  layers: Layer[],
  marks: HtmlYcodeMark[],
): { layers: Layer[]; toggles: ImportedToggle[]; warnings: HtmlImportWarning[] } {
  const warnings: HtmlImportWarning[] = [];
  const toggles: ImportedToggle[] = [];
  const menus = new Map<string, Extract<HtmlYcodeMark, { kind: 'menu' }>>();
  for (const mark of marks) {
    if (mark.kind !== 'menu') continue;
    if (menus.has(mark.name)) {
      warnings.push({ message: `data-ycode-menu="${mark.name}" appears more than once; only the first panel is toggled`, path: mark.path, layerId: mark.layerId });
      continue;
    }
    menus.set(mark.name, mark);
  }

  const usedMenus = new Set<string>();
  let tree = layers;
  for (const mark of marks) {
    if (mark.kind !== 'toggle') continue;
    const menuMark = menus.get(mark.name);
    if (!menuMark) {
      warnings.push({ message: `data-ycode-toggle="${mark.name}" has no data-ycode-menu="${mark.name}" panel; no menu interaction was created`, path: mark.path, layerId: mark.layerId });
      continue;
    }
    const button = findLayerById(tree, mark.layerId);
    const menu = findLayerById(tree, menuMark.layerId);
    if (!button || !menu) continue;
    if (button.id === menu.id || isDescendant(button, menu.id)) {
      warnings.push({ message: `data-ycode-menu="${mark.name}" must not be the toggle button or inside it`, path: menuMark.path, layerId: menuMark.layerId });
      continue;
    }

    const breakpoints = toggleBreakpoints(button, menu);
    usedMenus.add(mark.name);
    tree = updateLayerById(tree, menu.id, (l) => stripMenuHiddenClasses(l, breakpoints));
    tree = updateLayerById(tree, button.id, (l) => ({
      ...l,
      interactions: [...(l.interactions ?? []), buildToggleInteraction(menu.id, breakpoints)],
    }));
    toggles.push({ toggle_layer_id: button.id, menu_layer_id: menu.id, breakpoints });
  }

  for (const [name, mark] of menus) {
    if (!usedMenus.has(name)) {
      warnings.push({ message: `data-ycode-menu="${name}" has no data-ycode-toggle="${name}" button; the panel was imported as-is`, path: mark.path, layerId: mark.layerId });
    }
  }

  return { layers: tree, toggles, warnings };
}

const normalize = (value: string) => value.trim().toLowerCase();

function findField(fields: CollectionField[], ref: string): CollectionField | undefined {
  const key = normalize(ref);
  return fields.find((f) => f.id === ref)
    ?? fields.find((f) => normalize(f.name) === key)
    ?? fields.find((f) => f.key !== null && normalize(f.key) === key);
}

function fieldNames(fields: CollectionField[]): string {
  return fields.map((f) => `"${f.name}"`).join(', ');
}

/** `name[:asc|desc]`, `manual`, `random`, or `none`. */
function resolveSort(sort: string, fields: CollectionField[]): Pick<CollectionVariable, 'sort_by' | 'sort_order'> | { error: string } {
  const [rawField, rawOrder] = sort.split(':').map((part) => part.trim());
  if (['manual', 'random', 'none'].includes(normalize(rawField))) return { sort_by: normalize(rawField) };
  const field = findField(fields, rawField);
  if (!field) return { error: `sort field "${rawField}" not found (fields: ${fieldNames(fields)})` };
  const order = normalize(rawOrder || 'asc');
  if (order !== 'asc' && order !== 'desc') return { error: `sort order "${rawOrder}" must be "asc" or "desc"` };
  return { sort_by: field.id, sort_order: order };
}

/** `Field=value; Other!=value` → one AND group per condition. */
function resolveFilter(filter: string, fields: CollectionField[], layers: Layer[]): CollectionVariable['filters'] | { error: string } {
  const parts = filter.split(';').map((part) => part.trim()).filter(Boolean);
  const groups: { conditions: { source: 'field'; field_id: string; operator: string; value: string }[] }[] = [];
  for (const part of parts) {
    const match = part.match(/^([^!=]+?)\s*(!=|=)\s*(.+)$/);
    if (!match) return { error: `filter "${part}" must look like "Field=value" or "Field!=value"` };
    const field = findField(fields, match[1]);
    if (!field) return { error: `filter field "${match[1]}" not found (fields: ${fieldNames(fields)})` };
    if (['reference', 'multi_reference'].includes(field.type)) {
      return { error: `filter on reference field "${field.name}" needs item ids; set it with set_collection_filters` };
    }
    groups.push({ conditions: [{ source: 'field', field_id: field.id, operator: match[2] === '=' ? 'is' : 'is_not', value: match[3].trim() }] });
  }
  const built = buildConditionGroups(groups, { fieldsById: new Map(fields.map((f) => [f.id, f])), layers });
  if ('error' in built) return { error: built.error };
  return { groups: built.groups };
}

function findCollection(collections: Collection[], ref: string): Collection | undefined {
  const key = normalize(ref);
  return collections.find((c) => c.id === ref) ?? collections.find((c) => normalize(c.name) === key);
}

/**
 * Applies collection, field and item-link marks on the page tree (after the
 * imported layers are inserted, so bindings can also reach a Collection List
 * that already existed on the page).
 */
export async function applyCmsMarks(layers: Layer[], marks: HtmlYcodeMark[], deps: CmsMarkDeps): Promise<CmsMarkResult> {
  const result: CmsMarkResult = { layers, collection_lists: [], fields_bound: 0, item_links: 0, warnings: [] };
  const cmsMarks = marks.filter((m) => m.kind === 'collection' || m.kind === 'field' || m.kind === 'item-link');
  if (cmsMarks.length === 0) return result;

  const warn = (mark: HtmlYcodeMark, message: string) => result.warnings.push({ message, path: mark.path, layerId: mark.layerId });
  const missing = (mark: HtmlYcodeMark, attr: string) =>
    warn(mark, `${attr} is on a layer that is no longer on the page (it moved into a component); bind it inside the component master instead`);

  const fieldCache = new Map<string, Promise<CollectionField[]>>();
  const fieldsOf = (collectionId: string) => {
    let pending = fieldCache.get(collectionId);
    if (!pending) {
      pending = deps.getFields(collectionId);
      fieldCache.set(collectionId, pending);
    }
    return pending;
  };

  let tree = layers;
  const collections = await deps.getCollections();

  for (const mark of cmsMarks) {
    if (mark.kind !== 'collection') continue;
    const layer = findLayerById(tree, mark.layerId);
    if (!layer) { missing(mark, 'data-ycode-collection'); continue; }
    const collection = findCollection(collections, mark.collection);
    if (!collection) {
      warn(mark, `Collection "${mark.collection}" not found — the element stayed a static list item. Create it with create_collection, then bind this layer with bind_collection_layer (convert: true)`);
      continue;
    }
    if (!canConvertToCollection(layer)) {
      warn(mark, `data-ycode-collection="${mark.collection}" needs a container element (div, li, article, a); "${layer.name}" was left static`);
      continue;
    }
    const fields = await fieldsOf(collection.id);
    const variable: CollectionVariable = { id: collection.id };
    if (mark.limit) variable.limit = mark.limit;
    if (mark.sort) {
      const sort = resolveSort(mark.sort, fields);
      if ('error' in sort) warn(mark, `data-ycode-sort ignored: ${sort.error}`);
      else Object.assign(variable, sort);
    }
    if (mark.filter) {
      const filters = resolveFilter(mark.filter, fields, tree);
      if (filters && 'error' in filters) warn(mark, `data-ycode-filter ignored: ${filters.error}`);
      else if (filters) variable.filters = filters;
    }
    tree = updateLayerById(tree, layer.id, (l) => ({ ...l, variables: { ...l.variables, collection: variable } }));
    result.collection_lists.push({ layer_id: layer.id, collection_id: collection.id, collection_name: collection.name });
  }

  // The Collection List layer itself (a card linking to its item, a bound
  // background) binds to its own collection, like its descendants do.
  const contextOf = (layerId: string): { collectionId: string; collectionLayerId?: string } | null => {
    const self = findLayerById(tree, layerId);
    const selfCollectionId = self?.variables?.collection?.id;
    if (self && selfCollectionId) return { collectionId: selfCollectionId, collectionLayerId: self.id };
    const parent = findParentCollectionLayer(tree, layerId);
    const parentCollectionId = parent?.variables?.collection?.id;
    if (parent && parentCollectionId) return { collectionId: parentCollectionId, collectionLayerId: parent.id };
    if (deps.pageCollectionId) return { collectionId: deps.pageCollectionId };
    return null;
  };

  for (const mark of cmsMarks) {
    if (mark.kind !== 'field') continue;
    const layer = findLayerById(tree, mark.layerId);
    if (!layer) { missing(mark, 'data-ycode-field'); continue; }
    const ctx = contextOf(layer.id);
    if (!ctx) {
      warn(mark, `data-ycode-field="${mark.field}" is not inside a data-ycode-collection element and this is not a dynamic page; the text stayed static`);
      continue;
    }
    const fields = await fieldsOf(ctx.collectionId);
    const field = findField(fields, mark.field);
    if (!field) {
      warn(mark, `Field "${mark.field}" not found in the collection (fields: ${fieldNames(fields)}); the content stayed static`);
      continue;
    }
    const fieldData = buildFieldData(field, ctx.collectionLayerId ? 'collection' : 'page', ctx.collectionLayerId, undefined);
    const bound = applyFieldBinding(layer, field, fieldData, { target: mark.target });
    if ('error' in bound) { warn(mark, `data-ycode-field="${mark.field}": ${bound.error}`); continue; }
    tree = updateLayerById(tree, layer.id, () => bound.layer);
    result.fields_bound += 1;
  }

  const itemLinkMarks = cmsMarks.filter((m) => m.kind === 'item-link');
  if (itemLinkMarks.length > 0) {
    const pages = await deps.getPages();
    for (const mark of itemLinkMarks) {
      const layer = findLayerById(tree, mark.layerId);
      if (!layer) { missing(mark, 'data-ycode-link'); continue; }
      const ctx = contextOf(layer.id);
      if (!ctx) {
        warn(mark, 'data-ycode-link="item" is not inside a data-ycode-collection element; the link was left as-is');
        continue;
      }
      if (!layer.variables?.link) {
        const check = canLayerHaveLink(layer, tree);
        if (!check.canHaveLinks) {
          warn(mark, `data-ycode-link="item" cannot be placed on "${layer.customName || layer.name}" (${check.issue?.type === 'child' ? 'a child already has a link' : check.issue?.type === 'ancestor' ? 'an ancestor already has a link' : 'unsupported layer'})`);
          continue;
        }
      }
      const page = pages.find((p) => p.is_dynamic && p.settings?.cms?.collection_id === ctx.collectionId);
      if (!page) {
        warn(mark, 'data-ycode-link="item": the collection has no dynamic page yet. Create one (create_page + update_page_settings cms), then link this layer with update_layer_link (link_type "page", no collection_item_id)');
        continue;
      }
      tree = updateLayerById(tree, layer.id, (l) => {
        const existing = l.variables?.link;
        return {
          ...l,
          variables: {
            ...l.variables,
            link: {
              type: 'page',
              page: { id: page.id },
              ...(existing?.target ? { target: existing.target } : {}),
              ...(existing?.rel ? { rel: existing.rel } : {}),
            },
          },
        };
      });
      result.item_links += 1;
    }
  }

  result.layers = tree;
  return result;
}
