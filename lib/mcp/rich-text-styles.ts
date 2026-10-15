/**
 * Pure helpers for rich text element styles (`layer.textStyles`): the keys the
 * editor exposes and the design → classes step shared with the layer pipeline.
 */

import { applyDesignToLayer } from '@/lib/mcp/utils';
import { DEFAULT_TEXT_STYLES } from '@/lib/text-format-utils';
import type { Layer, TextStyle } from '@/types';

/** Element / mark keys a rich text layer can style (the editor's text-style sublayers). */
export const TEXT_STYLE_KEYS = Object.keys(DEFAULT_TEXT_STYLES) as [string, ...string[]];

/**
 * Element styles are stored as a classes + design pair per key, exactly like a
 * layer, so the layer design pipeline can produce them from a pseudo layer.
 */
export function applyTextStyleDesign(
  current: TextStyle,
  design: Record<string, Record<string, unknown>>,
  breakpoint: 'desktop' | 'tablet' | 'mobile',
  uiState: 'neutral' | 'hover' | 'focus' | 'active',
): TextStyle {
  const pseudo: Layer = { id: 'text-style', name: 'text', classes: current.classes ?? '', design: current.design ?? {} };
  const updated = applyDesignToLayer(pseudo, design, breakpoint, uiState);
  return {
    ...current,
    classes: typeof updated.classes === 'string' ? updated.classes : updated.classes.join(' '),
    design: updated.design,
  };
}
