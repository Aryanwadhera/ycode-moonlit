/**
 * HTML ↔ Layer bidirectional converter
 *
 * Import: Parse an HTML string into a Layer[] tree, converting Tailwind classes
 *         to design properties and mapping HTML elements to Ycode layer types.
 *
 * Export: Convert a Layer tree back into clean HTML with Tailwind classes.
 */

import type { Layer, LinkSettings } from '@/types';
import { generateId } from '@/lib/utils';
import { classesToDesign, getAffectedProperties } from '@/lib/tailwind-class-mapper';
import { getClassesString, getLayerHtmlTag, isLeafLayer } from '@/lib/layer-utils';
import { getTiptapTextContent } from '@/lib/text-format-utils';
import { escapeHtml } from '@/lib/escape-html';
import { generateLinkHref, isValidLinkSettings } from '@/lib/link-utils';
import type { LinkResolutionContext } from '@/lib/link-utils';
import { normalizeV3ToV4, resolveNamedColors } from '@/lib/tailwind-normalizer';
import { convertGradientClasses, convertMobileFirstClasses, normalizeNegativeMargins, normalizePositionClasses } from '@/lib/html-import-classes';
import { cssToClasses } from '@/lib/import/css';

// Numeric node types instead of the `Node` global, which server-side DOMs don't define.
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** Something the import dropped or could not convert faithfully. */
/**
 * error — content was lost or a binding did not take effect.
 * warning — something was converted or approximated and may need a follow-up.
 * hint — the markup renders as written but has no control in the design panel.
 */
export type HtmlImportSeverity = 'error' | 'warning' | 'hint';

export interface HtmlImportWarning {
  message: string;
  /** Defaults to "warning" when a producer doesn't say. */
  severity?: HtmlImportSeverity;
  /** Element path in the source HTML, e.g. `section[1] > div[2] > img[1]` */
  path: string;
  /** Created layer the warning applies to, when one exists */
  layerId?: string;
}

export interface HtmlImportOptions {
  /** Receives a warning for every dropped or lossily converted element, attribute, or class. */
  warnings?: HtmlImportWarning[];
  /**
   * Input classes are already Tailwind v4, so v3 → v4 size rescaling
   * (rounded → rounded-sm, …) is skipped.
   */
  tailwindV4?: boolean;
  /** Receives `{ [html id or data-ref]: layerId }` for every imported element that has one. */
  refs?: Record<string, string>;
  /** Html ids already on the target page, so `href="#id"` links to them become native anchors. */
  anchorIds?: Iterable<string>;
  /**
   * Receives anchor links the converter could not resolve locally (`#id` with
   * no such element here or on the page, and any `/path#id`), so the caller can
   * point them at the page that holds the id. Without it they stay URLs and are
   * reported as warnings.
   */
  unresolvedLinks?: HtmlUnresolvedLink[];
  /**
   * Receives every element marked `data-ycode-component="Name"`, in document
   * order. Without it the attribute is dropped with a warning.
   */
  componentMarks?: HtmlComponentMark[];
  /**
   * Receives every CMS / interaction annotation (`data-ycode-collection`,
   * `data-ycode-field`, `data-ycode-link`, `data-ycode-toggle`, `data-ycode-menu`),
   * in document order. Without it the attributes are dropped with a warning.
   */
  ycodeMarks?: HtmlYcodeMark[];
}

export interface HtmlComponentMark {
  name: string;
  layerId: string;
  path: string;
}

/** An element annotated with one of the `data-ycode-*` import attributes. */
export type HtmlYcodeMark =
  | { kind: 'collection'; layerId: string; path: string; collection: string; limit?: number; sort?: string; filter?: string }
  | { kind: 'field'; layerId: string; path: string; field: string; target: 'auto' | 'alt' | 'background' }
  | { kind: 'item-link'; layerId: string; path: string }
  | { kind: 'toggle'; layerId: string; path: string; name: string }
  | { kind: 'menu'; layerId: string; path: string; name: string };

/**
 * A site-internal link (`#id`, `/path`, `/path#id`) that the converter could not
 * resolve by itself: the anchor id isn't in the imported HTML or on the target
 * page, or the href names another page. At least one of `anchorId` / `pagePath`
 * is set.
 */
export interface HtmlUnresolvedLink {
  layerId: string;
  /** The `id` after `#`, when the href has one. */
  anchorId?: string;
  /** Element path in the source HTML. */
  path: string;
  /** Site path for `/path`, `/path#id` and `/#id` hrefs; absent for plain `#id`. */
  pagePath?: string;
}

export interface ParsedSiteHref {
  anchorId?: string;
  pagePath?: string;
}

interface PendingAnchor extends ParsedSiteHref {
  layer: Layer;
  path: string;
}

/**
 * Splits site-internal hrefs: `#id`, `/`, `/path`, `/path#id`. Returns null for
 * anything that should stay a plain URL — external and protocol-relative URLs,
 * `#` alone, query strings, and paths to files (`/sitemap.xml`).
 */
export function parseSiteHref(href: string): ParsedSiteHref | null {
  const hash = href.indexOf('#');
  const before = hash === -1 ? href : href.slice(0, hash);
  const anchorId = hash === -1 ? undefined : href.slice(hash + 1);
  if (anchorId === '') return null;
  if (before === '') return anchorId === undefined ? null : { anchorId };
  if (!before.startsWith('/') || before.startsWith('//') || before.includes('?')) return null;
  const pagePath = before.length > 1 ? before.replace(/\/+$/, '') : '/';
  if (/\.[a-z0-9]+$/i.test(pagePath)) return null;
  return anchorId === undefined ? { pagePath } : { anchorId, pagePath };
}

interface ImportContext {
  warnings: HtmlImportWarning[] | null;
  rescaleSizes: boolean;
  refs: Record<string, string>;
  /** Ref keys assigned from tag names, which explicit ids/data-refs may take over. */
  tagRefs: Set<string>;
  tagRefCounts: Record<string, number>;
  htmlIds: Set<string>;
  pendingAnchors: PendingAnchor[];
  unresolvedLinks: HtmlUnresolvedLink[] | null;
  componentMarks: HtmlComponentMark[] | null;
  ycodeMarks: HtmlYcodeMark[] | null;
}

function warn(ctx: ImportContext, path: string, message: string, layerId?: string, severity: HtmlImportSeverity = 'warning'): void {
  ctx.warnings?.push({ message, severity, path, ...(layerId ? { layerId } : {}) });
}

/** Returns the URL only if it's absolute, otherwise undefined (relative paths become placeholders). */
function resolveAbsoluteUrl(url: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'data:') {
      return url;
    }
  } catch { /* relative path */ }
  return undefined;
}

// ─── Tag → Layer Name Mapping ───

