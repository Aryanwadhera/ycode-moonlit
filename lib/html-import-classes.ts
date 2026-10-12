/**
 * Class rewrites applied when importing HTML, so common Tailwind markup lands
 * on design-panel controls instead of raw classes:
 * - mobile-first breakpoints (md:, lg:) → Ycode's desktop-first max-lg: / max-md:
 * - v4 gradients (bg-linear-to-* + from/via/to) → one bg-[linear-gradient(...)]
 * - inset-* and top/right/bottom/left scale values → top-[…] etc.
 *
 * Expects classes already normalized to v4 with named colors resolved to hex.
 */

import { getAffectedProperties } from '@/lib/tailwind-class-mapper';

const VARIANT_PREFIX_RE = /^((?:[a-z0-9-]+:)+)/;

function splitVariants(cls: string): { variants: string[]; base: string } {
  const prefix = cls.match(VARIANT_PREFIX_RE)?.[1] ?? '';
  return { variants: prefix.split(':').filter(Boolean), base: cls.slice(prefix.length) };
}

function joinVariants(variants: string[], base: string): string {
  return variants.length > 0 ? `${variants.join(':')}:${base}` : base;
}

// ─── inset-* and top/right/bottom/left ───

const INSET_RE = /^(-?)inset(?:-(x|y))?-(.+)$/;
const SIDE_RE = /^(-?)(top|right|bottom|left)-(.+)$/;
const INSET_SIDES: Record<string, string[]> = {
  '': ['top', 'right', 'bottom', 'left'],
  x: ['left', 'right'],
  y: ['top', 'bottom'],
};

/** Theme value → the arbitrary value the position controls write, or null to keep the class. */
function positionValue(value: string, negative: boolean): string | null {
  let resolved: string | null = null;
  if (value.startsWith('[') && value.endsWith(']')) resolved = value.slice(1, -1);
  else if (value === '0') resolved = '0px';
  else if (value === 'px') resolved = '1px';
  else if (value === 'full') resolved = '100%';
  else if (/^\d+(\.\d+)?$/.test(value)) resolved = `${Number(value) / 4}rem`;
  else if (/^\d+\/\d+$/.test(value)) {
    const [num, den] = value.split('/').map(Number);
    resolved = den ? `${Number(((num / den) * 100).toFixed(4))}%` : null;
  }
  if (resolved === null) return null;
  if (!negative) return resolved;
  return resolved.startsWith('-') ? resolved.slice(1) : `-${resolved}`;
}

/**
 * Expands inset-* into its sides and writes side values as the arbitrary
 * values the position controls edit (top-4 → top-[1rem], inset-0 → top-[0px] …).
 */
export function normalizePositionClasses(classes: string[]): string[] {
  return classes.flatMap((cls) => {
    const { variants, base } = splitVariants(cls);
    const inset = base.match(INSET_RE);
    const side = inset ? null : base.match(SIDE_RE);
    if (!inset && !side) return [cls];

    const [, sign, axisOrSide, value] = (inset ?? side)!;
    const sides = inset ? INSET_SIDES[axisOrSide ?? ''] : [axisOrSide];
    if (value === 'auto') return sides.map((s) => joinVariants(variants, `${s}-auto`));

    const resolved = positionValue(value, sign === '-');
    if (resolved === null) return inset ? sides.map((s) => joinVariants(variants, `${sign}${s}-${value}`)) : [cls];
    return sides.map((s) => joinVariants(variants, `${s}-[${resolved}]`));
  });
}

// ─── Gradients ───

const GRADIENT_DIRECTIONS: Record<string, string> = {
  t: 'to_top', tr: 'to_top_right', r: 'to_right', br: 'to_bottom_right',
  b: 'to_bottom', bl: 'to_bottom_left', l: 'to_left', tl: 'to_top_left',
};
const LINEAR_RE = /^bg-linear-(?:to-(t|tr|r|br|b|bl|l|tl)|(\d+))$/;
const STOP_RE = /^(from|via|to)-\[([^\]]+)\]$/;

/**
 * Combines bg-linear-* with its from-/via-/to- color stops (per variant
 * prefix) into one arbitrary gradient the background control can edit. Stops
 * with positions or opacity modifiers are left alone.
 */
export function convertGradientClasses(classes: string[]): string[] {
  const groups = new Map<string, { direction?: string; directionIdx?: number; stops: Record<string, string>; stopIdx: number[] }>();

  classes.forEach((cls, i) => {
    const { variants, base } = splitVariants(cls);
    const key = variants.join(':');
    const group = groups.get(key) ?? { stops: {}, stopIdx: [] };
    groups.set(key, group);

    const linear = base.match(LINEAR_RE);
    if (linear) {
      group.direction = linear[1] ? GRADIENT_DIRECTIONS[linear[1]] : `${linear[2]}deg`;
      group.directionIdx = i;
      return;
    }
    const stop = base.match(STOP_RE);
    if (stop) {
      group.stops[stop[1]] = stop[2];
      group.stopIdx.push(i);
    }
  });

  const replaced = new Map<number, string | null>();
  for (const [key, group] of groups) {
    if (group.direction === undefined || group.directionIdx === undefined || group.stopIdx.length === 0) continue;
    const { from = 'transparent', via, to = 'transparent' } = group.stops;
    const colors = [from, ...(via ? [via] : []), to].join(',');
    const gradient = `bg-[linear-gradient(${group.direction},${colors})]`;
    replaced.set(group.directionIdx, joinVariants(key ? key.split(':') : [], gradient));
    for (const idx of group.stopIdx) replaced.set(idx, null);
  }

  return classes.flatMap((cls, i) => {
    if (!replaced.has(i)) return [cls];
    const next = replaced.get(i);
    return next ? [next] : [];
  });
}

