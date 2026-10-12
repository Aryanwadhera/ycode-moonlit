import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractMarkedComponents } from './html-import-components';
import { htmlToLayersOnServer } from '../server/html-to-layers';
import type { Layer } from '../../types';

function fakeStore() {
  const created: { id: string; name: string; layers: Layer[] }[] = [];
  const create = async (name: string, layers: Layer[]) => {
    const id = `cmp_${created.length + 1}`;
    created.push({ id, name, layers });
    return id;
  };
  return { created, create };
}

async function importWithComponents(html: string, existing: { id: string; name: string }[] = []) {
  const converted = htmlToLayersOnServer(html);
  const store = fakeStore();
  const result = await extractMarkedComponents(converted.layers, converted.componentMarks, converted.refs, existing, store.create);
  return { ...result, created: store.created, converted };
}

test('a marked element becomes a component with an instance in its place', async () => {
  const { layers, components, created, refs, warnings } = await importWithComponents(`
    <section id="top"><div data-ycode-component="Card" class="p-4"><h3 data-ref="title" class="text-[20px]">A</h3></div></section>`);

  const instance = layers[0].children![0];
  assert.equal(instance.componentId, 'cmp_1');
  assert.deepEqual(instance.children, []);
  assert.equal(created.length, 1);
  assert.equal(created[0].name, 'Card');
  assert.equal(created[0].layers[0].customName, 'Card');
  assert.notEqual(created[0].layers[0].id, instance.id);

  const masterTitle = created[0].layers[0].children![0];
  assert.deepEqual(components.Card, {
    component_id: 'cmp_1',
    created: true,
    instance_layer_ids: [instance.id],
    refs: { title: masterTitle.id },
  });
  assert.equal(refs.title, undefined);
  assert.equal(refs.top, layers[0].id);
  assert.deepEqual(warnings, []);
});

test('repeated names reuse the first copy and nested marks become instances in the master', async () => {
  const { layers, created, components, warnings, converted } = await importWithComponents(`
    <section data-ycode-component="Pricing">
      <div data-ycode-component="Plan"><p>First</p></div>
      <div data-ycode-component="Plan"><p>Second</p></div>
    </section>`);

  assert.deepEqual(created.map((c) => c.name), ['Plan', 'Pricing']);
  assert.match(JSON.stringify(created[0].layers[0].children![0].variables?.text), /First/);
  const [first, second] = created[1].layers[0].children!;
  assert.equal(first.componentId, 'cmp_1');
  assert.equal(second.componentId, 'cmp_1');
  assert.equal(layers[0].componentId, 'cmp_2');
  const planMarks = converted.componentMarks.filter((mark) => mark.name === 'Plan').map((mark) => mark.layerId);
  assert.deepEqual(components.Plan.instance_layer_ids, planMarks);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /appears more than once/);
});

test('an existing component with the same name is reused, not recreated', async () => {
  const { layers, created, components, warnings } = await importWithComponents(
    '<header data-ycode-component="navbar"><a href="/">Home</a></header>',
    [{ id: 'cmp_existing', name: 'Navbar' }],
  );
  assert.equal(created.length, 0);
  assert.equal(layers[0].componentId, 'cmp_existing');
  assert.equal(components.navbar.created, false);
  assert.match(warnings[0].message, /Reused the existing component "navbar"/);
});

test('anchor links into a component keep pointing at the html id', async () => {
  const { layers, created } = await importWithComponents(`
    <nav class="flex"><a href="#faq" class="px-2">FAQ</a></nav>
    <div data-ycode-component="Faq"><section id="faq">Q</section></div>`);
  assert.equal(layers[0].children![0].variables?.link?.anchor_layer_id, 'faq');
  assert.equal(created[0].layers[0].children![0].attributes?.id ?? created[0].layers[0].children![0].settings?.id, 'faq');
});