const TAG_TO_LAYER_NAME: Record<string, string> = {
  // Structure — maps to valid Ycode layer names
  div: 'div',
  section: 'section',
  header: 'div',
  footer: 'div',
  main: 'div',
  aside: 'div',
  article: 'div',
  nav: 'div',
  figure: 'div',
  figcaption: 'div',
  blockquote: 'div',
  details: 'div',
  summary: 'div',
  dialog: 'div',
  address: 'div',
  fieldset: 'div',
  legend: 'div',
  hgroup: 'div',
  search: 'div',

  // Links — treated as div with link settings
  a: 'div',

  // Text / inline content
  p: 'text',
  span: 'span',
  label: 'label',
  strong: 'span',
  b: 'span',
  em: 'span',
  i: 'span',
  u: 'span',
  s: 'span',
  del: 'span',
  ins: 'span',
  mark: 'span',
  small: 'span',
  sub: 'span',
  sup: 'span',
  abbr: 'span',
  cite: 'span',
  code: 'span',
  kbd: 'span',
  samp: 'span',
  var: 'span',
  time: 'span',
  data: 'span',
  q: 'span',
  dfn: 'span',
  ruby: 'span',
  rt: 'span',
  rp: 'span',
  bdi: 'span',
  bdo: 'span',
  wbr: 'span',

  // Headings
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',

  // Media
  img: 'image',
  picture: 'div',
  source: 'div',
  video: 'video',
  audio: 'audio',
  track: 'div',
  canvas: 'div',
  svg: 'icon',

  // Embeds
  iframe: 'iframe',
  embed: 'div',
  object: 'div',

  // Forms
  form: 'form',
  button: 'button',
  input: 'input',
  textarea: 'textarea',
  select: 'select',
  option: 'div',
  optgroup: 'div',
  datalist: 'div',
  output: 'div',
  progress: 'div',
  meter: 'div',

  // Lists → div (with semantic tag preserved)
  ul: 'div',
  ol: 'div',
  li: 'div',
  dl: 'div',
  dt: 'div',
  dd: 'div',
  menu: 'div',

  // Tables → div (with semantic tag preserved)
  table: 'div',
  caption: 'div',
  colgroup: 'div',
  col: 'div',
  thead: 'div',
  tbody: 'div',
  tfoot: 'div',
  tr: 'div',
  td: 'div',
  th: 'div',

  // Separators
  hr: 'hr',

  // Preformatted
  pre: 'div',
};

const SEMANTIC_TAG_OVERRIDE: Record<string, string> = {
  header: 'header',
  footer: 'footer',
  main: 'main',
  aside: 'aside',
  article: 'article',
  nav: 'nav',
  ul: 'ul',
  ol: 'ol',
  li: 'li',
  dl: 'dl',
  dt: 'dt',
  dd: 'dd',
  blockquote: 'blockquote',
  pre: 'pre',
  figure: 'figure',
  figcaption: 'figcaption',
  details: 'details',
  summary: 'summary',
  table: 'table',
  caption: 'caption',
  thead: 'thead',
  tbody: 'tbody',
  tfoot: 'tfoot',
  tr: 'tr',
  td: 'td',
  th: 'th',
  fieldset: 'fieldset',
  legend: 'legend',
  address: 'address',
  menu: 'menu',
  search: 'search',
};

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const CONTAINER_NAMES = new Set([
  'div', 'section', 'form', 'button', 'label',
]);

const SELF_CLOSING_TAGS = new Set([
  'img', 'input', 'hr', 'br', 'meta', 'link', 'source', 'track', 'wbr',
]);

const INLINE_TEXT_TAGS = new Set([
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'small',
  'sub', 'sup', 'abbr', 'cite', 'code', 'kbd', 'samp', 'var', 'time',
  'data', 'q', 'dfn', 'ruby', 'rt', 'rp', 'bdi', 'bdo', 'wbr',
  'a', 'span',
]);

// ─── Inline Style → Tailwind Classes ───

/**
 * Convert an inline `style` declaration block to Tailwind classes.
 * Delegates to the shared mapper in `lib/import/css.ts` so HTML import and the
 * Webflow/Figma importers stay in lockstep.
 */
function styleToClasses(style: string): string[] {
  return cssToClasses(style);
}

// ─── TipTap Rich Text Builder ───

type TiptapMark = { type: string; attrs?: Record<string, any> };
type TiptapNode =
  | { type: 'text'; text: string; marks?: TiptapMark[] }
  | { type: 'hardBreak' };

const HTML_TAG_TO_MARK: Record<string, string> = {
  strong: 'bold', b: 'bold',
  em: 'italic', i: 'italic',
  u: 'underline', ins: 'underline',
  s: 'strike', del: 'strike',
  sub: 'subscript', sup: 'superscript',
  code: 'code', kbd: 'code',
};

function collectInlineNodes(node: Node, marks: TiptapMark[], ctx: ImportContext, path: string): TiptapNode[] {
  const nodes: TiptapNode[] = [];

  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];

    if (child.nodeType === TEXT_NODE) {
      const text = child.textContent || '';
      if (text) {
        nodes.push({
          type: 'text',
          text,
          ...(marks.length > 0 ? { marks: [...marks] } : {}),
        });
      }
      continue;
    }

    if (child.nodeType !== ELEMENT_NODE) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();

    if (tag === 'br') {
      nodes.push({ type: 'hardBreak' });
      continue;
    }

    warnInlineAttributes(el, tag, ctx, path);

    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      const target = el.getAttribute('target');
      const rel = el.getAttribute('rel');
      const linkMark: TiptapMark = {
        type: 'richTextLink',
        attrs: {
          type: 'url' as const,
          url: { type: 'dynamic_text' as const, data: { content: href } },
          ...(target ? { target } : {}),
          ...(rel ? { rel } : {}),
        },
      };
      nodes.push(...collectInlineNodes(el, [...marks, linkMark], ctx, path));
      continue;
    }

    const markType = HTML_TAG_TO_MARK[tag];
    if (markType) {
      nodes.push(...collectInlineNodes(el, [...marks, { type: markType }], ctx, path));
    } else {
      nodes.push(...collectInlineNodes(el, marks, ctx, path));
    }
  }

  return nodes;
}

/** Rich text keeps the text and marks of inline elements, but not their classes or attributes. */
function warnInlineAttributes(el: Element, tag: string, ctx: ImportContext, path: string): void {
  if (!ctx.warnings) return;
  const kept = tag === 'a' ? LINK_ATTRS : [];
  const names = Array.from(el.attributes).map((attr) => attr.name);
  const marks = names.filter((name) => YCODE_ATTRIBUTES.has(name));
  if (marks.length > 0) {
    warn(ctx, `${path} > ${tag}`, `${marks.join(', ')} on an inline <${tag}> inside running text was ignored — rich text has no per-word bindings. Put the attribute on the block element, or bind mixed text afterwards with set_dynamic_text`, 'error');
  }
  const dropped = names.filter((name) => !kept.includes(name) && !YCODE_ATTRIBUTES.has(name));
  if (dropped.length > 0) {
    warn(ctx, `${path} > ${tag}`, `Inline <${tag}> inside text lost its ${dropped.join(', ')} (rich text keeps only text, bold/italic/underline/strike/code/sub/sup marks, and links)`);
  }
}

function buildRichTextDoc(el: Element, ctx: ImportContext, path: string) {
  const inlineNodes = collectInlineNodes(el, [], ctx, path);
  return {
    type: 'doc' as const,
    content: [{
      type: 'paragraph' as const,
      content: inlineNodes.length > 0 ? inlineNodes : [],
    }],
  };
}

