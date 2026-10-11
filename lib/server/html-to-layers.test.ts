import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseHTML } from 'linkedom';

import { htmlToLayersOnServer } from './html-to-layers';
import { documentToLayers } from '../html-layer-converter';
import { classesToDesign } from '../tailwind-class-mapper';
import { normalizeV3ToV4 } from '../tailwind-normalizer';
import type { Layer } from '../../types';

const messages = (html: string) => htmlToLayersOnServer(html).warnings.map((w) => w.message);

test('imports a section as native layers with Tailwind classes and desktop design', () => {
  const { layers, warnings } = htmlToLayersOnServer(`
    <section id="features" class="flex flex-row gap-[24px] max-md:flex-col">
      <h2 class="text-[40px] font-semibold">Features</h2>
      <a href="https://example.com" class="rounded-[8px]">Start</a>
    </section>`);

  assert.equal(layers.length, 1);
  const [section] = layers;
  assert.equal(section.name, 'section');
  assert.equal(section.attributes?.id, 'features');
  assert.match(section.classes as string, /max-md:flex-col/);
  assert.equal(section.design?.layout?.flexDirection, 'row');

  const [heading, link] = section.children as Layer[];
  assert.equal(heading.name, 'heading');
  assert.equal(heading.settings?.tag, 'h2');
  assert.equal(link.variables?.link?.url?.data.content, 'https://example.com');
  assert.deepEqual(warnings, []);
});

test('warns about everything dropped or converted lossily', () => {
  const found = messages(`
    <style>.x{color:red}</style>
    <div class="space-y-4 md:p-[8px] group-hover:opacity-50" data-test="x">
      <img src="/hero.png" alt="Hero">
      <p>Hello <span class="text-[#f00]">world</span></p>
      <select name="plan"><option>Pro</option></select>
      <custom-el>hi</custom-el>
      <a href="#pricing">Pricing</a>
      <div style="--brand: red; color: #111">x</div>
    </div>`);

  const expectSome = (re: RegExp) => assert.ok(found.some((m) => re.test(m)), `missing warning ${re}\n${found.join('\n')}`);
  expectSome(/<style> is not imported/);
  expectSome(/Class "space-y-4" .* no control in the design panel/);
  expectSome(/Mobile-first prefix "md:"/);
  expectSome(/Variant "group-hover:"/);
  expectSome(/Attributes dropped from <div>: data-test/);
  expectSome(/<img> src "\/hero.png" is not an absolute URL/);
  expectSome(/Inline <span> inside text lost its class/);
  expectSome(/<select> options were not imported/);
  expectSome(/Unknown tag <custom-el>/);
  expectSome(/Link "#pricing" has no element with id "pricing"/);
  expectSome(/Inline style "--brand: red" was dropped/);
});

test('does not flag scale utilities the design panel understands', () => {
  const found = messages('<div class="gap-6 px-8 text-2xl rounded-2xl shadow-sm hover:bg-[#000] max-lg:hidden"></div>');
  assert.deepEqual(found, []);
});

