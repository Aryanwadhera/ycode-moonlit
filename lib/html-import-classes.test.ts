import assert from 'node:assert/strict';
import { test } from 'node:test';

import { convertGradientClasses, convertMobileFirstClasses, normalizeNegativeMargins, normalizePositionClasses } from './html-import-classes';

const convert = (classes: string) => convertMobileFirstClasses(classes.split(' '));

test('converts mobile-first breakpoints to desktop-first per property', () => {
  assert.deepEqual(convert('flex flex-col md:flex-row gap-4 lg:gap-8').classes, [
    'flex', 'flex-row', 'max-md:flex-col', 'gap-8', 'max-lg:gap-4',
  ]);
  assert.deepEqual(convert('hidden md:block').classes, ['block', 'max-md:hidden']);
  assert.deepEqual(convert('text-[32px] md:text-[48px] lg:text-[64px]').classes, [
    'text-[64px]', 'max-lg:text-[48px]', 'max-md:text-[32px]',
  ]);
  assert.deepEqual(convert('grid-cols-1 md:grid-cols-2 lg:grid-cols-2').classes, ['grid-cols-2', 'max-md:grid-cols-1']);
});

test('keeps hover states with their breakpoint', () => {
  assert.deepEqual(convert('hover:bg-[#000] md:hover:bg-[#111]').classes, ['hover:bg-[#111]', 'max-md:hover:bg-[#000]']);
});

test('reports sm: values it can only approximate', () => {
  const result = convert('px-4 sm:px-6 lg:px-8');
  assert.deepEqual(result.classes, ['px-8', 'max-lg:px-6', 'max-md:px-4']);
  assert.deepEqual(result.approximated, ['sm:px-6']);
});

test('fills a missing base value with the browser default', () => {
  assert.deepEqual(convert('md:col-span-2').classes, ['col-span-2', 'max-md:col-span-1']);
  assert.deepEqual(convert('md:w-1/2 lg:p-8').classes, ['w-1/2', 'max-md:w-auto', 'p-8', 'max-lg:p-[0px]']);
  assert.deepEqual(convert('flex flex-col md:flex-row').classes, ['flex', 'flex-row', 'max-md:flex-col']);
  assert.deepEqual(convert('md:flex-row').classes, ['flex-row']);
  assert.deepEqual(convert('md:flex').classes, ['flex', 'max-md:block']);
  assert.deepEqual(convertMobileFirstClasses(['md:flex'], 'inline').classes, ['flex', 'max-md:inline']);
});

test('leaves groups it cannot express unchanged', () => {
  assert.deepEqual(convert('md:text-[20px] p-4').classes, ['md:text-[20px]', 'p-4']);
  assert.deepEqual(convert('md:hover:bg-[#111]').classes, ['md:hover:bg-[#111]']);
  assert.deepEqual(convert('p-4 md:p-8 xl:p-12').classes, ['p-4', 'md:p-8', 'xl:p-12']);
  assert.deepEqual(convert('space-y-4 md:space-y-8').classes, ['space-y-4', 'md:space-y-8']);
  assert.deepEqual(convert('flex max-md:flex-col').classes, ['flex', 'max-md:flex-col']);
});

test('expands inset and writes side values the position controls edit', () => {
  assert.deepEqual(normalizePositionClasses(['inset-0', 'max-md:inset-x-[16px]', 'inset-y-auto', 'z-10']), [
    'top-[0px]', 'right-[0px]', 'bottom-[0px]', 'left-[0px]',
    'max-md:left-[16px]', 'max-md:right-[16px]',
    'top-auto', 'bottom-auto',
    'z-10',
  ]);
  assert.deepEqual(normalizePositionClasses(['top-4', '-left-2', 'right-1/2', 'bottom-px', 'top-full']), [
    'top-[1rem]', 'left-[-0.5rem]', 'right-[50%]', 'bottom-[1px]', 'top-[100%]',
  ]);
});

test('combines v4 gradient stops into one editable gradient', () => {
  assert.deepEqual(
    convertGradientClasses(['p-4', 'bg-linear-to-r', 'from-[#3b82f6]', 'via-[#fff]', 'to-[#000]']),
    ['p-4', 'bg-[linear-gradient(to_right,#3b82f6,#fff,#000)]'],
  );
  assert.deepEqual(convertGradientClasses(['bg-linear-45', 'from-[#fff]']), ['bg-[linear-gradient(45deg,#fff,transparent)]']);
  assert.deepEqual(
    convertGradientClasses(['hover:bg-linear-to-b', 'hover:to-[#000]']),
    ['hover:bg-[linear-gradient(to_bottom,transparent,#000)]'],
  );
  assert.deepEqual(
    convertGradientClasses(['bg-linear-to-b', 'from-[#000]', 'to-transparent']),
    ['bg-[linear-gradient(to_bottom,#000,transparent)]'],
  );
  assert.deepEqual(convertGradientClasses(['from-[#fff]', 'to-[#000]']), ['from-[#fff]', 'to-[#000]']);
  assert.deepEqual(convertGradientClasses(['bg-linear-to-r', 'from-[#fff]/50']), ['bg-linear-to-r', 'from-[#fff]/50']);
});

test('rewrites negative margins as arbitrary values the spacing controls edit', () => {
  assert.deepEqual(
    normalizeNegativeMargins(['-ml-3', '-mt-[12px]', 'md:-mx-px', '-mb-auto', 'ml-3', '-translate-x-4']),
    ['ml-[-0.75rem]', 'mt-[-12px]', 'md:mx-[-1px]', '-mb-auto', 'ml-3', '-translate-x-4'],
  );
});