// ─── Import: HTML → Layers ───

function isTextOnlyElement(el: Element): boolean {
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i];
    if (node.nodeType === ELEMENT_NODE) {
      const child = node as Element;
      const tag = child.tagName.toLowerCase();
      if (tag !== 'br' && !INLINE_TEXT_TAGS.has(tag)) return false;
      // Inline wrappers (e.g. <a>) may contain block-level elements like <img>
      if (INLINE_TEXT_TAGS.has(tag) && !isTextOnlyElement(child)) return false;
    }
  }
  return true;
}

const FLEX_OR_GRID_DISPLAY = new Set(['flex', 'inline-flex', 'grid', 'inline-grid']);

/**
 * Inline-only children stay separate layers when they act as items rather than
 * text: the parent lays them out (flex/grid) or they carry their own styling,
 * as in nav links, button rows, and pills. Loose text next to them means they
 * sit inside a sentence, so they merge into rich text instead.
 */
function keepsInlineChildrenAsLayers(el: Element): boolean {
  let hasElementChild = false;
  let hasStyledChild = false;
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i];
    if (node.nodeType === TEXT_NODE) {
      if ((node.textContent || '').trim()) return false;
    } else if (node.nodeType === ELEMENT_NODE) {
      const child = node as Element;
      if (child.tagName.toLowerCase() === 'br') continue;
      hasElementChild = true;
      if (child.getAttribute('class')?.trim() || child.getAttribute('style')?.trim() || child.getAttribute('id') || hasYcodeMark(child)) {
        hasStyledChild = true;
      }
    }
  }
  if (!hasElementChild) return false;
  if (hasStyledChild) return true;

  const classes = (el.getAttribute('class') || '').split(/\s+/);
  return classes.some((cls) => FLEX_OR_GRID_DISPLAY.has(cls.slice(cls.lastIndexOf(':') + 1)));
}

const TEXT_LAYER_NAMES = new Set(['text', 'heading', 'span']);

const LAYER_NAME_LABELS: Record<string, string> = {
  heading: 'Heading',
  text: 'Text',
  span: 'Text',
};

function makeRichTextVariable(textOrDoc: string | object) {
  const content = typeof textOrDoc === 'string'
    ? getTiptapTextContent(textOrDoc)
    : textOrDoc;
  return {
    type: 'dynamic_rich_text' as const,
    data: { content },
  };
}

function makeTextLayer(textOrDoc: string | object): Layer {
  return {
    id: generateId('lyr'),
    name: 'text',
    classes: '',
    restrictions: { editText: true },
    variables: { text: makeRichTextVariable(textOrDoc) },
  };
}

function cleanDesign(design: Layer['design']): Layer['design'] | undefined {
  if (!design) return undefined;

  const cleaned: Record<string, any> = {};
  let hasValues = false;

  for (const [category, properties] of Object.entries(design)) {
    if (!properties || typeof properties !== 'object') continue;
    const nonEmpty = Object.keys(properties).length > 0;
    if (nonEmpty) {
      cleaned[category] = { isActive: true, ...properties };
      hasValues = true;
    }
  }

  return hasValues ? (cleaned as Layer['design']) : undefined;
}

function defaultDisplayOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === 'button' || tag === 'img' || tag === 'input' || tag === 'select' || tag === 'textarea') return 'inline-block';
  if (INLINE_TEXT_TAGS.has(tag) || tag === 'label') return 'inline';
  return 'block';
}

function resolveImportClasses(el: Element, ctx: ImportContext, path: string, layerId: string): string {
  const classAttr = el.getAttribute('class') || '';
  const styleAttr = el.getAttribute('style') || '';

  const htmlClasses = classAttr.split(/\s+/).filter(Boolean);
  const inlineClasses = styleAttr ? styleToClasses(styleAttr) : [];

  const merged = [...htmlClasses, ...inlineClasses];
  const normalized = normalizeV3ToV4(merged, { rescaleSizes: ctx.rescaleSizes });
  const named = resolveNamedColors(normalized);
  const withGradients = convertGradientClasses(normalizeNegativeMargins(normalizePositionClasses(named)));
  const { classes: resolved, approximated } = convertMobileFirstClasses(withGradients, defaultDisplayOf(el));

  if (ctx.warnings) {
    warnDroppedStyles(styleAttr, ctx, path, layerId);
    for (const cls of approximated) {
      warn(ctx, path, `"${cls}" was approximated: Ycode's mobile breakpoint covers everything below 768px, so mobile uses the unprefixed value`, layerId, 'hint');
    }
    for (const cls of resolved) warnClass(cls, ctx, path, layerId);
  }

  return resolved.join(' ');
}

function warnDroppedStyles(styleAttr: string, ctx: ImportContext, path: string, layerId: string): void {
  for (const decl of styleAttr.split(';').map((d) => d.trim()).filter(Boolean)) {
    if (styleToClasses(decl).length === 0) {
      warn(ctx, path, `Inline style "${decl}" was dropped (no Tailwind equivalent)`, layerId);
    }
  }
}

const VARIANT_PREFIX_RE = /^((?:[a-z0-9-]+:)+)/;
const MOBILE_FIRST_BREAKPOINTS = new Set(['sm', 'md', 'lg', 'xl', '2xl']);
const EDITABLE_BREAKPOINT_VARIANTS = new Set(['max-lg', 'max-md']);
const EDITABLE_STATE_VARIANTS = new Set(['hover', 'focus', 'active', 'disabled', 'current', 'visited']);
/** Render-only classes with no design-panel control that nobody needs to edit. */
const SILENT_RAW_CLASSES = new Set(['antialiased', 'subpixel-antialiased']);

/**
 * Classes always render, but the design panel only shows breakpoint/state
 * variants it knows and utilities it can attribute to a design property.
 */
function warnClass(cls: string, ctx: ImportContext, path: string, layerId: string): void {
  const prefix = cls.match(VARIANT_PREFIX_RE)?.[1] ?? '';
  const variants = prefix.split(':').filter(Boolean);
  const base = cls.slice(prefix.length);

  const mobileFirst = variants.find((v) => MOBILE_FIRST_BREAKPOINTS.has(v));
  if (mobileFirst) {
    warn(ctx, path, `Mobile-first prefix "${mobileFirst}:" (in "${cls}") renders, but couldn't be converted to Ycode's desktop-first breakpoints (no unprefixed value for the same property, or xl:/2xl:), so it can't be edited per breakpoint. Use unprefixed classes for desktop, "max-lg:" for tablet and "max-md:" for mobile`, layerId, 'hint');
    return;
  }

  const breakpoints = variants.filter((v) => EDITABLE_BREAKPOINT_VARIANTS.has(v));
  const states = variants.filter((v) => EDITABLE_STATE_VARIANTS.has(v));
  const isEditableVariant = breakpoints.length <= 1
    && states.length <= 1
    && breakpoints.length + states.length === variants.length
    && (breakpoints.length === 0 || variants[0] === breakpoints[0]);
  if (!isEditableVariant) {
    warn(ctx, path, `Variant "${prefix}" (in "${cls}") renders, but has no control in the design panel`, layerId, 'hint');
    return;
  }

  if (getAffectedProperties(base).length === 0 && !SILENT_RAW_CLASSES.has(base)) {
    warn(ctx, path, `Class "${base}" renders, but has no control in the design panel (editable only as a raw class)`, layerId, 'hint');
  }
}