test('collecting warnings does not change the imported layers', () => {
  const html = '<section class="flex rounded-sm"><p class="text-[14px]">Hi <b>there</b></p><img src="x.png"></section>';
  const parse = () => parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`).document as unknown as Document;
  const stripIds = (layers: Layer[]): unknown => JSON.parse(JSON.stringify(layers, (k, v) => (k === 'id' ? undefined : v)));

  const plain = documentToLayers(parse());
  const withWarnings = documentToLayers(parse(), { warnings: [] });
  assert.deepEqual(stripIds(withWarnings), stripIds(plain));
});

test('MCP import keeps v4 size classes; the editor import still rescales v3', () => {
  const [mcpLayer] = htmlToLayersOnServer('<div class="rounded-sm shadow ring"></div>').layers;
  assert.equal(mcpLayer.classes, 'rounded-sm shadow ring');

  assert.deepEqual(normalizeV3ToV4(['rounded-sm', 'shadow', 'ring']), ['rounded-xs', 'shadow-sm', 'ring-3']);
  assert.deepEqual(normalizeV3ToV4(['flex-grow', 'rounded-sm'], { rescaleSizes: false }), ['grow', 'rounded-sm']);
});

test('keeps styled inline children and flex items as separate layers', () => {
  const { layers, warnings } = htmlToLayersOnServer(`
    <nav class="flex gap-[16px]">
      <a href="https://example.com/a" class="rounded-full px-4">Pricing</a>
      <a href="https://example.com/b" class="rounded-full px-4">Docs</a>
    </nav>
    <div class="flex"><span>One</span><span>Two</span></div>`);

  const [nav, row] = layers;
  const links = nav.children as Layer[];
  assert.equal(links.length, 2);
  assert.match(links[0].classes as string, /rounded-full px-4/);
  assert.equal(links[0].variables?.link?.url?.data.content, 'https://example.com/a');
  assert.equal((row.children as Layer[]).length, 2);
  assert.ok(!warnings.some((w) => /lost its class/.test(w.message)));
});

test('still merges inline elements inside running text', () => {
  const [div] = htmlToLayersOnServer('<div>Read <a class="underline" href="https://example.com">the docs</a> now</div>').layers;
  const children = div.children as Layer[];
  assert.equal(children.length, 1);
  assert.equal(children[0].name, 'text');

  const [plain] = htmlToLayersOnServer('<div><strong>Bold</strong> <em>words</em></div>').layers;
  assert.equal((plain.children as Layer[]).length, 1);
});

test('turns #id links into native anchors when the target exists', () => {
  const { layers, warnings } = htmlToLayersOnServer(`
    <div class="flex"><a href="#features" target="_self">Features</a><a href="#faq">FAQ</a><a href="#missing">Nope</a></div>
    <section id="features"></section>`, { anchorIds: ['faq'] });

  const [features, faq, missing] = layers[0].children as Layer[];
  assert.deepEqual(features.variables?.link, { type: 'url', anchor_layer_id: 'features', target: '_self' });
  assert.equal(faq.variables?.link?.anchor_layer_id, 'faq');
  assert.equal(missing.variables?.link?.url?.data.content, '#missing');
  assert.deepEqual(warnings.map((w) => w.message), [
    'Link "#missing" has no element with id "missing" in the import or on the page, so it was kept as a URL',
  ]);
});

test('returns refs for ids and data-ref without keeping data-ref', () => {
  const { layers, warnings, refs } = htmlToLayersOnServer(`
    <section id="top"><a data-ref="cta" href="https://example.com" class="px-4">Go</a><img data-ref="hero" src="https://example.com/a.png" alt=""></section>`);

  const [section] = layers;
  const [cta, hero] = section.children as Layer[];
  assert.deepEqual(refs, { top: section.id, cta: cta.id, hero: hero.id });
  assert.equal(cta.attributes?.['data-ref'], undefined);
  assert.deepEqual(warnings, []);
});

test('imports mobile-first, gradient and inset classes as editable design', () => {
  const { layers, warnings } = htmlToLayersOnServer(`
    <section class="relative flex flex-col md:flex-row antialiased bg-linear-to-r from-blue-500 to-white">
      <div class="absolute inset-0"></div>
      <h1 class="text-4xl sm:text-5xl lg:text-7xl">Hi</h1>
    </section>`);

  const [section] = layers;
  assert.equal(section.classes, 'relative flex flex-row max-md:flex-col antialiased bg-[linear-gradient(to_right,#3b82f6,#ffffff)]');
  assert.equal(section.design?.layout?.flexDirection, 'row');
  assert.equal(section.design?.backgrounds?.backgroundColor, 'linear-gradient(to_right,#3b82f6,#ffffff)');

  const [overlay, heading] = section.children as Layer[];
  assert.equal(overlay.classes, 'absolute top-[0px] right-[0px] bottom-[0px] left-[0px]');
  assert.equal(overlay.design?.positioning?.top, '0px');
  assert.equal(heading.classes, 'text-7xl max-lg:text-5xl max-md:text-4xl');

  assert.deepEqual(warnings.map((w) => w.message), [
    '"sm:text-5xl" was approximated: Ycode\'s mobile breakpoint covers everything below 768px, so mobile uses the unprefixed value',
  ]);
});

test('classesToDesign keeps breakpoint classes out of the desktop design', () => {
  const design = classesToDesign('flex flex-row gap-[16px] max-md:flex-col max-lg:gap-[8px]');
  assert.equal(design?.layout?.flexDirection, 'row');
  assert.equal(design?.layout?.gap, '16px');
});

test('classesToDesign reads font-[…] as a weight only when numeric', () => {
  const typography = (classes: string) => {
    const t = classesToDesign(classes)?.typography;
    return { fontFamily: t?.fontFamily, fontWeight: t?.fontWeight };
  };
  assert.deepEqual(typography('font-[Inter]'), { fontFamily: 'Inter', fontWeight: undefined });
  assert.deepEqual(typography('font-[DM_Sans]'), { fontFamily: 'DM Sans', fontWeight: undefined });
  assert.deepEqual(typography("font-['Instrument_Serif']"), { fontFamily: 'Instrument Serif', fontWeight: undefined });
  assert.deepEqual(typography('font-semibold font-[Inter]'), { fontFamily: 'Inter', fontWeight: '600' });
  assert.deepEqual(typography('font-[650]'), { fontFamily: undefined, fontWeight: '650' });
});
