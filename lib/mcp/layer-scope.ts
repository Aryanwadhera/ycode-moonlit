/**
 * Resolves where a layer tree lives for tools that work on either a page or a
 * component master (e.g. animations). Pass page_id for page layers, or
 * component_id (+ optional variant_id) for a component variant's layers.
 */

import type { ComponentVariant, Layer } from '@/types';
import { getCachedLayers as getPageLayers, saveCachedLayers } from '@/lib/mcp/page-layers';
import { generateId } from '@/lib/mcp/utils';
import { broadcastComponentLayersUpdated } from '@/lib/mcp/broadcast';
import { getComponentById, updateComponent } from '@/lib/repositories/componentRepository';

export interface LayerScopeInput {
  page_id?: string;
  component_id?: string;
  variant_id?: string;
}

export interface LayerScope {
  /** Human-readable owner, e.g. `page "abc"` or `component "Navigation"`. */
  label: string;
  layers: Layer[];
  save: (layers: Layer[]) => Promise<void>;
}

export const LAYER_SCOPE_HINT = 'Pass page_id for a layer on a page, or component_id (+ optional variant_id) for a layer inside a component master.';

export async function resolveLayerScope(input: LayerScopeInput): Promise<LayerScope | { error: string }> {
  const { page_id, component_id, variant_id } = input;

  if (component_id) {
    const component = await getComponentById(component_id);
    if (!component) return { error: `Component "${component_id}" not found.` };

    const variants: ComponentVariant[] = (component.variants && component.variants.length > 0)
      ? component.variants
      : [{ id: generateId(), name: 'Default', layers: component.layers || [] }];
    const targetIdx = variant_id ? variants.findIndex((v) => v.id === variant_id) : 0;
    if (targetIdx === -1) return { error: `Variant "${variant_id}" not found on component "${component.name}".` };

    return {
      label: `component "${component.name}"${variant_id ? ` (variant ${variants[targetIdx].name})` : ''}`,
      layers: variants[targetIdx].layers || [],
      save: async (layers) => {
        const updatedVariants = variants.map((v, i) => (i === targetIdx ? { ...v, layers } : v));
        await updateComponent(component_id, { variants: updatedVariants });
        broadcastComponentLayersUpdated(component_id, updatedVariants[0].layers).catch(() => {});
      },
    };
  }

  if (page_id) {
    return {
      label: `page "${page_id}"`,
      layers: await getPageLayers(page_id),
      save: async (layers) => {
        await saveCachedLayers(page_id, layers);
      },
    };
  }

  return { error: `Provide page_id or component_id. ${LAYER_SCOPE_HINT}` };
}