/** Removes scripts and event handlers; returns how many were removed. */
function sanitizeSvg(el: Element): number {
  let removed = 0;
  el.querySelectorAll('script').forEach(s => {
    s.remove();
    removed++;
  });
  const walk = (node: Element) => {
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) {
        node.removeAttribute(attr.name);
        removed++;
      }
    }
    for (let i = 0; i < node.children.length; i++) {
      walk(node.children[i]);
    }
  };
  walk(el);
  return removed;
}

const DROPPED_TAGS = new Set(['script', 'style', 'link', 'meta', 'br']);

const DROPPED_TAG_HINTS: Record<string, string> = {
  style: 'express styles as Tailwind classes',
  script: 'add scripts via page custom code',
  br: 'use gap or margin between blocks',
};

/** Tags imported as a plain div, losing their native behavior or content. */
const LOSSY_TAGS = new Set([
  'picture', 'source', 'track', 'canvas', 'embed', 'object', 'option', 'optgroup',
  'datalist', 'output', 'progress', 'meter', 'dialog',
]);

const LINK_ATTRS = ['href', 'target', 'rel'];

/** Boolean form attributes stored as `true` on the layer (the editor's input settings toggle them). */
const BOOLEAN_FIELD_ATTRS = ['required', 'disabled', 'checked', 'readonly', 'multiple'];
/** Valued form attributes copied verbatim onto input / textarea / select layers. */
const FIELD_ATTRS = ['name', 'placeholder', 'autocomplete', 'value', 'min', 'max', 'step', 'minlength', 'maxlength', 'pattern', 'inputmode'];

/** Attributes each tag maps into the layer (besides class/style/id and the accessibility set). */
const IMPORTED_ATTRS: Record<string, string[]> = {
  a: LINK_ATTRS,
  img: ['src', 'alt', 'width', 'height'],
  button: ['type', 'disabled'],
  input: ['type', ...FIELD_ATTRS, ...BOOLEAN_FIELD_ATTRS],
  textarea: ['rows', ...FIELD_ATTRS, ...BOOLEAN_FIELD_ATTRS],
  select: [...FIELD_ATTRS, ...BOOLEAN_FIELD_ATTRS],
  option: ['value', 'selected', 'disabled'],
  form: ['action', 'method', 'name'],
  iframe: ['src'],
  video: ['src', 'controls', 'loop', 'muted', 'autoplay'],
  audio: ['src', 'controls', 'loop', 'muted', 'autoplay'],
};

/**
 * Accessibility / semantics attributes kept on every element as custom
 * attributes (editable in the settings panel): aria-*, role, title, tabindex.
 */
function isAccessibilityAttribute(name: string): boolean {
  return name.startsWith('aria-') || name === 'role' || name === 'title' || name === 'tabindex';
}

/** Tags converted before the `id` attribute is read. */
const ID_DROPPING_TAGS = new Set(['img', 'input', 'textarea', 'select', 'iframe', 'video', 'audio']);

function warnDroppedAttributes(el: Element, tag: string, ctx: ImportContext, path: string, layerId: string): void {
  if (!ctx.warnings || tag === 'svg') return;
  const imported = IMPORTED_ATTRS[tag] || [];
  const dropped = Array.from(el.attributes)
    .map((attr) => attr.name)
    .filter((name) => name !== 'class' && name !== 'style' && name !== 'data-ref' && !YCODE_ATTRIBUTES.has(name) && !imported.includes(name)
      && !isAccessibilityAttribute(name)
      && !(name === 'id' && !ID_DROPPING_TAGS.has(tag)));
  if (dropped.length > 0) {
    warn(ctx, path, `Attributes dropped from <${tag}>: ${dropped.join(', ')}`, layerId);
  }
}

/** Copies aria-*, role, title and tabindex into the layer's custom attributes. */
function importAccessibilityAttributes(el: Element, layer: Layer): void {
  const custom: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (isAccessibilityAttribute(attr.name)) custom[attr.name] = attr.value;
  }
  if (Object.keys(custom).length === 0) return;
  layer.settings = { ...layer.settings, customAttributes: { ...layer.settings?.customAttributes, ...custom } };
}

/** Reads the form-field attributes of an input / textarea / select into `layer.attributes`. */
function importFieldAttributes(el: Element, layer: Layer): void {
  const attrs: Record<string, string | boolean> = { ...layer.attributes };
  for (const name of FIELD_ATTRS) {
    const value = el.getAttribute(name);
    if (value) attrs[name] = value;
  }
  for (const name of BOOLEAN_FIELD_ATTRS) {
    if (el.hasAttribute(name)) attrs[name] = true;
  }
  layer.attributes = attrs;
}

/** Converts a <select>'s <option> children into the option layers the select element uses. */
function optionsToLayers(select: Element): Layer[] {
  return Array.from(select.querySelectorAll('option')).map((option) => {
    const value = option.getAttribute('value') ?? option.textContent?.trim() ?? '';
    const isPlaceholder = option.hasAttribute('disabled') && (value === '' || option.hasAttribute('hidden'));
    const layer: Layer = {
      id: generateId('lyr'),
      name: 'option',
      classes: '',
      attributes: {
        value,
        ...(option.hasAttribute('selected') ? { selected: 'true' } : {}),
        ...(option.hasAttribute('disabled') ? { disabled: 'true' } : {}),
        ...(option.hasAttribute('hidden') ? { hidden: 'true' } : {}),
      },
      variables: {
        text: { type: 'dynamic_text', data: { content: option.textContent?.trim() ?? '' } },
      },
    };
    if (isPlaceholder) layer.settings = { isPlaceholder: true };
    return layer;
  });
}

function warnRelativeSrc(el: Element, tag: string, ctx: ImportContext, path: string, layerId: string, hint: string): void {
  const rawSrc = el.getAttribute('src');
  if (!rawSrc) {
    warn(ctx, path, `<${tag}> has no src; ${hint}`, layerId, 'error');
  } else if (!resolveAbsoluteUrl(rawSrc)) {
    warn(ctx, path, `<${tag}> src "${rawSrc}" is not an absolute URL and was dropped; ${hint}`, layerId, 'error');
  }
}

const COMPONENT_ATTRIBUTE = 'data-ycode-component';
const COLLECTION_ATTRIBUTE = 'data-ycode-collection';
const FIELD_ATTRIBUTE = 'data-ycode-field';
const FIELD_ALT_ATTRIBUTE = 'data-ycode-field-alt';
const FIELD_BG_ATTRIBUTE = 'data-ycode-field-bg';
const ITEM_LINK_ATTRIBUTE = 'data-ycode-link';
const TOGGLE_ATTRIBUTE = 'data-ycode-toggle';
const MENU_ATTRIBUTE = 'data-ycode-menu';
const PREVIEW_ONLY_ATTRIBUTES = ['data-ycode-preview-only', 'data-preview-only'];

