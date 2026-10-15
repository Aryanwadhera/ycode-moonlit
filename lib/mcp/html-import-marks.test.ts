import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyCmsMarks, applyToggleMarks } from './html-import-marks';
import { extractMarkedComponents } from './html-import-components';
import { findLayerById } from './utils';
import { htmlToLayersOnServer } from '../server/html-to-layers';
import type { Collection, CollectionField, Layer, Page } from '../../types';

const field = (id: string, name: string, type: CollectionField['type'], key: string | null = null) =>
  ({ id, name, type, key, collection_id: 'col_1' }) as CollectionField;

const FIELDS = [
  field('f_name', 'Name', 'text', 'name'),
  field('f_slug', 'Slug', 'text', 'slug'),
  field('f_cover', 'Cover', 'image'),
  field('f_url', 'Website', 'link'),
  field('f_featured', 'Featured', 'boolean'),
  field('f_date', 'Date', 'date'),
];

function deps(overrides: Partial<Parameters<typeof applyCmsMarks>[2]> = {}) {
  return {
    getCollections: async () => [{ id: 'col_1', name: 'Programs' } as Collection],
    getFields: async (id: string) => (id === 'col_1' ? FIELDS : []),
    getPages: async () => [{ id: 'page_dyn', is_dynamic: true, settings: { cms: { collection_id: 'col_1', slug_field_id: 'f_slug' } } } as Page],
    ...overrides,
  };
}

const classesOf = (layer: Layer) => (Array.isArray(layer.classes) ? layer.classes.join(' ') : layer.classes);

test('toggle and menu marks create the native click interaction scoped to the hidden breakpoints', () => {
  const converted = htmlToLayersOnServer(`
    <header class="flex">
      <button data-ref="btn" data-ycode-toggle="menu" class="hidden max-lg:flex p-2">Menu</button>
      <nav data-ref="panel" data-ycode-menu="menu" class="flex gap-4 max-lg:hidden"><a href="/a">A</a></nav>
    </header>`);
  const { layers, toggles, warnings } = applyToggleMarks(converted.layers, converted.ycodeMarks);

  assert.deepEqual(warnings, []);
  assert.equal(toggles.length, 1);
  assert.deepEqual(toggles[0].breakpoints, ['tablet', 'mobile']);

  const button = findLayerById(layers, converted.refs.btn)!;
  const panel = findLayerById(layers, converted.refs.panel)!;
  assert.equal(button.interactions!.length, 1);
  const interaction = button.interactions![0];
  assert.equal(interaction.trigger, 'click');
  assert.deepEqual(interaction.timeline, { breakpoints: ['tablet', 'mobile'], repeat: 0, yoyo: true });
  assert.equal(interaction.tweens[0].layer_id, panel.id);
  assert.deepEqual(interaction.tweens[0].from, { display: 'hidden' });
  assert.deepEqual(interaction.tweens[0].to, { display: 'visible' });
  assert.deepEqual(interaction.tweens[0].apply_styles, { display: 'on-load' });
  // The static hidden class would keep the panel closed after the click.
  assert.doesNotMatch(classesOf(panel), /max-lg:hidden/);
  // Annotations are consumed, not reported as dropped attributes.
  assert.ok(!converted.warnings.some((w) => /data-ycode/.test(w.message)), JSON.stringify(converted.warnings));
});

test('mobile-first markup resolves the toggle breakpoint and unpaired marks warn', () => {
  const converted = htmlToLayersOnServer(`
    <header>
      <button data-ycode-toggle class="md:hidden">Menu</button>
      <nav data-ycode-menu class="hidden md:flex"></nav>
      <button data-ycode-toggle="other">Other</button>
    </header>`);
  const { toggles, warnings } = applyToggleMarks(converted.layers, converted.ycodeMarks);

  assert.equal(toggles.length, 1);
  assert.deepEqual(toggles[0].breakpoints, ['mobile']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /data-ycode-toggle="other" has no data-ycode-menu/);
});

test('toggle interactions follow the navbar into its component master', async () => {
  const converted = htmlToLayersOnServer(`
    <header data-ycode-component="Navbar">
      <button data-ycode-toggle="menu" class="lg:hidden">Menu</button>
      <nav data-ycode-menu="menu" class="hidden lg:flex"></nav>
    </header>`);
  const toggled = applyToggleMarks(converted.layers, converted.ycodeMarks);
  const created: { name: string; layers: Layer[] }[] = [];
  await extractMarkedComponents(toggled.layers, converted.componentMarks, converted.refs, [], async (name, layers) => {
    created.push({ name, layers });
    return 'cmp_1';
  });

  const master = created[0].layers[0];
  const button = master.children!.find((c) => c.interactions)!;
  const panel = master.children!.find((c) => c !== button)!;
  assert.equal(button.interactions![0].tweens[0].layer_id, panel.id);
});