// ─── Mobile-first → desktop-first ───

const MOBILE_FIRST_TIERS = ['sm', 'md', 'lg'] as const;
type Tier = 'base' | (typeof MOBILE_FIRST_TIERS)[number];
const CONVERTIBLE_STATES = new Set(['hover', 'focus', 'active', 'disabled', 'current', 'visited']);

/**
 * Class reproducing the browser default for a property, used as the mobile
 * value when a breakpoint class has no un-prefixed counterpart (md:col-span-2
 * alone means "1 column below md"). Inherited properties (font, color) are
 * absent on purpose: their default is the parent's value, not a constant.
 */
const MOBILE_DEFAULTS: Record<string, string> = {
  flexDirection: 'flex-row',
  flexWrap: 'flex-nowrap',
  justifyContent: 'justify-start',
  alignItems: 'items-stretch',
  alignSelf: 'self-auto',
  order: 'order-none',
  gap: 'gap-[0px]',
  columnGap: 'gap-x-0',
  rowGap: 'gap-y-0',
  gridTemplateColumns: 'grid-cols-1',
  gridColumnSpan: 'col-span-1',
  gridRowSpan: 'row-span-1',
  padding: 'p-[0px]',
  paddingX: 'px-0',
  paddingY: 'py-0',
  paddingTop: 'pt-0',
  paddingRight: 'pr-0',
  paddingBottom: 'pb-0',
  paddingLeft: 'pl-0',
  margin: 'm-[0px]',
  marginX: 'mx-0',
  marginY: 'my-0',
  marginTop: 'mt-0',
  marginRight: 'mr-0',
  marginBottom: 'mb-0',
  marginLeft: 'ml-0',
  width: 'w-auto',
  height: 'h-auto',
  maxWidth: 'max-w-none',
  textAlign: 'text-left',
  position: 'static',
  top: 'top-[auto]',
  right: 'right-[auto]',
  bottom: 'bottom-[auto]',
  left: 'left-[auto]',
};

interface ResponsiveGroup {
  values: Partial<Record<Tier, string>>;
  indexes: number[];
  firstIndex: number;
}

/**
 * Rewrites mobile-first breakpoint classes to Ycode's desktop-first model,
 * per design property: desktop takes the lg (else md/sm/base) value, tablet
 * (max-lg) the md (else sm/base) value, and mobile (max-md) the base value.
 * A missing base value falls back to the property's browser default
 * (`displayDefault` for display, which depends on the element). Groups that
 * can't be expressed (no base value or default, unknown utilities, xl/2xl,
 * other variants, or already desktop-first) are left unchanged.
 */
export function convertMobileFirstClasses(
  classes: string[],
  displayDefault = 'block',
): { classes: string[]; approximated: string[] } {
  const groups = new Map<string, ResponsiveGroup>();
  const blocked = new Set<string>();

  classes.forEach((cls, i) => {
    const { variants, base } = splitVariants(cls);
    const breakpoints = variants.filter((v) => !CONVERTIBLE_STATES.has(v));
    const states = variants.filter((v) => CONVERTIBLE_STATES.has(v));
    if (breakpoints.length > 1 || states.length > 1) return;

    const properties = getAffectedProperties(base);
    if (properties.length === 0) return;
    const key = `${states[0] ?? ''}|${properties.sort().join(',')}`;

    const breakpoint = breakpoints[0];
    if (breakpoint && !(MOBILE_FIRST_TIERS as readonly string[]).includes(breakpoint)) {
      blocked.add(key);
      return;
    }

    const tier: Tier = (breakpoint as Tier | undefined) ?? 'base';
    const group = groups.get(key) ?? { values: {}, indexes: [], firstIndex: i };
    groups.set(key, group);
    group.values[tier] = base;
    group.indexes.push(i);
  });

  const replaced = new Map<number, string[]>();
  const approximated: string[] = [];

  for (const [key, group] of groups) {
    const { sm, md, lg } = group.values;
    if (blocked.has(key) || (sm === undefined && md === undefined && lg === undefined)) continue;

    const state = key.slice(0, key.indexOf('|'));
    const property = key.slice(key.indexOf('|') + 1);
    const fallback = state ? undefined : (property === 'display' ? displayDefault : MOBILE_DEFAULTS[property]);
    const base = group.values.base ?? fallback;
    if (base === undefined) continue;
    const withState = (bp: string | null, value: string) => joinVariants([...(bp ? [bp] : []), ...(state ? [state] : [])], value);

    const desktop = lg ?? md ?? sm ?? base;
    const tablet = md ?? sm ?? base;
    const mobile = base;
    if (sm !== undefined && sm !== base) approximated.push(withState('sm', sm));

    const output = [withState(null, desktop)];
    if (tablet !== desktop) output.push(withState('max-lg', tablet));
    if (mobile !== tablet) output.push(withState('max-md', mobile));

    for (const idx of group.indexes) replaced.set(idx, []);
    replaced.set(group.firstIndex, output);
  }

  return {
    classes: classes.flatMap((cls, i) => replaced.get(i) ?? [cls]),
    approximated,
  };
}
