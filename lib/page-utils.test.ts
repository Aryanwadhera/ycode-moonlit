import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLocaleSwitchTarget } from '@/lib/page-utils';
import type { CollectionItemWithValues, Page } from '@/types';

const makePage = (overrides: Partial<Page>): Page => ({
  id: 'page',
  slug: 'about',
  error_page: null,
  is_dynamic: false,
  ...overrides,
} as Page);

const about = { page: makePage({ id: 'about' }) };
const error401 = { page: makePage({ id: 'error-401', slug: '', error_page: 401 }) };
const error404 = { page: makePage({ id: 'error-404', slug: '', error_page: 404 }) };

test('regular pages link to their own localized URLs', () => {
  assert.equal(getLocaleSwitchTarget(about), about);
});

test('a 401 page links to the protected page it replaces', () => {
  assert.equal(getLocaleSwitchTarget(error401, about), about);
});

test('a 401 page keeps the CMS item of a protected dynamic page', () => {
  const post = {
    page: makePage({ id: 'post', slug: '*', is_dynamic: true }),
    collectionItem: { id: 'item-1' } as CollectionItemWithValues,
  };
  assert.equal(getLocaleSwitchTarget(error401, post), post);
});

test('error pages without a requested page fall back to the current path', () => {
  assert.equal(getLocaleSwitchTarget(error404), null);
  assert.equal(getLocaleSwitchTarget(error404, null), null);
});