test('collection marks bind the repeated item, its fields and the item link', async () => {
  const converted = htmlToLayersOnServer(`
    <section>
      <div class="grid grid-cols-3 gap-6">
        <a data-ref="card" data-ycode-collection="programs" data-ycode-limit="6" data-ycode-sort="Date:desc"
           data-ycode-filter="Featured=true" data-ycode-link="item" href="#" class="flex flex-col">
          <img data-ref="img" data-ycode-field="Cover" data-ycode-field-alt="name" src="https://x.test/a.jpg" alt="">
          <h3 data-ref="title" data-ycode-field="Name" class="text-[20px]">Placeholder</h3>
          <p data-ref="copy" class="text-[14px]">Static copy</p>
        </a>
        <a data-ycode-preview-only href="#" class="flex flex-col"><h3>Copy 2</h3></a>
        <a data-preview-only href="#" class="flex flex-col"><h3>Copy 3</h3></a>
      </div>
    </section>`);
  const grid = converted.layers[0].children![0];
  assert.equal(grid.children!.length, 1, 'preview-only copies are dropped');

  const result = await applyCmsMarks(converted.layers, converted.ycodeMarks, deps());
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.collection_lists, [{ layer_id: converted.refs.card, collection_id: 'col_1', collection_name: 'Programs' }]);
  assert.equal(result.fields_bound, 3);
  assert.equal(result.item_links, 1);

  const card = findLayerById(result.layers, converted.refs.card)!;
  assert.equal(card.variables!.collection!.id, 'col_1');
  assert.equal(card.variables!.collection!.limit, 6);
  assert.equal(card.variables!.collection!.sort_by, 'f_date');
  assert.equal(card.variables!.collection!.sort_order, 'desc');
  assert.equal(card.variables!.collection!.filters!.groups.length, 1);
  assert.equal(card.variables!.collection!.filters!.groups[0].conditions[0].fieldId, 'f_featured');
  assert.equal(card.variables!.collection!.filters!.groups[0].conditions[0].operator, 'is');
  assert.deepEqual(card.variables!.link, { type: 'page', page: { id: 'page_dyn', collection_item_id: 'current-collection' } });

  const title = findLayerById(result.layers, converted.refs.title)!;
  const titleDoc = title.variables!.text!.data.content as { content: { content: { type: string; attrs?: { variable: { data: { field_id: string; collection_layer_id: string } } } }[] }[] };
  const node = titleDoc.content[0].content[0];
  assert.equal(node.type, 'dynamicVariable');
  assert.equal(node.attrs!.variable.data.field_id, 'f_name');
  assert.equal(node.attrs!.variable.data.collection_layer_id, card.id);

  const img = findLayerById(result.layers, converted.refs.img)!;
  assert.equal(img.variables!.image!.src.type, 'field');
  assert.equal((img.variables!.image!.src as { data: { field_id: string } }).data.field_id, 'f_cover');
  assert.match((img.variables!.image!.alt as { data: { content: string } }).data.content, /"field_id":"f_name"/);

  const copy = findLayerById(result.layers, converted.refs.copy)!;
  assert.equal(copy.variables!.text!.type, 'dynamic_rich_text', 'unmarked text stays static');
});

test('unresolved collections, fields and links are reported and left static', async () => {
  const converted = htmlToLayersOnServer(`
    <div>
      <div data-ref="card" data-ycode-collection="Missing"><h3 data-ycode-field="Name">A</h3></div>
      <div data-ref="card2" data-ycode-collection="Programs" data-ycode-sort="Nope">
        <h3 data-ycode-field="Nope">B</h3>
        <a data-ycode-field="Website" href="/x">Visit</a>
        <button data-ycode-link="item">Open</button>
      </div>
    </div>`);
  const result = await applyCmsMarks(converted.layers, converted.ycodeMarks, deps({ getPages: async () => [] }));

  const messages = result.warnings.map((w) => w.message);
  assert.equal(messages.length, 5, JSON.stringify(messages));
  assert.match(messages[0], /Collection "Missing" not found/);
  assert.match(messages[1], /data-ycode-sort ignored: sort field "Nope" not found/);
  assert.match(messages[2], /not inside a data-ycode-collection element and this is not a dynamic page/);
  assert.match(messages[3], /Field "Nope" not found/);
  assert.match(messages[4], /no dynamic page yet/);

  const card = findLayerById(result.layers, converted.refs.card)!;
  assert.equal(card.variables?.collection, undefined);
  const card2 = findLayerById(result.layers, converted.refs.card2)!;
  assert.equal(card2.variables!.collection!.id, 'col_1');
  assert.equal(card2.variables!.collection!.sort_by, undefined);

  const link = card2.children!.find((c) => c.variables?.link)!;
  assert.equal(link.variables!.link!.type, 'field');
  assert.equal(link.variables!.link!.field!.data.field_id, 'f_url');
  assert.equal(result.fields_bound, 1);
});

test('fields outside a collection bind the dynamic page item', async () => {
  const converted = htmlToLayersOnServer('<section><div><h1 data-ref="h" data-ycode-field="Name">Title</h1></div></section>');
  const result = await applyCmsMarks(converted.layers, converted.ycodeMarks, deps({ pageCollectionId: 'col_1' }));
  assert.deepEqual(result.warnings, []);
  const heading = findLayerById(result.layers, converted.refs.h)!;
  const doc = heading.variables!.text!.data.content as { content: { content: { attrs: { variable: { data: { source: string; collection_layer_id?: string } } } }[] }[] };
  assert.equal(doc.content[0].content[0].attrs.variable.data.source, 'page');
  assert.equal(doc.content[0].content[0].attrs.variable.data.collection_layer_id, undefined);
});

test('a field mark on an inline element inside running text is reported, not applied', () => {
  const converted = htmlToLayersOnServer('<p>From <span data-ycode-field="Price">$10</span> per month</p>');
  assert.equal(converted.ycodeMarks.length, 0);
  assert.ok(converted.warnings.some((w) => /data-ycode-field on an inline <span>/.test(w.message)), JSON.stringify(converted.warnings));
});
