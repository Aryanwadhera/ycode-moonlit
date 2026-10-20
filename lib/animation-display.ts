/**
 * DOM helpers for the Display property of interactions.
 *
 * Display is not tweened; it is toggled through the `data-gsap-hidden`
 * attribute, which CSS maps to `display: none !important`. A layer can also
 * be hidden statically by its design (`display: hidden` → Tailwind `hidden`
 * class, possibly breakpoint-scoped). Removing the attribute alone cannot
 * reveal such a layer, so showing also strips those classes — remembering
 * them in `data-gsap-stripped` so hiding again (or resetting on a breakpoint
 * change) restores the original responsive behaviour.
 */

export const GSAP_HIDDEN_ATTR = 'data-gsap-hidden';
const GSAP_STRIPPED_ATTR = 'data-gsap-stripped';

/** Breakpoint variants used by the class generator (see lib/breakpoint-utils.ts) */
const BREAKPOINT_PREFIXES = ['max-md:', 'max-lg:', 'md:', 'lg:'];

/**
 * True for the Tailwind `hidden` utility, plain or breakpoint-scoped.
 * State variants (`hover:hidden`) are intentionally excluded — they express
 * behaviour, not a static hidden state.
 */
export function isDisplayNoneClass(className: string): boolean {
  if (className === 'hidden') return true;
  return BREAKPOINT_PREFIXES.some((prefix) => className === `${prefix}hidden`);
}

/** Remove static `hidden` classes from a class string (canvas equivalent of `showGsapElement`) */
export function stripDisplayNoneClasses(classes: string): string {
  return classes.split(' ').filter((cls) => cls && !isDisplayNoneClass(cls)).join(' ');
}

/** Re-add any `hidden` classes removed by a previous reveal */
export function restoreGsapDisplayClasses(element: Element): void {
  const stripped = element.getAttribute(GSAP_STRIPPED_ATTR);
  if (stripped === null) return;
  const classes = stripped.split(' ').filter(Boolean);
  if (classes.length > 0) element.classList.add(...classes);
  element.removeAttribute(GSAP_STRIPPED_ATTR);
}

/** Show an element: remove the GSAP hidden attribute and neutralise static `hidden` classes */
export function showGsapElement(element: Element): void {
  element.removeAttribute(GSAP_HIDDEN_ATTR);

  const toStrip = Array.from(element.classList).filter(isDisplayNoneClass);
  if (toStrip.length === 0) return;

  element.classList.remove(...toStrip);
  const previous = element.getAttribute(GSAP_STRIPPED_ATTR)?.split(' ').filter(Boolean) ?? [];
  element.setAttribute(GSAP_STRIPPED_ATTR, Array.from(new Set([...previous, ...toStrip])).join(' '));
}

/**
 * Hide an element via the GSAP hidden attribute.
 * @param breakpoints - space-separated breakpoints the hide applies to ('' = all)
 */
export function hideGsapElement(element: Element, breakpoints = ''): void {
  restoreGsapDisplayClasses(element);
  element.setAttribute(GSAP_HIDDEN_ATTR, breakpoints);
}

/**
 * Put an element back to its authored state: no GSAP hidden attribute and its
 * original classes. Used when resetting animations (e.g. breakpoint change) and
 * when clearing editor previews.
 */
export function resetGsapDisplay(element: Element): void {
  restoreGsapDisplayClasses(element);
  element.removeAttribute(GSAP_HIDDEN_ATTR);
}
