import { notFound, redirect, permanentRedirect } from 'next/navigation';
import { unstable_noStore } from 'next/cache';
import type { Metadata } from 'next';
import { fetchPageByPath, fetchErrorPage } from '@/lib/page-fetcher';
import { generateCachedErrorPageMetadata } from '@/lib/not-found-metadata';
import PageRenderer from '@/components/PageRenderer';
import PaginationSeoLinks from '@/components/PaginationSeoLinks';
import PasswordForm from '@/components/PasswordForm';
import { fetchGlobalPageSettings, generatePageMetadata } from '@/lib/generate-page-metadata';
import { getSettingByKey } from '@/lib/repositories/settingsRepository';
import { parseAuthCookie, getPasswordProtection, fetchFoldersForAuth } from '@/lib/page-auth';
import { getPaginationContext, toQueryString } from '@/lib/pagination-context';
import { buildCanonicalPaginationQueryString } from '@/lib/pagination-url-utils';
import { matchRedirect } from '@/lib/redirect-utils';
import { getTenantIdFromHeaders } from '@/lib/supabase-server';
import { getSiteBaseUrl } from '@/lib/url-utils';
import type { Redirect as RedirectType } from '@/types';

// Internal pagination path: always dynamic/no-store.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface DynamicSlugPageProps {
  params: Promise<{ slug: string | string[] }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function DynamicSlugPage({ params, searchParams }: DynamicSlugPageProps) {
  const { slug } = await params;
  const resolvedSearchParams = await searchParams;

  const slugPath = Array.isArray(slug) ? slug.join('/') : slug;
  const currentPath = `/${slugPath}`;

  const redirects = await getSettingByKey('redirects') as RedirectType[] | null;
  if (redirects && Array.isArray(redirects)) {
    const matched = matchRedirect(currentPath, redirects);
    if (matched) {
      if (matched.type === '302') {
        redirect(matched.newUrl);
      } else {
        permanentRedirect(matched.newUrl);
      }
    }
  }

  unstable_noStore();

  const queryString = toQueryString(resolvedSearchParams);
  const paginationContext = getPaginationContext(currentPath, queryString);

  const [data, globalSettings] = await Promise.all([
    fetchPageByPath(slugPath, true, paginationContext),
    fetchGlobalPageSettings(),
  ]);

  // Page not found: hand off to the 404 boundary for a real HTTP 404 status
  // (the custom 404 page is rendered there). Rendering content here would emit
  // a 200 "soft 404", which search engines penalize.
  if (!data) {
    notFound();
  }

  const { page, pageLayers, components, collectionItem, collectionFields, pageCollectionSortedItemIds, pageCollectionSortedItemSlugs, locale, availableLocales, translations } = data;

  const folders = await fetchFoldersForAuth(true);
  const protectionCheck = getPasswordProtection(page, folders, null);

  if (protectionCheck.isProtected) {
    const authCookie = await parseAuthCookie();
    const protection = getPasswordProtection(page, folders, authCookie);

    if (!protection.isUnlocked) {
      const errorPageData = await fetchErrorPage(401, true, undefined, locale?.code);

      if (errorPageData) {
        const { page: errorPage, pageLayers: errorPageLayers, components: errorComponents } = errorPageData;

        return (
          <PageRenderer
            page={errorPage}
            layers={errorPageLayers.layers || []}
            components={errorComponents}
            generatedCss={globalSettings.publishedCss || undefined}
            colorVariablesCss={globalSettings.colorVariablesCss || undefined}
            locale={errorPageData.locale}
            availableLocales={errorPageData.availableLocales}
            translations={errorPageData.translations}
            ycodeBadge={globalSettings.ycodeBadge}
            passwordProtection={{
              pageId: protection.protectedBy === 'page' ? protection.protectedById : undefined,
              folderId: protection.protectedBy === 'folder' ? protection.protectedById : undefined,
              redirectUrl: currentPath,
              isPublished: true,
            }}
          />
        );
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-white">
          <div className="text-center max-w-md px-4">
            <h1 className="text-6xl font-bold text-gray-900 mb-4">401</h1>
            <h2 className="text-2xl font-semibold text-gray-800 mb-4">Password Protected</h2>
            <p className="text-gray-600 mb-8">Enter the password to continue.</p>
            <PasswordForm
              pageId={protection.protectedBy === 'page' ? protection.protectedById : undefined}
              folderId={protection.protectedBy === 'folder' ? protection.protectedById : undefined}
              redirectUrl={currentPath}
              isPublished={true}
            />
          </div>
        </div>
      );
    }
  }

  return (
    <>
      <PaginationSeoLinks
        layers={pageLayers.layers || []}
        basePath={currentPath}
        queryString={queryString}
        baseUrl={getSiteBaseUrl({ globalCanonicalUrl: globalSettings.globalCanonicalUrl })}
      />
      <PageRenderer
        page={page}
        layers={pageLayers.layers || []}
        components={components}
        generatedCss={globalSettings.publishedCss || undefined}
        colorVariablesCss={globalSettings.colorVariablesCss || undefined}
        collectionItem={collectionItem}
        collectionFields={collectionFields}
        pageCollectionSortedItemIds={pageCollectionSortedItemIds}
        pageCollectionSortedItemSlugs={pageCollectionSortedItemSlugs}
        locale={locale}
        availableLocales={availableLocales}
        translations={translations}
        gaMeasurementId={globalSettings.gaMeasurementId}
        globalCustomCodeHead={globalSettings.globalCustomCodeHead}
        globalCustomCodeBody={globalSettings.globalCustomCodeBody}
        ycodeBadge={globalSettings.ycodeBadge}
      />
    </>
  );
}

