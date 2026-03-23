import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('userscript entry should import shared page image replacement from src/shared', () => {
  const source = readFileSync(new URL('../../src/userscript/index.js', import.meta.url), 'utf8');

  assert.match(source, /from '\.\.\/shared\/pageImageReplacement\.js'/);
  assert.doesNotMatch(source, /from '\.\.\/extension\/pageImageReplacement\.js'/);
});

test('shared Gemini page-processing modules should live under src/shared instead of src/extension', () => {
  const sharedModules = [
    'domAdapter.js',
    'errorUtils.js',
    'imageProcessing.js',
    'originalBlob.js',
    'pageImageReplacement.js'
  ];

  for (const moduleName of sharedModules) {
    assert.equal(
      existsSync(new URL(`../../src/shared/${moduleName}`, import.meta.url)),
      true,
      `expected src/shared/${moduleName} to exist`
    );
    assert.equal(
      existsSync(new URL(`../../src/extension/${moduleName}`, import.meta.url)),
      false,
      `expected src/extension/${moduleName} to be removed`
    );
  }
});

test('plugin removal checks should not keep using tests/extension as the active test namespace', () => {
  assert.equal(
    existsSync(new URL('../../tests/extension', import.meta.url)),
    false,
    'expected tests/extension to be removed after the plugin cleanup'
  );
  assert.equal(
    existsSync(new URL('../../tests/project', import.meta.url)),
    true,
    'expected plugin-removal regression tests to move under tests/project'
  );
});