/** Import-only annotations: consumed by the importer, never kept on the layer or reported as dropped. */
const YCODE_ATTRIBUTES = new Set([
  COMPONENT_ATTRIBUTE, COLLECTION_ATTRIBUTE, 'data-ycode-limit', 'data-ycode-sort', 'data-ycode-filter',
  FIELD_ATTRIBUTE, FIELD_ALT_ATTRIBUTE, FIELD_BG_ATTRIBUTE, ITEM_LINK_ATTRIBUTE, TOGGLE_ATTRIBUTE, MENU_ATTRIBUTE,
  ...PREVIEW_ONLY_ATTRIBUTES,
]);

/** Whether an element carries any `data-ycode-*` annotation (such elements always stay their own layer). */
function hasYcodeMark(el: Element): boolean {
  return Array.from(el.attributes).some((attr) => attr.name !== COMPONENT_ATTRIBUTE && YCODE_ATTRIBUTES.has(attr.name));
}

/** Pushes the element's CMS / interaction annotations onto the context, or warns when the import can't use them. */
function readYcodeMarks(el: Element, ctx: ImportContext, path: string, layerId: string): void {
  const marks: HtmlYcodeMark[] = [];
  const collection = el.getAttribute(COLLECTION_ATTRIBUTE)?.trim();
  if (collection) {
    const limitRaw = el.getAttribute('data-ycode-limit')?.trim();
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
    const sort = el.getAttribute('data-ycode-sort')?.trim();
    const filter = el.getAttribute('data-ycode-filter')?.trim();
    marks.push({
      kind: 'collection', layerId, path, collection,
      ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      ...(sort ? { sort } : {}),
      ...(filter ? { filter } : {}),
    });
  }
  const field = el.getAttribute(FIELD_ATTRIBUTE)?.trim();
  if (field) marks.push({ kind: 'field', layerId, path, field, target: 'auto' });
  const fieldAlt = el.getAttribute(FIELD_ALT_ATTRIBUTE)?.trim();
  if (fieldAlt) marks.push({ kind: 'field', layerId, path, field: fieldAlt, target: 'alt' });
  const fieldBg = el.getAttribute(FIELD_BG_ATTRIBUTE)?.trim();
  if (fieldBg) marks.push({ kind: 'field', layerId, path, field: fieldBg, target: 'background' });
  const itemLink = el.getAttribute(ITEM_LINK_ATTRIBUTE)?.trim();
  if (itemLink !== undefined && itemLink !== null && el.hasAttribute(ITEM_LINK_ATTRIBUTE)) {
    if (!itemLink || itemLink === 'item') marks.push({ kind: 'item-link', layerId, path });
    else warn(ctx, path, `${ITEM_LINK_ATTRIBUTE}="${itemLink}" is not supported; use ${ITEM_LINK_ATTRIBUTE}="item"`, layerId, 'error');
  }
  if (el.hasAttribute(TOGGLE_ATTRIBUTE)) marks.push({ kind: 'toggle', layerId, path, name: el.getAttribute(TOGGLE_ATTRIBUTE)?.trim() || 'menu' });
  if (el.hasAttribute(MENU_ATTRIBUTE)) marks.push({ kind: 'menu', layerId, path, name: el.getAttribute(MENU_ATTRIBUTE)?.trim() || 'menu' });

  if (marks.length === 0) return;
  if (ctx.ycodeMarks) ctx.ycodeMarks.push(...marks);
  else warn(ctx, path, 'data-ycode-* annotations are only supported by the MCP import and were ignored', layerId);
}

/** Landmark tags that get a ref even without an id: first <header> → "header", second → "header[2]". */
const TAG_REF_TAGS = new Set(['header', 'footer', 'nav', 'main', 'aside', 'section']);

/** Numbered in document order across all elements of the tag, so "section[3]" is the third <section>. */
function addTagRef(ctx: ImportContext, tag: string, layerId: string, isNamed: boolean): void {
  const n = (ctx.tagRefCounts[tag] = (ctx.tagRefCounts[tag] ?? 0) + 1);
  const key = n === 1 ? tag : `${tag}[${n}]`;
  if (isNamed || ctx.refs[key]) return;
  ctx.refs[key] = layerId;
  ctx.tagRefs.add(key);
}

function addRef(ctx: ImportContext, ref: string, layerId: string, path: string): void {
  if (ctx.tagRefs.delete(ref)) {
    ctx.refs[ref] = layerId;
    return;
  }
  if (ctx.refs[ref]) {
    warn(ctx, path, `Duplicate id/data-ref "${ref}"; the returned refs point to the last element using it`, layerId);
  }
  ctx.refs[ref] = layerId;
}

/**
 * Turns `href="#id"` links whose target exists here or on the page into native
 * anchor links. Everything else (`#id` with no local target, `/path`, `/path#id`)
 * is handed to `options.unresolvedLinks` for cross-page resolution; without that
 * collector only the dangling `#id` case is reported.
 */
function resolvePendingAnchors(ctx: ImportContext, existingIds: Set<string>): void {
  for (const { layer, anchorId, path, pagePath } of ctx.pendingAnchors) {
    const link = layer.variables?.link;
    if (!link) continue;
    if (pagePath === undefined && anchorId !== undefined && (ctx.htmlIds.has(anchorId) || existingIds.has(anchorId))) {
      const anchorLink: LinkSettings = { ...link, type: 'url', anchor_layer_id: anchorId };
      delete anchorLink.url;
      layer.variables = { ...layer.variables, link: anchorLink };
    } else if (ctx.unresolvedLinks) {
      ctx.unresolvedLinks.push({
        layerId: layer.id,
        path,
        ...(anchorId !== undefined ? { anchorId } : {}),
        ...(pagePath !== undefined ? { pagePath } : {}),
      });
    } else if (pagePath === undefined) {
      warn(ctx, path, `Link "#${anchorId}" has no element with id "${anchorId}" in the import or on the page, so it was kept as a URL`, layer.id);
    }
  }
}