/**
 * Paginated pages are served from this route, so they need the same metadata as
 * the statically rendered first page — without it pages 2+ fall back to the
 * layout's generic title and carry no canonical. The canonical keeps the `p_*`
 * params so each page self-canonicalizes.
 */
export async function generateMetadata({ params, searchParams }: DynamicSlugPageProps): Promise<Metadata> {
  const { slug } = await params;
  const resolvedSearchParams = await searchParams;

  const slugPath = Array.isArray(slug) ? slug.join('/') : slug;
  const queryString = toQueryString(resolvedSearchParams);
  const paginationContext = getPaginationContext(`/${slugPath}`, queryString);

  const [data, globalSettings, resolvedTenantId] = await Promise.all([
    fetchPageByPath(slugPath, true, paginationContext),
    fetchGlobalPageSettings(),
    getTenantIdFromHeaders(),
  ]);
  const tenantId = resolvedTenantId ?? undefined;

  if (!data) {
    return generateCachedErrorPageMetadata(404, slugPath, { globalSeoSettings: globalSettings, tenantId });
  }

  // Don't leak metadata for protected pages — the page component gates access.
  const folders = await fetchFoldersForAuth(true);
  if (getPasswordProtection(data.page, folders, null).isProtected) {
    return generateCachedErrorPageMetadata(401, slugPath, { globalSeoSettings: globalSettings, tenantId });
  }

  const metadata = await generatePageMetadata(data.page, {
    fallbackTitle: slugPath.charAt(0).toUpperCase() + slugPath.slice(1),
    collectionItem: data.collectionItem,
    pagePath: `/${slugPath}`,
    pageQuery: buildCanonicalPaginationQueryString(data.pageLayers.layers || [], queryString),
    globalSeoSettings: globalSettings,
    translations: data.translations,
  });

  const baseUrl = getSiteBaseUrl({ globalCanonicalUrl: globalSettings.globalCanonicalUrl });
  if (baseUrl) {
    try { metadata.metadataBase = new URL(baseUrl); } catch { /* invalid URL */ }
  }

  return metadata;
}
