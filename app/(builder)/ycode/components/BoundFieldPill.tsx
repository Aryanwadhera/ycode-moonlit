'use client';

import React from 'react';
import Icon from '@/components/ui/icon';
import { Label } from '@/components/ui/label';

interface BoundFieldPillProps {
  /** Display name of the bound CMS field */
  label: string;
  onUnbind: () => void;
}

/** Shown in place of a design control while it is bound to a CMS field */
export default function BoundFieldPill({ label, onUnbind }: BoundFieldPillProps) {
  return (
    <div className="flex items-center h-8 rounded-lg bg-input px-2.5 gap-2">
      <Icon name="database" className="size-3 text-muted-foreground shrink-0" />
      <Label variant="muted" className="truncate text-xs flex-1">
        {label}
      </Label>
      <button
        type="button"
        aria-label="Remove field binding"
        className="ml-auto -mr-0.5 p-0.5 rounded-sm opacity-70 hover:opacity-100 transition-opacity cursor-pointer"
        onClick={onUnbind}
      >
        <Icon name="x" className="size-2.5" />
      </button>
    </div>
  );
}