function elementToLayer(el: Element, ctx: ImportContext, path: string): Layer | null {
  const tag = el.tagName.toLowerCase();

  if (DROPPED_TAGS.has(tag)) {
    const hint = DROPPED_TAG_HINTS[tag];
    warn(ctx, path, `<${tag}> is not imported${hint ? `; ${hint}` : ''}`);
    return null;
  }

  // Static preview copies next to a data-ycode-collection item are design-time only.
  if (ctx.ycodeMarks && PREVIEW_ONLY_ATTRIBUTES.some((attr) => el.hasAttribute(attr))) return null;

  const layerId = generateId('lyr');
  // A <label> wrapping its control is a container, which the editor models as a
  // div with the label tag (same shape as the native form templates).
  const wrapsControl = tag === 'label' && el.querySelector('input, select, textarea') !== null;
  const layerName = wrapsControl ? 'div' : (TAG_TO_LAYER_NAME[tag] || 'div');
  const classes = resolveImportClasses(el, ctx, path, layerId);

  const ref = el.getAttribute('data-ref')?.trim();
  if (ref) addRef(ctx, ref, layerId, path);
  if (TAG_REF_TAGS.has(tag)) addTagRef(ctx, tag, layerId, Boolean(ref || el.getAttribute('id')));

  const componentName = el.getAttribute(COMPONENT_ATTRIBUTE)?.trim();
  if (componentName) {
    if (ctx.componentMarks) ctx.componentMarks.push({ name: componentName, layerId, path });
    else warn(ctx, path, `${COMPONENT_ATTRIBUTE} is only supported by the MCP import and was ignored`, layerId);
  }
  readYcodeMarks(el, ctx, path, layerId);

  const rawDesign = classes ? classesToDesign(classes) : undefined;
  const design = cleanDesign(rawDesign);

  const layer: Layer = {
    id: layerId,
    name: layerName,
    classes,
    ...(design ? { design } : {}),
  };

  warnDroppedAttributes(el, tag, ctx, path, layerId);
  if (tag !== 'svg') importAccessibilityAttributes(el, layer);
  if (!TAG_TO_LAYER_NAME[tag]) {
    warn(ctx, path, `Unknown tag <${tag}> was imported as a div`, layerId);
  } else if (LOSSY_TAGS.has(tag)) {
    warn(ctx, path, `<${tag}> was imported as a plain div and loses its native behavior`, layerId);
  }

  if (HEADING_TAGS.has(tag) || wrapsControl) {
    layer.settings = { ...layer.settings, tag };
  } else if (SEMANTIC_TAG_OVERRIDE[tag]) {
    layer.settings = { ...layer.settings, tag: SEMANTIC_TAG_OVERRIDE[tag] };
  }

  if (TEXT_LAYER_NAMES.has(layerName)) {
    layer.restrictions = { editText: true };
  }

  if (tag === 'a') {
    const href = el.getAttribute('href');
    const target = el.getAttribute('target') as LinkSettings['target'] | null;
    const rel = el.getAttribute('rel');

    if (href) {
      const linkSettings: LinkSettings = {
        type: 'url',
        url: { type: 'dynamic_text', data: { content: href } },
      };
      if (target) linkSettings.target = target;
      if (rel) linkSettings.rel = rel;
      layer.variables = { ...layer.variables, link: linkSettings };
      const anchor = parseSiteHref(href);
      if (anchor) ctx.pendingAnchors.push({ layer, path, ...anchor });
    }
  }

  if (tag === 'img') {
    if (ctx.warnings) {
      warnRelativeSrc(el, tag, ctx, path, layerId, 'upload it with upload_asset and set it with update_layer_image');
    }
    const rawSrc = el.getAttribute('src');
    const alt = el.getAttribute('alt');
    const absoluteSrc = rawSrc ? resolveAbsoluteUrl(rawSrc) : undefined;
    layer.variables = {
      ...layer.variables,
      image: {
        src: absoluteSrc
          ? { type: 'dynamic_text', data: { content: absoluteSrc } }
          : { type: 'asset', data: { asset_id: '' } },
        alt: { type: 'dynamic_text', data: { content: alt || '' } },
      },
    };
    const width = el.getAttribute('width');
    const height = el.getAttribute('height');
    if (width || height) {
      layer.attributes = {
        ...layer.attributes,
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      };
    }
    return layer;
  }

  if (tag === 'input') {
    layer.attributes = { ...layer.attributes, type: el.getAttribute('type') || 'text' };
    importFieldAttributes(el, layer);
    return layer;
  }

  if (tag === 'textarea') {
    const rows = el.getAttribute('rows');
    layer.attributes = { ...layer.attributes, ...(rows ? { rows } : {}) };
    importFieldAttributes(el, layer);
    return layer;
  }

  if (tag === 'select') {
    importFieldAttributes(el, layer);
    const options = optionsToLayers(el);
    if (options.length > 0) layer.children = options;
    return layer;
  }

  if (tag === 'button') {
    const type = el.getAttribute('type');
    layer.attributes = {
      ...layer.attributes,
      ...(type ? { type } : {}),
      ...(el.hasAttribute('disabled') ? { disabled: true } : {}),
    };
  }

  if (tag === 'form') {
    const action = el.getAttribute('action');
    const method = el.getAttribute('method');
    const name = el.getAttribute('name');
    layer.attributes = {
      ...layer.attributes,
      ...(action ? { action } : {}),
      ...(method ? { method } : {}),
      ...(name ? { name } : {}),
    };
  }

  if (tag === 'iframe') {
    if (ctx.warnings) {
      warnRelativeSrc(el, tag, ctx, path, layerId, 'set an absolute URL with update_layer_iframe');
    }
    const iframeSrc = resolveAbsoluteUrl(el.getAttribute('src') || '');
    if (iframeSrc) {
      layer.variables = {
        ...layer.variables,
        iframe: {
          src: { type: 'dynamic_text', data: { content: iframeSrc } },
        },
      };
    }
    return layer;
  }

  if (tag === 'video' || tag === 'audio') {
    if (ctx.warnings) {
      const hasSources = el.querySelector('source') !== null;
      warnRelativeSrc(
        el, tag, ctx, path, layerId,
        `${hasSources ? '<source> children are not imported; ' : ''}set the media with update_layer_video`,
      );
    }
    const mediaSrc = resolveAbsoluteUrl(el.getAttribute('src') || '');
    if (mediaSrc) {
      layer.variables = {
        ...layer.variables,
        [tag]: {
          src: { type: 'dynamic_text', data: { content: mediaSrc } },
        },
      };
    }
    layer.attributes = {
      ...layer.attributes,
      controls: el.hasAttribute('controls'),
      loop: el.hasAttribute('loop'),
      muted: el.hasAttribute('muted'),
      autoplay: el.hasAttribute('autoplay'),
    };
    return layer;
  }

  if (tag === 'svg') {
    if (sanitizeSvg(el) > 0) {
      warn(ctx, path, 'Scripts and event handlers were removed from <svg>', layerId);
    }
    // Strip class/style already extracted to the icon layer's design properties
    el.removeAttribute('class');
    el.removeAttribute('style');
    const svgString = el.outerHTML;
    layer.variables = {
      ...layer.variables,
      icon: {
        src: { type: 'static_text', data: { content: svgString } },
      },
    };
    return layer;
  }

  const customId = el.getAttribute('id');
  if (customId) {
    layer.attributes = { ...layer.attributes, id: customId };
    ctx.htmlIds.add(customId);
    if (customId !== ref) addRef(ctx, customId, layerId, path);
  }

  const isTextLayer = TEXT_LAYER_NAMES.has(layerName);

  if (isTextLayer && isTextOnlyElement(el)) {
    const doc = buildRichTextDoc(el, ctx, path);
    const hasContent = doc.content[0].content.length > 0;
    if (!hasContent) {
      // Empty text elements (e.g. decorative <span>) become div layers
      layer.name = 'div';
      layer.children = [];
      return layer;
    }
    layer.variables = {
      ...layer.variables,
      text: makeRichTextVariable(doc),
    };
    return layer;
  }

  if (!isTextLayer && isTextOnlyElement(el) && el.textContent?.trim() && !keepsInlineChildrenAsLayers(el)) {
    const doc = buildRichTextDoc(el, ctx, path);
    if (CONTAINER_NAMES.has(layerName)) {
      layer.children = [makeTextLayer(doc)];
    } else {
      layer.variables = {
        ...layer.variables,
        text: makeRichTextVariable(doc),
      };
    }
    return layer;
  }

  const children = childNodesToLayers(el, ctx, path);

  if (children.length > 0 && isLeafLayer(layer)) {
    warn(ctx, path, `<${tag}> contains block content, but its "${layerName}" layer can't have children in the editor; wrap the content in a div instead`, layerId, 'error');
  }

  if (isTextLayer && children.length === 0) {
    layer.variables = {
      ...layer.variables,
      text: makeRichTextVariable(LAYER_NAME_LABELS[layerName] || ''),
    };
    return layer;
  }

  if (children.length > 0) {
    layer.children = children;
  } else if (CONTAINER_NAMES.has(layerName)) {
    layer.children = [];
  }

  return layer;
}

