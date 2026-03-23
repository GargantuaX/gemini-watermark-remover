import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('userscript entry should install both download hook and page image replacement', () => {
  const source = readFileSync(new URL('../../src/userscript/index.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /MutationObserver/);
  assert.doesNotMatch(source, /querySelectorAll\('img/);
  assert.doesNotMatch(source, /imgElement\.src\s*=\s*''/);
  assert.match(source, /installGeminiDownloadHook/);
  assert.match(source, /installPageImageReplacement/);
  assert.match(source, /installUserscriptProcessBridge/);
  assert.match(source, /createUserscriptProcessBridgeClient/);
});

test('userscript entry should explicitly pass GM_xmlhttpRequest to preview fetching', () => {
  const source = readFileSync(new URL('../../src/userscript/index.js', import.meta.url), 'utf8');

  assert.match(source, /createUserscriptBlobFetcher\(\{\s*gmRequest:/s);
  assert.match(source, /typeof GM_xmlhttpRequest === 'function'/);
});

test('userscript entry should not eagerly warm the main-thread engine during init', () => {
  const source = readFileSync(new URL('../../src/userscript/index.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /if\s*\(!workerClient\)\s*\{\s*\/\/ Warm up main-thread engine when worker acceleration is unavailable\.\s*getEngine\(\)\.catch/s);
});

test('userscript entry should verify inline worker readiness before enabling acceleration', () => {
  const source = readFileSync(new URL('../../src/userscript/processingRuntime.js', import.meta.url), 'utf8');

  assert.match(source, /await workerClient\.ping\(\)/);
  assert.match(source, /Worker initialization failed, using main thread/);
});

test('userscript entry should route preview processing through the shared bridge client', () => {
  const source = readFileSync(new URL('../../src/userscript/index.js', import.meta.url), 'utf8');

  assert.match(source, /processWatermarkBlobImpl:\s*bridgeClient\.processWatermarkBlob/);
  assert.match(source, /removeWatermarkFromBlobImpl:\s*bridgeClient\.removeWatermarkFromBlob/);
  assert.match(source, /processBlob:\s*bridgeClient\.removeWatermarkFromBlob/);
});

test('userscript entry should delegate watermark runtime logic to processingRuntime module', () => {
  const source = readFileSync(new URL('../../src/userscript/index.js', import.meta.url), 'utf8');

  assert.match(source, /import\s+\{\s*createUserscriptProcessingRuntime\s*\}\s+from\s+'\.\/processingRuntime\.js';/);
  assert.match(source, /const processingRuntime = createUserscriptProcessingRuntime\(/);
  assert.match(source, /await processingRuntime\.initialize\(\)/);
  assert.match(source, /processWatermarkBlob:\s*processingRuntime\.processWatermarkBlob/);
  assert.match(source, /removeWatermarkFromBlob:\s*processingRuntime\.removeWatermarkFromBlob/);
});

test('userscript entry should not inline duplicate worker runtime implementation', () => {
  const source = readFileSync(new URL('../../src/userscript/index.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /class InlineWorkerClient/);
  assert.doesNotMatch(source, /const canUseInlineWorker =/);
  assert.doesNotMatch(source, /async function getEngine\(/);
  assert.doesNotMatch(source, /async function processBlobWithBestPath\(/);
});

test('page image replacement should not observe self-written stable source attributes', () => {
  const source = readFileSync(new URL('../../src/shared/pageImageReplacement.js', import.meta.url), 'utf8');

  const observedAttributesMatch = source.match(/const OBSERVED_ATTRIBUTES = \[([^\]]+)\];/);
  assert.ok(observedAttributesMatch, 'expected OBSERVED_ATTRIBUTES declaration');
  assert.doesNotMatch(observedAttributesMatch[1], /data-gwr-stable-source/);
});
