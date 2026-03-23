import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('userscript metadata should explicitly match Gemini app entry routes', () => {
    const buildScript = readFileSync(new URL('../../build.js', import.meta.url), 'utf8');

    assert.match(buildScript, /\/\/ @match\s+https:\/\/gemini\.google\.com\/app/);
    assert.match(buildScript, /\/\/ @match\s+https:\/\/gemini\.google\.com\/app\/\*/);
    assert.match(buildScript, /\/\/ @match\s+https:\/\/gemini\.google\.com\/\*/);
    assert.match(buildScript, /\/\/ @match\s+https:\/\/business\.gemini\.google\/app/);
    assert.match(buildScript, /\/\/ @match\s+https:\/\/business\.gemini\.google\/app\/\*/);
    assert.match(buildScript, /\/\/ @match\s+https:\/\/business\.gemini\.google\/\*/);
    assert.match(buildScript, /\/\/ @grant\s+unsafeWindow/);
    assert.match(buildScript, /\/\/ @grant\s+GM_xmlhttpRequest/);
});
