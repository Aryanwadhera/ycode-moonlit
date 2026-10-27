import 'server-only';

import { cache } from 'react';
import { parsePathnameForPageHead } from '@/lib/page-head-path';

const getDocumentPathStore = cache((): { pathname?: string } => ({}));

/**
 * Record the public pathname of the document being rendered (request-scoped).
 * Called by the site document layout before its children render.
 */
export function setDocumentPathname(pathname: string): void {
  getDocumentPathStore().pathname = pathname;
}

/**
 * Slug path (no leading slash) of the document being rendered, for boundaries
 * like not-found that receive no route params. Only reliable inside the
 * document layout's children — pages and metadata render in parallel with it.
 */
export function getDocumentSlugPath(): string | undefined {
  const { pathname } = getDocumentPathStore();
  return pathname === undefined ? undefined : parsePathnameForPageHead(pathname).slugPath;
}
