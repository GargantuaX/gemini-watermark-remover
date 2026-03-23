import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('package should not expose Chrome extension smoke or debug scripts anymore', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

  assert.equal(packageJson.scripts?.['test:extension-smoke'], undefined);
  assert.equal(packageJson.scripts?.['debug:auto'], undefined);
  assert.equal(packageJson.scripts?.['debug:auto:clean'], undefined);
  assert.equal(packageJson.scripts?.['debug:manual'], undefined);
  assert.equal(packageJson.scripts?.['debug:manual:clean'], undefined);
  assert.equal(packageJson.scripts?.['debug:chrome'], undefined);
  assert.equal(packageJson.scripts?.['debug:chrome:clean'], undefined);
});

test('ci workflow should not run a removed extension smoke step', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

  assert.doesNotMatch(workflow, /name:\s+Extension smoke/i);
  assert.doesNotMatch(workflow, /run:\s+pnpm test:extension-smoke/i);
});

test('README files should no longer document a Chrome extension workflow', async () => {
  const readmeZh = await readFile(new URL('../../README_zh.md', import.meta.url), 'utf8');
  const readmeEn = await readFile(new URL('../../README.md', import.meta.url), 'utf8');

  assert.doesNotMatch(readmeZh, /Chrome 插件/i);
  assert.doesNotMatch(readmeZh, /dist\/extension/);
  assert.doesNotMatch(readmeZh, /加载已解压缩的扩展程序|Load unpacked/i);
  assert.doesNotMatch(readmeZh, /pnpm debug:auto/);
  assert.doesNotMatch(readmeZh, /pnpm debug:manual/);

  assert.doesNotMatch(readmeEn, /Chrome Extension/i);
  assert.doesNotMatch(readmeEn, /dist\/extension/);
  assert.doesNotMatch(readmeEn, /Load unpacked/i);
  assert.doesNotMatch(readmeEn, /pnpm debug:auto/);
  assert.doesNotMatch(readmeEn, /pnpm debug:manual/);
});
