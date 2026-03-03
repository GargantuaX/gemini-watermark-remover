import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('userscript metadata should match gemini.google.com and business.gemini.google', () => {
    const buildScript = readFileSync(new URL('../../build.js', import.meta.url), 'utf8');

    assert.match(buildScript, /\/\/ @match\s+https:\/\/gemini\.google\.com\/\*/);
    assert.match(buildScript, /\/\/ @match\s+https:\/\/business\.gemini\.google\/\*/);
});
