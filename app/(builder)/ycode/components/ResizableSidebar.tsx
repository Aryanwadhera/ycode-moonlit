'use client';

import React from 'react';

import { useResizableSidebar } from '@/hooks/use-resizable-sidebar';
import { cn } from '@/lib/utils';

interface ResizableSidebarProps {
  side: 'left' | 'right';
  storageKey?: string;
  minWidth?: number;
  maxWidth?: number;
  className?: string;
  children: React.ReactNode;
}

/**
 * Fixed-width sidebar column with a drag handle on its inner edge.
 * Double-clicking the handle resets the width to the default.
 */
export default function ResizableSidebar({
  side,
  storageKey,
  minWidth,
  maxWidth,
  className,
  children,
}: ResizableSidebarProps) {
  const { width, isDragging, handleMouseDown } = useResizableSidebar({
    side,
    storageKey,
    minWidth,
    maxWidth,
  });

  return (
    <>
      <div
        className={cn('shrink-0 relative', className)}
        style={{ width: `${width}px` }}
      >
        {children}

        <div
          onMouseDown={handleMouseDown}
          className={cn(
            'absolute top-0 w-3 h-full cursor-col-resize z-30 flex items-center justify-center group/resize',
            side === 'left' ? '-right-1.5' : '-left-1.5',
          )}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
        >
          <div className="w-0.5 h-full bg-transparent group-hover/resize:bg-primary/50 group-active/resize:bg-primary/70 transition-colors" />
        </div>
      </div>

      {/* Keeps the canvas iframe from swallowing mouse events mid-drag */}
      {isDragging && (
        <div className="fixed inset-0 z-50 cursor-col-resize" />
      )}
    </>
  );
}
