import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyDesignToLayer } from './utils';
import type { Layer } from '../../types';

const classList = (layer: Layer) =>
  (Array.isArray(layer.classes) ? layer.classes : layer.classes.split(' ')).filter(Boolean);

// Layout templates ship hand-written classes the design object doesn't fully describe.
const hamburger: Layer = {
  id: 'menu-toggle',
  name: 'div',
  classes: 'hidden max-md:flex items-center justify-center w-[40px] h-[40px] rounded-[12px] bg-[#f3f4f6]',
  design: {
    sizing: { isActive: true, width: '40px', height: '40px' },
    backgrounds: { isActive: true, backgroundColor: '#f3f4f6' },
  },
};

test('desktop design edits keep base classes the design does not describe', () => {
  const result = applyDesignToLayer(hamburger, {
    backgrounds: { isActive: true, backgroundColor: '#111111' },
  });
  const classes = classList(result);

  for (const cls of ['hidden', 'max-md:flex', 'items-center', 'justify-center', 'rounded-[12px]', 'w-[40px]']) {
    assert.ok(classes.includes(cls), `expected "${cls}" to be preserved`);
  }
  assert.ok(classes.includes('bg-[#111111]'));
  assert.ok(!classes.includes('bg-[#f3f4f6]'));
  assert.equal(result.design?.backgrounds?.backgroundColor, '#111111');
});

test('desktop design edits do not resurrect stale design values as classes', () => {
  const links: Layer = {
    id: 'links',
    name: 'div',
    classes: 'flex flex-row max-md:flex-col gap-[24px]',
    design: { layout: { isActive: true, display: 'flex', flexDirection: 'column', gap: '24px' } },
  };
  const classes = classList(applyDesignToLayer(links, { layout: { isActive: true, gap: '32px' } }));

  assert.ok(classes.includes('flex-row'));
  assert.ok(classes.includes('max-md:flex-col'));
  assert.ok(!classes.includes('flex-col'));
  assert.ok(classes.includes('gap-[32px]'));
  assert.ok(!classes.includes('gap-[24px]'));
});

test('null design values remove the desktop class only', () => {
  const layer: Layer = {
    id: 'text',
    name: 'text',
    classes: 'text-[14px] max-md:text-[12px]',
    design: { typography: { isActive: true, fontSize: '14px' } },
  };
  const classes = classList(applyDesignToLayer(layer, {
    typography: { fontSize: null as unknown as string },
  }));

  assert.ok(!classes.includes('text-[14px]'));
  assert.ok(classes.includes('max-md:text-[12px]'));
});

test('transition easing accepts both "out" and "ease-out" and never doubles the prefix', () => {
  const base: Layer = { id: 'btn', name: 'button', classes: '' };
  const named = classList(applyDesignToLayer(base, {
    transitions: { isActive: true, easing: 'ease-out', duration: '200ms' },
  }));
  assert.ok(named.includes('ease-out'), named.join(' '));
  assert.ok(!named.some((cls) => cls.startsWith('ease-ease')));

  const stored = classList(applyDesignToLayer(base, { transitions: { isActive: true, easing: 'in-out' } }));
  assert.ok(stored.includes('ease-in-out'), stored.join(' '));

  const custom = classList(applyDesignToLayer(base, {
    transitions: { isActive: true, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  }));
  assert.ok(custom.includes('ease-[cubic-bezier(0.4,_0,_0.2,_1)]'), custom.join(' '));
});
