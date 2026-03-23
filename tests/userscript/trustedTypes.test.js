import test from 'node:test';
import assert from 'node:assert/strict';

import { toWorkerScriptUrl } from '../../src/userscript/trustedTypes.js';

test('toWorkerScriptUrl should return original url when trustedTypes is unavailable', () => {
  const url = 'blob:https://example.com/123';
  const out = toWorkerScriptUrl(url, {});
  assert.equal(out, url);
});

test('toWorkerScriptUrl should reuse existing policy when available', () => {
  const policy = { createScriptURL: (value) => `trusted:${value}` };
  const env = {
    trustedTypes: {
      getPolicy: (name) => (name === 'gemini-watermark-remover' ? policy : null),
      createPolicy: () => {
        throw new Error('createPolicy should not be called');
      }
    }
  };

  const out = toWorkerScriptUrl('blob:https://example.com/123', env);
  assert.equal(out, 'trusted:blob:https://example.com/123');
});

test('toWorkerScriptUrl should create policy when missing', () => {
  let created = false;
  const env = {
    trustedTypes: {
      getPolicy: () => null,
      createPolicy: (name, rules) => {
        created = name === 'gemini-watermark-remover' && typeof rules?.createScriptURL === 'function';
        return { createScriptURL: (value) => `trusted:${rules.createScriptURL(value)}` };
      }
    }
  };

  const out = toWorkerScriptUrl('blob:https://example.com/123', env);
  assert.equal(created, true);
  assert.equal(out, 'trusted:blob:https://example.com/123');
});

test('toWorkerScriptUrl should return null when policy creation is blocked', () => {
  const env = {
    trustedTypes: {
      getPolicy: () => null,
      createPolicy: () => {
        throw new TypeError('Refused to create a TrustedTypePolicy');
      }
    }
  };

  const out = toWorkerScriptUrl('blob:https://example.com/123', env);
  assert.equal(out, null);
});
