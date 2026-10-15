/**
 * Turns elements marked `data-ycode-component="Name"` in an HTML import into
 * components, leaving an instance where each element was.
 */

import { findLayerById, generateId } from '@/lib/mcp/utils';
import { replaceLayerWithComponentInstance } from '@/lib/layer-utils';
import type { HtmlComponentMark } from '@/lib/html-layer-converter';
import type { Layer } from '@/types';

export interface ImportedComponent {
  component_id: string;
  /** False when an existing component with the same name was reused */
  created: boolean;
  instance_layer_ids: string[];
  /** Refs for layers that moved into the component, keyed like the import refs */
  refs?: Record<string, string>;
}

export interface ComponentExtraction {
  layers: Layer[];
  refs: Record<string, string>;
  components: Record<string, ImportedComponent>;
  warnings: { message: string; path: string; layerId: string }[];
}

type CreateComponent = (name: string, layers: Layer[]) => Promise<string>;

const nameKey = (name: string) => name.trim().toLowerCase();

function descendantIds(layer: Layer, into = new Set<string>()): Set<string> {
  for (const child of layer.children ?? []) {
    into.add(child.id);
    descendantIds(child, into);
  }
  return into;
}

function cloneWithFreshIds(layer: Layer, idMap: Map<string, string>): Layer {
  const id = generateId('lyr');
  idMap.set(layer.id, id);
  return {
    ...layer,
    id,
    ...(layer.children ? { children: layer.children.map((child) => cloneWithFreshIds(child, idMap)) } : {}),
  };
}

/** Interaction tweens target layers by id, so they follow the layers into the master. */
function remapInteractionTargets(layer: Layer, idMap: Map<string, string>): Layer {
  const interactions = layer.interactions?.map((interaction) => ({
    ...interaction,
    tweens: interaction.tweens.map((tween) => ({ ...tween, layer_id: idMap.get(tween.layer_id) ?? tween.layer_id })),
  }));
  return {
    ...layer,
    ...(interactions ? { interactions } : {}),
    ...(layer.children ? { children: layer.children.map((child) => remapInteractionTargets(child, idMap)) } : {}),
  };
}

/**
 * Each mark waits for the marks inside it (so they're already instances in its
 * master) and, for a repeated name, for that name's first occurrence (which
 * becomes the master). Marks in a cycle (a component containing itself) go last.
 */
function processingOrder(layers: Layer[], marks: HtmlComponentMark[], existingNames: Set<string>): HtmlComponentMark[] {
  const firstByName = new Map<string, HtmlComponentMark>();
  for (const mark of marks) {
    if (!firstByName.has(nameKey(mark.name))) firstByName.set(nameKey(mark.name), mark);
  }
  const waitsFor = new Map(marks.map((mark) => {
    const layer = findLayerById(layers, mark.layerId);
    const inner = layer ? descendantIds(layer) : new Set<string>();
    const deps = marks.filter((other) => inner.has(other.layerId));
    const first = firstByName.get(nameKey(mark.name));
    if (first && first !== mark && !existingNames.has(nameKey(mark.name))) deps.push(first);
    return [mark, deps];
  }));

  const order: HtmlComponentMark[] = [];
  const done = new Set<HtmlComponentMark>();
  let pending = [...marks].reverse();
  while (pending.length > 0) {
    const ready = pending.filter((mark) => waitsFor.get(mark)!.every((dep) => done.has(dep)));
    const batch = ready.length > 0 ? ready : pending;
    for (const mark of batch) {
      order.push(mark);
      done.add(mark);
    }
    pending = pending.filter((mark) => !done.has(mark));
  }
  return order;
}

/**
 * Inner marks are handled before outer ones, so a component nested in another
 * becomes an instance inside the outer master. A name matching an existing
 * component (or one created earlier in the same import) reuses it, and the
 * marked element's own content is replaced by that component's.
 */
export async function extractMarkedComponents(
  layers: Layer[],
  marks: HtmlComponentMark[],
  refs: Record<string, string>,
  existing: { id: string; name: string }[],
  createComponent: CreateComponent,
): Promise<ComponentExtraction> {
  const result: ComponentExtraction = { layers, refs: { ...refs }, components: {}, warnings: [] };
  if (marks.length === 0) return result;

  let tree = layers;

  const byName = new Map(existing.map((c) => [nameKey(c.name), c.id]));
  const createdNames = new Map<string, string>();

  for (const mark of processingOrder(layers, marks, new Set(byName.keys()))) {
    const layer = findLayerById(tree, mark.layerId);
    if (!layer) continue;
    if (layer.componentId) {
      result.warnings.push({ message: `data-ycode-component "${mark.name}" is on a layer that is already a component instance; ignored`, path: mark.path, layerId: mark.layerId });
      continue;
    }

    const key = nameKey(mark.name);
    const reuseId = byName.get(key);
    const entry = result.components[createdNames.get(key) ?? mark.name];

    if (reuseId) {
      const createdHere = createdNames.has(key);
      result.warnings.push({
        message: createdHere
          ? `Component "${mark.name}" appears more than once; this copy became an instance showing the first copy's content. Add component variables to vary it per instance`
          : `Reused the existing component "${mark.name}"; the HTML inside this element was discarded`,
        path: mark.path,
        layerId: mark.layerId,
      });
      for (const id of descendantIds(layer)) {
        for (const [refKey, refId] of Object.entries(result.refs)) {
          if (refId === id) delete result.refs[refKey];
        }
      }
      tree = replaceLayerWithComponentInstance(tree, mark.layerId, reuseId);
      if (entry) entry.instance_layer_ids.push(mark.layerId);
      else result.components[mark.name] = { component_id: reuseId, created: false, instance_layer_ids: [mark.layerId] };
      continue;
    }

    const idMap = new Map<string, string>();
    const cloned = cloneWithFreshIds(JSON.parse(JSON.stringify(layer)) as Layer, idMap);
    const master = { ...remapInteractionTargets(cloned, idMap), customName: mark.name };
    const componentId = await createComponent(mark.name, [master]);
    byName.set(key, componentId);
    createdNames.set(key, mark.name);

    const innerRefs: Record<string, string> = {};
    for (const [refKey, refId] of Object.entries(result.refs)) {
      if (refId === mark.layerId) continue;
      const movedTo = idMap.get(refId);
      if (movedTo) {
        innerRefs[refKey] = movedTo;
        delete result.refs[refKey];
      }
    }

    tree = replaceLayerWithComponentInstance(tree, mark.layerId, componentId);
    result.components[mark.name] = {
      component_id: componentId,
      created: true,
      instance_layer_ids: [mark.layerId],
      ...(Object.keys(innerRefs).length > 0 ? { refs: innerRefs } : {}),
    };
  }

  const documentOrder = new Map(marks.map((mark, i) => [mark.layerId, i]));
  for (const entry of Object.values(result.components)) {
    entry.instance_layer_ids.sort((a, b) => documentOrder.get(a)! - documentOrder.get(b)!);
  }

  result.layers = tree;
  return result;
}
