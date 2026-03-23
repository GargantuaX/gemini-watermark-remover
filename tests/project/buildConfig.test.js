import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('build should not emit or reference any Chrome extension bundle outputs', () => {
  const buildScript = readFileSync(new URL('../../build.js', import.meta.url), 'utf8');

  assert.doesNotMatch(buildScript, /src\/extension\/pageHook\.js/);
  assert.doesNotMatch(buildScript, /src\/extension\/contentScript\.js/);
  assert.doesNotMatch(buildScript, /src\/extension\/popup\.js/);
  assert.doesNotMatch(buildScript, /dist\/extension\//);
  assert.doesNotMatch(buildScript, /manifest\.json/);
  assert.doesNotMatch(buildScript, /popup\.html/);
});
