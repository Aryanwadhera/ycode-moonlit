/**
 * Server-side HTML → Layer import.
 *
 * Parses with linkedom (no browser DOM on the server) and hands the document to
 * the shared converter in `lib/html-layer-converter.ts`, so the MCP import and
 * the editor's paste-HTML import produce the same layers.
 */

import { parseHTML } from 'linkedom';

import { documentToLayers } from '@/lib/html-layer-converter';
import type { HtmlImportWarning } from '@/lib/html-layer-converter';
import type { Layer } from '@/types';

export interface ServerHtmlImportResult {
  layers: Layer[];
  warnings: HtmlImportWarning[];
  /** `{ [html id or data-ref]: layerId }` for the imported elements that have one */
  refs: Record<string, string>;
}

export interface ServerHtmlImportOptions {
  /** Html ids already on the target page, so `href="#id"` links to them become native anchors. */
  anchorIds?: Iterable<string>;
}

const DOCUMENT_RE = /<(?:!doctype|html|body)[\s>]/i;

export function htmlToLayersOnServer(html: string, options: ServerHtmlImportOptions = {}): ServerHtmlImportResult {
  // linkedom only builds <head>/<body> for full documents, so wrap fragments.
  const source = DOCUMENT_RE.test(html)
    ? html
    : `<!doctype html><html><head></head><body>${html}</body></html>`;
  const { document } = parseHTML(source);

  const warnings: HtmlImportWarning[] = [];
  const refs: Record<string, string> = {};
  const layers = documentToLayers(document as unknown as Document, {
    warnings,
    refs,
    tailwindV4: true,
    anchorIds: options.anchorIds,
  });
  return { layers, warnings, refs };
}
