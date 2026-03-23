import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('userscript metadata version should be derived from package.json', () => {
  const buildScript = readFileSync(new URL('../../build.js', import.meta.url), 'utf8');

  assert.match(buildScript, /\/\/ @version\s+\$\{pkg\.version\}/);
  assert.doesNotMatch(buildScript, /\/\/ @version\s+0\.\d+\.\d+/);
});
