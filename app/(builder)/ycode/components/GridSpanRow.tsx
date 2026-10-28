'use client';

import React, { useCallback, useMemo, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { CollectionFieldSelector, type FieldGroup, type FieldSourceType } from './CollectionFieldSelector';
import { SPAN_FIELD_TYPES, filterFieldGroupsByType, flattenFieldGroups, getFieldName } from '@/lib/collection-field-utils';
import { useEditorStore } from '@/stores/useEditorStore';
import { getInheritedValue } from '@/lib/tailwind-class-mapper';
import type { Breakpoint, Collection, CollectionField, FieldVariable, Layer, UIState } from '@/types';

type SpanProperty = 'gridColumnSpan' | 'gridRowSpan';

/** Tailwind ships `col-span-1` … `col-span-12` plus `col-span-full` (`1 / -1`) */
const SPAN_OPTIONS: { value: string; label: string }[] = [
  ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `Span ${i + 1}` })),
  { value: 'full', label: 'Span all' },
];

/** No class (or `auto`) is the browser default of one cell */
function toSelectValue(value: string): string {
  if (!value || value === 'auto') return '1';
  return value;
}

/**
 * True when a wider breakpoint (or the neutral state) already sets this property, so an
 * explicit class is needed at the current breakpoint to override it.
 */
function inheritsFromWiderBreakpoint(layer: Layer, property: SpanProperty, breakpoint: Breakpoint, uiState: UIState): boolean {
  const classes = Array.isArray(layer.classes)
    ? layer.classes
    : (layer.classes || '').split(' ').filter(Boolean);
  const { value, source } = getInheritedValue(classes, property, breakpoint, uiState);
  return Boolean(value) && source !== breakpoint;
}

interface GridSpanRowProps {
  label: string;
  layer: Layer;
  property: SpanProperty;
  /** Resolved span for the current breakpoint/state ('' when unset) */
  value: string;
  onChange: (property: SpanProperty, value: string | null) => void;
  /** Needed to bind this span to a CMS field, so different collection items can take different spans */
  onLayerUpdate?: (layerId: string, updates: Partial<Layer>) => void;
  fieldGroups?: FieldGroup[];
  allFields?: Record<string, CollectionField[]>;
  collections?: Collection[];
}

/**
 * "Columns" / "Rows" span picker for a grid child: Span 1 … Span 12 and Span all.
 * Shows Span 1 when unset (the browser default). Can also be bound to a CMS
 * number/option field so each item in a collection grid gets its own span.
 */
export default function GridSpanRow({ label, layer, property, value, onChange, onLayerUpdate, fieldGroups, allFields, collections }: GridSpanRowProps) {
  const activeBreakpoint = useEditorStore((s) => s.activeBreakpoint);
  const activeUIState = useEditorStore((s) => s.activeUIState);
  const [fieldMenuOpen, setFieldMenuOpen] = useState(false);

  const handleChange = (next: string) => {
    // Span 1 is the default, so it is stored as "no class" — unless a wider breakpoint
    // spans more, in which case `col-span-1` is a real override and must be written.
    const isDefault = next === '1' && !inheritsFromWiderBreakpoint(layer, property, activeBreakpoint, activeUIState);
    onChange(property, isDefault ? null : next);
  };

  const spanFieldGroups = useMemo(() => {
    if (!fieldGroups) return [];
    return filterFieldGroupsByType(fieldGroups, SPAN_FIELD_TYPES);
  }, [fieldGroups]);

  const spanFields = useMemo(() => flattenFieldGroups(spanFieldGroups), [spanFieldGroups]);
  const hasSpanFields = spanFields.length > 0;

  const currentBinding = layer.variables?.design?.[property];
  const isBound = !!currentBinding?.data?.field_id;
  const boundFieldName = currentBinding?.data?.field_id
    ? getFieldName(spanFields, currentBinding.data.field_id)
    : null;

  const setBinding = useCallback((fieldVar: FieldVariable | undefined) => {
    if (!onLayerUpdate) return;
    const updatedDesign = { ...layer.variables?.design };
    if (fieldVar) {
      updatedDesign[property] = fieldVar;
    } else {
      delete updatedDesign[property];
    }
    const hasBindings = Object.keys(updatedDesign).length > 0;
    onLayerUpdate(layer.id, {
      variables: {
        ...layer.variables,
        design: hasBindings ? updatedDesign : undefined,
      },
    });
  }, [layer, onLayerUpdate, property]);

  const handleBind = useCallback((
    fieldId: string,
    relationshipPath: string[],
    source?: FieldSourceType,
    layerId?: string,
  ) => {
    const field = spanFields.find(f => f.id === fieldId);
    setBinding({
      type: 'field',
      data: {
        field_id: fieldId,
        relationships: relationshipPath,
        field_type: field?.type || null,
        source,
        collection_layer_id: layerId,
      },
    });
    setFieldMenuOpen(false);
  }, [spanFields, setBinding]);

  const handleUnbind = useCallback(() => setBinding(undefined), [setBinding]);

  return (
    <div className="grid grid-cols-3">
      <Label variant="muted">{label}</Label>
      <div className="col-span-2">
        {isBound ? (
          <div className="flex items-center h-8 rounded-lg bg-input px-2.5 gap-2">
            <Icon name="database" className="size-3 text-muted-foreground shrink-0" />
            <Label variant="muted" className="truncate text-xs flex-1">
              {boundFieldName || 'Span field'}
            </Label>
            <button
              type="button"
              className="ml-auto -mr-0.5 p-0.5 rounded-sm opacity-70 hover:opacity-100 transition-opacity cursor-pointer"
              onClick={handleUnbind}
            >
              <Icon name="x" className="size-2.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Select value={toSelectValue(value)} onValueChange={handleChange}>
              <SelectTrigger
                className="w-full"
                aria-label={property === 'gridColumnSpan' ? 'Column span' : 'Row span'}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {SPAN_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {hasSpanFields && onLayerUpdate && (
              <DropdownMenu open={fieldMenuOpen} onOpenChange={setFieldMenuOpen}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="input" size="sm"
                        type="button"
                      >
                        <Icon name="database" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent>Bind to span field</TooltipContent>
                </Tooltip>
                <DropdownMenuContent
                  className="w-56" side="left"
                  align="start"
                >
                  <CollectionFieldSelector
                    fieldGroups={spanFieldGroups}
                    allFields={allFields || {}}
                    collections={collections || []}
                    onSelect={handleBind}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
