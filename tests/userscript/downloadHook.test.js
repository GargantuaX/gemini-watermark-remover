import test from 'node:test';
import assert from 'node:assert/strict';

import { createGeminiDownloadFetchHook } from '../../src/userscript/downloadHook.js';

test('createGeminiDownloadFetchHook should delegate non-target requests untouched', async () => {
  const calls = [];
  const originalFetch = async (...args) => {
    calls.push(args);
    return new Response('plain', {
      status: 200,
      headers: { 'content-type': 'text/plain' }
    });
  };

  const hook = createGeminiDownloadFetchHook({
    originalFetch,
    isTargetUrl: () => false,
    normalizeUrl: (url) => `${url}?normalized`,
    processBlob: async () => {
      throw new Error('should not run');
    }
  });

  const response = await hook('https://example.com/file.txt');

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://example.com/file.txt');
  assert.equal(await response.text(), 'plain');
});

test('createGeminiDownloadFetchHook should normalize Gemini asset url and replace response body with processed blob', async () => {
  const seenUrls = [];
  const originalFetch = async (input) => {
    seenUrls.push(typeof input === 'string' ? input : input.url);
    return new Response(new Blob(['original'], { type: 'image/png' }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'image/png', 'x-source': 'origin' }
    });
  };

  const hook = createGeminiDownloadFetchHook({
    originalFetch,
    isTargetUrl: (url) => url.includes('googleusercontent.com'),
    normalizeUrl: () => 'https://lh3.googleusercontent.com/rd-gg/token=s0',
    processBlob: async (blob) => {
      assert.equal(await blob.text(), 'original');
      return new Blob(['processed'], { type: 'image/png' });
    }
  });

  const response = await hook('https://lh3.googleusercontent.com/rd-gg/token=s1024');

  assert.deepEqual(seenUrls, ['https://lh3.googleusercontent.com/rd-gg/token=s0']);
  assert.equal(await response.text(), 'processed');
  assert.equal(response.status, 200);
  assert.equal(response.statusText, 'OK');
  assert.equal(response.headers.get('x-source'), 'origin');
  assert.equal(response.headers.get('content-type'), 'image/png');
});

test('createGeminiDownloadFetchHook should fall back to original response when processing fails', async () => {
  const originalFetch = async () => new Response(new Blob(['original'], { type: 'image/png' }), {
    status: 200,
    headers: { 'content-type': 'image/png' }
  });

  const hook = createGeminiDownloadFetchHook({
    originalFetch,
    isTargetUrl: () => true,
    normalizeUrl: (url) => url,
    processBlob: async () => {
      throw new Error('boom');
    }
  });

  const response = await hook('https://lh3.googleusercontent.com/rd-gg/token=s1024');

  assert.equal(await response.text(), 'original');
});

test('createGeminiDownloadFetchHook should reprocess repeated normalized url requests after the in-flight cache settles', async () => {
  let processCount = 0;
  const originalFetch = async () => new Response(new Blob(['original'], { type: 'image/png' }), {
    status: 200,
    headers: { 'content-type': 'image/png' }
  });

  const hook = createGeminiDownloadFetchHook({
    originalFetch,
    isTargetUrl: () => true,
    normalizeUrl: () => 'https://lh3.googleusercontent.com/rd-gg/token=s0',
    processBlob: async () => {
      processCount += 1;
      return new Blob([`processed-${processCount}`], { type: 'image/png' });
    }
  });

  const first = await hook('https://lh3.googleusercontent.com/rd-gg/token=s1024');
  const second = await hook('https://lh3.googleusercontent.com/rd-gg/token=s512');

  assert.equal(await first.text(), 'processed-1');
  assert.equal(await second.text(), 'processed-2');
  assert.equal(processCount, 2);
});

test('createGeminiDownloadFetchHook should only keep in-flight cache entries and release them after success', async () => {
  let processCount = 0;
  let releaseProcessing = null;
  let notifyProcessingStarted = null;
  const processingStarted = new Promise((resolve) => {
    notifyProcessingStarted = resolve;
  });
  const cache = new Map();
  const originalFetch = async () => new Response(new Blob(['original'], { type: 'image/png' }), {
    status: 200,
    headers: { 'content-type': 'image/png' }
  });

  const hook = createGeminiDownloadFetchHook({
    originalFetch,
    cache,
    isTargetUrl: () => true,
    normalizeUrl: () => 'https://lh3.googleusercontent.com/rd-gg/token=s0',
    processBlob: async () => {
      processCount += 1;
      notifyProcessingStarted();
      await new Promise((resolve) => {
        releaseProcessing = resolve;
      });
      return new Blob([`processed-${processCount}`], { type: 'image/png' });
    }
  });

  const firstPromise = hook('https://lh3.googleusercontent.com/rd-gg/token=s1024');
  const secondPromise = hook('https://lh3.googleusercontent.com/rd-gg/token=s512');
  await processingStarted;

  releaseProcessing();

  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(await first.text(), 'processed-1');
  assert.equal(await second.text(), 'processed-1');
  assert.equal(processCount, 1);
  assert.equal(cache.size, 0);
});

test('createGeminiDownloadFetchHook should bypass interception when gwr bypass flag is present', async () => {
  const calls = [];
  const originalFetch = async (...args) => {
    calls.push(args);
    return new Response('plain', {
      status: 200,
      headers: { 'content-type': 'text/plain' }
    });
  };

  const hook = createGeminiDownloadFetchHook({
    originalFetch,
    isTargetUrl: () => true,
    normalizeUrl: () => 'https://lh3.googleusercontent.com/rd-gg/token=s0',
    processBlob: async () => {
      throw new Error('should not run');
    }
  });

  const response = await hook('https://lh3.googleusercontent.com/rd-gg/token=s1024', {
    gwrBypass: true
  });

  assert.equal(await response.text(), 'plain');
  assert.equal(calls.length, 1);
});
