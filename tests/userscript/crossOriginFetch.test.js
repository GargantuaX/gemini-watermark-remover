import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createUserscriptBlobFetcher,
  parseMimeTypeFromResponseHeaders
} from '../../src/userscript/crossOriginFetch.js';

test('parseMimeTypeFromResponseHeaders should read content-type case-insensitively', () => {
  const headers = 'Date: Thu, 20 Mar 2026 00:00:00 GMT\r\nContent-Type: image/webp\r\nX-Test: ok';
  assert.equal(parseMimeTypeFromResponseHeaders(headers), 'image/webp');
});

test('createUserscriptBlobFetcher should use GM_xmlhttpRequest response as blob', async () => {
  const calls = [];
  const fetchBlob = createUserscriptBlobFetcher({
    gmRequest: (options) => {
      calls.push(options);
      options.onload?.({
        status: 200,
        response: new TextEncoder().encode('image-bytes').buffer,
        responseHeaders: 'Content-Type: image/webp\r\n'
      });
    }
  });

  const blob = await fetchBlob('https://lh3.googleusercontent.com/gg/example=s1024-rj');

  assert.equal(blob.type, 'image/webp');
  assert.equal(await blob.text(), 'image-bytes');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].responseType, 'arraybuffer');
});

test('createUserscriptBlobFetcher should reject non-2xx responses', async () => {
  const fetchBlob = createUserscriptBlobFetcher({
    gmRequest: (options) => {
      options.onload?.({
        status: 403,
        response: new ArrayBuffer(0),
        responseHeaders: 'Content-Type: text/plain\r\n'
      });
    }
  });

  await assert.rejects(
    () => fetchBlob('https://lh3.googleusercontent.com/gg/example=s1024-rj'),
    /Failed to fetch image: 403/
  );
});
