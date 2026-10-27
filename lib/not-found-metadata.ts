import 'server-only';

import type { Metadata } from 'next';
import { generateErrorPageMetadata } from '@/lib/generate-page-metadata';
import type { GlobalPageSettings } from '@/lib/generate-page-metadata';
import { fetchCachedErrorPage, fetchCachedPageForMetadata } from '@/lib/published-page-cache';

export interface Custom404MetadataOptions {
  /** Pre-fetched global settings (avoids a duplicate lookup) */
  globalSeoSettings?: GlobalPageSettings;
  tenantId?: string;
}

/**
 * Merge the custom 404 page's SEO into a layout's metadata when the requested
 * slug resolves to no published page.
 *
 * Next.js discards a page's `generateMetadata` output once the page calls
 * `notFound()`, keeping only the layout's — so the custom 404 page's title and
 * description have to be emitted from the layout to reach the document head.
 * Slugs that do resolve return `siteMetadata` untouched; the page then
 * overrides it with its own metadata.
 *
 * @param slugPath - Requested path without the leading slash ('' for the homepage)
 * @param siteMetadata - The layout's own metadata, used as the base
 */
export async function withCustom404Metadata(
  slugPath: string,
  siteMetadata: Metadata,
  options: Custom404MetadataOptions = {}
): Promise<Metadata> {
  const { globalSeoSettings, tenantId } = options;

  // The homepage renders a welcome screen instead of a 404 when no index page
  // exists, so it never reaches the not-found boundary.
  if (!slugPath) {
    return siteMetadata;
  }

  const page = await fetchCachedPageForMetadata(slugPath, tenantId).catch(() => null);
  if (page) {
    return siteMetadata;
  }

  const errorPageData = await fetchCachedErrorPage(404, tenantId, slugPath).catch(() => null);
  const errorMetadata = await generateErrorPageMetadata(404, errorPageData?.page ?? null, {
    globalSeoSettings,
    tenantId,
  });

  return { ...siteMetadata, ...errorMetadata };
}
