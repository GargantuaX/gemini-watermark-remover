import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldUseInlineWorker } from '../../src/userscript/runtimeFlags.js';

function createStorage(initialValue = null) {
  let value = initialValue;
  return {
    getItem(key) {
      if (key !== '__gwr_force_inline_worker__') return null;
      return value;
    },
    setItem(key, nextValue) {
      if (key !== '__gwr_force_inline_worker__') return;
      value = String(nextValue);
    }
  };
}

test('shouldUseInlineWorker should stay disabled by default when build flag is off', () => {
  const env = {
    Worker: class {},
    Blob,
    localStorage: createStorage(null)
  };

  assert.equal(shouldUseInlineWorker('self.onmessage = () => {};', env), false);
});

test('shouldUseInlineWorker should allow forcing worker mode through a runtime global flag', () => {
  const env = {
    __GWR_FORCE_INLINE_WORKER__: true,
    Worker: class {},
    Blob,
    localStorage: createStorage(null)
  };

  assert.equal(shouldUseInlineWorker('self.onmessage = () => {};', env), true);
});

test('shouldUseInlineWorker should allow forcing worker mode through localStorage', () => {
  const env = {
    Worker: class {},
    Blob,
    localStorage: createStorage('1')
  };

  assert.equal(shouldUseInlineWorker('self.onmessage = () => {};', env), true);
});

test('shouldUseInlineWorker should read force flag from unsafeWindow global', () => {
  const env = {
    Worker: class {},
    Blob,
    unsafeWindow: {
      __GWR_FORCE_INLINE_WORKER__: true
    },
    localStorage: createStorage(null)
  };

  assert.equal(shouldUseInlineWorker('self.onmessage = () => {};', env), true);
});

test('shouldUseInlineWorker should read force flag from unsafeWindow localStorage', () => {
  const env = {
    Worker: class {},
    Blob,
    unsafeWindow: {
      localStorage: createStorage('true')
    },
    localStorage: createStorage(null)
  };

  assert.equal(shouldUseInlineWorker('self.onmessage = () => {};', env), true);
});

test('shouldUseInlineWorker should ignore force flags when worker primitives are unavailable', () => {
  const env = {
    __GWR_FORCE_INLINE_WORKER__: true,
    localStorage: createStorage('1')
  };

  assert.equal(shouldUseInlineWorker('self.onmessage = () => {};', env), false);
});