function childNodesToLayers(parent: Element, ctx: ImportContext, parentPath: string): Layer[] {
  const layers: Layer[] = [];
  const tagCounts: Record<string, number> = {};

  for (let i = 0; i < parent.childNodes.length; i++) {
    const node = parent.childNodes[i];
    if (node.nodeType === TEXT_NODE) {
      const text = (node.textContent || '').trim();
      if (text) {
        layers.push(makeTextLayer(text));
      }
    } else if (node.nodeType === ELEMENT_NODE) {
      const tag = (node as Element).tagName.toLowerCase();
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      const path = `${parentPath ? `${parentPath} > ` : ''}${tag}[${tagCounts[tag]}]`;
      const layer = elementToLayer(node as Element, ctx, path);
      if (layer) layers.push(layer);
    }
  }

  return layers;
}

/**
 * Convert a parsed HTML document's body into a Ycode Layer tree.
 * Works with any DOM implementation (browser DOMParser or a server-side DOM).
 */
export function documentToLayers(doc: Document, options: HtmlImportOptions = {}): Layer[] {
  const ctx: ImportContext = {
    warnings: options.warnings ?? null,
    rescaleSizes: !options.tailwindV4,
    refs: options.refs ?? {},
    tagRefs: new Set(),
    tagRefCounts: {},
    htmlIds: new Set(),
    pendingAnchors: [],
    unresolvedLinks: options.unresolvedLinks ?? null,
    componentMarks: options.componentMarks ?? null,
    ycodeMarks: options.ycodeMarks ?? null,
  };

  // Parsers hoist <style>, <link>, <title>, etc. into <head>, out of the body walk
  if (ctx.warnings && doc.head) {
    for (let i = 0; i < doc.head.children.length; i++) {
      const tag = doc.head.children[i].tagName.toLowerCase();
      if (tag === 'meta') continue;
      const hint = DROPPED_TAG_HINTS[tag];
      warn(ctx, `head > ${tag}`, `<${tag}> is not imported${hint ? `; ${hint}` : ''}`);
    }
  }

  const layers = doc.body ? childNodesToLayers(doc.body, ctx, '') : [];
  resolvePendingAnchors(ctx, new Set(options.anchorIds ?? []));
  return layers;
}

/**
 * Parse an HTML string into a Ycode Layer tree (browser only).
 * Converts Tailwind classes to design properties.
 * Absolute image/media URLs are preserved; relative paths become placeholders.
 */
export function htmlToLayers(html: string): Layer[] {
  if (typeof window === 'undefined') return [];

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    return documentToLayers(doc);
  } catch (err) {
    console.warn('htmlToLayers: failed to parse HTML', err);
    return [];
  }
}

// ─── Export: Layers → HTML ───

const MARK_TO_HTML_TAG: Record<string, string> = {
  bold: 'strong', italic: 'em', underline: 'u', strike: 's',
  subscript: 'sub', superscript: 'sup', code: 'code',
};

function renderTiptapNodeToHtml(node: any): string {
  if (node.type === 'hardBreak') return '<br />';
  if (node.type !== 'text' || !node.text) return '';

  let html = escapeHtml(node.text);
  const marks: any[] = node.marks || [];

  for (let i = marks.length - 1; i >= 0; i--) {
    const mark = marks[i];
    const tag = MARK_TO_HTML_TAG[mark.type];
    if (tag) {
      html = `<${tag}>${html}</${tag}>`;
      continue;
    }
    if (mark.type === 'richTextLink') {
      const href = mark.attrs?.url?.data?.content || '#';
      const linkParts = [`href="${escapeHtml(href)}"`];
      if (mark.attrs?.target) linkParts.push(`target="${mark.attrs.target}"`);
      if (mark.attrs?.rel) linkParts.push(`rel="${escapeHtml(mark.attrs.rel)}"`);
      html = `<a ${linkParts.join(' ')}>${html}</a>`;
    }
  }

  return html;
}

function renderTiptapDocToHtml(doc: any): string {
  if (!doc || !doc.content) return '';
  return doc.content
    .map((block: any) => {
      if (!block.content) return '';
      return block.content.map(renderTiptapNodeToHtml).join('');
    })
    .join('\n');
}

function getLayerTextHtml(layer: Layer): string | null {
  const textVar = layer.variables?.text;
  if (!textVar) return null;

  if (textVar.type === 'dynamic_text') {
    return escapeHtml(textVar.data.content);
  }

  if (textVar.type === 'dynamic_rich_text') {
    return renderTiptapDocToHtml((textVar.data as any).content) || null;
  }

  return null;
}

function getVariableContent(variable: any): string {
  if (!variable || !('data' in variable)) return '';
  return (variable.data as any).content || '';
}

/** Resolve a media src variable, looking asset ids up in the caller-provided URL map. */
function getMediaSrc(variable: any, assetUrls: Record<string, string>): string {
  if (variable?.type === 'asset') {
    const assetId = variable.data?.asset_id;
    return (assetId && assetUrls[assetId]) || '';
  }
  return getVariableContent(variable);
}

/** Resolve a layer's link to the href the published page would render, or null. */
function resolveExportHref(
  layer: Layer,
  assetUrls: Record<string, string>,
  linkContext: LinkResolutionContext,
): string | null {
  const link = layer.variables?.link;
  if (!link || !isValidLinkSettings(link)) return null;
  return generateLinkHref(link, {
    getAsset: (id) => (assetUrls[id] ? { id, public_url: assetUrls[id] } : null),
    ...linkContext,
  });
}

function resolveExportTag(layer: Layer, href: string | null): string {
  if (href && (layer.name === 'div' || layer.name === 'button')) {
    return 'a';
  }
  return getLayerHtmlTag(layer);
}

function buildLinkAttrs(link: LinkSettings, href: string): string[] {
  const attrs = [`href="${escapeHtml(href)}"`];
  if (link.target) attrs.push(`target="${link.target}"`);
  if (link.rel) attrs.push(`rel="${escapeHtml(link.rel)}"`);
  if (link.download) attrs.push('download');
  return attrs;
}

function isTruthyAttr(value: unknown): boolean {
  return value === true || value === 'true' || value === '';
}

/** name / placeholder / required / … of a form field, mirroring what the import reads. */
function buildFieldAttrs(layer: Layer): string[] {
  const attrs: string[] = [];
  for (const name of FIELD_ATTRS) {
    const value = layer.attributes?.[name];
    if (value !== undefined && value !== null && value !== '') attrs.push(`${name}="${escapeHtml(String(value))}"`);
  }
  for (const name of BOOLEAN_FIELD_ATTRS) {
    if (isTruthyAttr(layer.attributes?.[name])) attrs.push(name);
  }
  return attrs;
}

/** User-defined custom attributes (aria-*, role, data-*, …) from the settings panel. */
function buildCustomAttrs(layer: Layer): string[] {
  const custom = layer.settings?.customAttributes;
  if (!custom) return [];
  return Object.entries(custom)
    .filter(([name]) => name !== 'class' && name !== 'style' && name !== 'id')
    .map(([name, value]) => (value === '' ? name : `${name}="${escapeHtml(String(value))}"`));
}

function layerToHtmlString(
  layer: Layer,
  indent: number,
  assetUrls: Record<string, string>,
  linkContext: LinkResolutionContext,
): string {
  const pad = '  '.repeat(indent);
  const href = resolveExportHref(layer, assetUrls, linkContext);
  const tag = resolveExportTag(layer, href);
  const html = layerElementToHtml(layer, indent, tag, href, assetUrls, linkContext);

  // Layers that cannot become an <a> themselves (text, image, …) render inside one
  if (href && tag !== 'a') {
    const linkAttrs = buildLinkAttrs(layer.variables!.link!, href).join(' ');
    return `${pad}<a ${linkAttrs}>${html.trimStart()}</a>`;
  }
  return html;
}

function layerElementToHtml(
  layer: Layer,
  indent: number,
  tag: string,
  href: string | null,
  assetUrls: Record<string, string>,
  linkContext: LinkResolutionContext,
): string {
  const pad = '  '.repeat(indent);
  const classes = getClassesString(layer);

  const attrs: string[] = [];
  if (classes) attrs.push(`class="${escapeHtml(classes)}"`);

  const htmlId = layer.settings?.id || layer.attributes?.id;
  if (htmlId) {
    attrs.push(`id="${escapeHtml(htmlId)}"`);
  }

  // The bg-[image:var(--bg-img)] class reads the image from this CSS variable.
  const bgImageSrc = getMediaSrc(layer.variables?.backgroundImage?.src, assetUrls);
  if (bgImageSrc) {
    attrs.push(`style="${escapeHtml(`--bg-img:url('${bgImageSrc}')`)}"`);
  }

  if (tag === 'a' && href) {
    attrs.push(...buildLinkAttrs(layer.variables!.link!, href));
  }

  if (layer.name === 'image') {
    const src = getMediaSrc(layer.variables?.image?.src, assetUrls);
    const alt = getVariableContent(layer.variables?.image?.alt);
    if (src) attrs.push(`src="${escapeHtml(src)}"`);
    attrs.push(`alt="${escapeHtml(alt)}"`);
    if (layer.attributes?.width) attrs.push(`width="${escapeHtml(layer.attributes.width)}"`);
    if (layer.attributes?.height) attrs.push(`height="${escapeHtml(layer.attributes.height)}"`);
  }

  if (layer.name === 'input' || layer.name === 'textarea' || layer.name === 'select') {
    if (layer.name === 'input' && layer.attributes?.type) attrs.push(`type="${escapeHtml(layer.attributes.type)}"`);
    if (layer.name === 'textarea' && layer.attributes?.rows) attrs.push(`rows="${escapeHtml(String(layer.attributes.rows))}"`);
    attrs.push(...buildFieldAttrs(layer));
  }

  if (layer.name === 'button') {
    if (layer.attributes?.type) attrs.push(`type="${escapeHtml(layer.attributes.type)}"`);
    if (isTruthyAttr(layer.attributes?.disabled)) attrs.push('disabled');
  }

  if (layer.name === 'option') {
    if (layer.attributes?.value !== undefined) attrs.push(`value="${escapeHtml(String(layer.attributes.value))}"`);
    if (isTruthyAttr(layer.attributes?.selected)) attrs.push('selected');
    if (isTruthyAttr(layer.attributes?.disabled)) attrs.push('disabled');
    if (isTruthyAttr(layer.attributes?.hidden)) attrs.push('hidden');
  }

  if (layer.name === 'form') {
    if (layer.attributes?.action) attrs.push(`action="${escapeHtml(layer.attributes.action)}"`);
    if (layer.attributes?.method) attrs.push(`method="${escapeHtml(layer.attributes.method)}"`);
    if (layer.attributes?.name) attrs.push(`name="${escapeHtml(layer.attributes.name)}"`);
  }

  attrs.push(...buildCustomAttrs(layer));

  if (layer.name === 'iframe') {
    const src = getVariableContent(layer.variables?.iframe?.src);
    if (src) attrs.push(`src="${escapeHtml(src)}"`);
  }

  if (layer.name === 'video' || layer.name === 'audio') {
    const src = getMediaSrc(layer.variables?.[layer.name as 'video' | 'audio']?.src, assetUrls);
    if (src) attrs.push(`src="${escapeHtml(src)}"`);
    if (layer.name === 'video') {
      const poster = getMediaSrc(layer.variables?.video?.poster, assetUrls);
      if (poster) attrs.push(`poster="${escapeHtml(poster)}"`);
    }
    if (layer.attributes?.controls) attrs.push('controls');
    if (layer.attributes?.loop) attrs.push('loop');
    if (layer.attributes?.muted) attrs.push('muted');
    if (layer.attributes?.autoplay) attrs.push('autoplay');
    // Mobile (iOS/Android) requires playsinline for inline autoplay (no forced fullscreen).
    if (layer.name === 'video') attrs.push('playsinline');
  }

  const attrStr = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';

  if (SELF_CLOSING_TAGS.has(tag)) {
    return `${pad}<${tag}${attrStr} />`;
  }

  if (layer.name === 'icon') {
    const iconSrc = layer.variables?.icon?.src;
    if (iconSrc && iconSrc.type === 'static_text') {
      return `${pad}${(iconSrc.data as any).content}`;
    }
    return `${pad}<span${attrStr}></span>`;
  }

  const textHtml = getLayerTextHtml(layer);
  const openTag = `${pad}<${tag}${attrStr}>`;
  const closeTag = `</${tag}>`;

  if (textHtml && (!layer.children || layer.children.length === 0)) {
    return `${openTag}${textHtml}${closeTag}`;
  }

  if (!layer.children || layer.children.length === 0) {
    return `${openTag}${closeTag}`;
  }

  const childHtml = layer.children
    .map((child) => layerToHtmlString(child, indent + 1, assetUrls, linkContext))
    .join('\n');

  return `${openTag}\n${childHtml}\n${pad}${closeTag}`;
}

/**
 * Convert a single layer and its children to HTML.
 * @param assetUrls - Map of asset id → URL used to resolve asset-backed media and asset links
 * @param linkContext - Pages, folders and anchor map for resolving page and anchor links;
 *   without it, page links are left out and anchors fall back to the stored value
 */
export function layerToExportHtml(
  layer: Layer,
  assetUrls: Record<string, string> = {},
  linkContext: LinkResolutionContext = {},
): string {
  return layerToHtmlString(layer, 0, assetUrls, linkContext);
}
