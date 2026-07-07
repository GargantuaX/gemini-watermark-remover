import test from 'node:test';
import assert from 'node:assert/strict';

import { installGeminiClipboardImageHook } from '../../src/userscript/clipboardHook.js';
import { createImageSessionStore } from '../../src/shared/imageSessionStore.js';
import { loadModuleSource, normalizeWhitespace } from '../testUtils/moduleStructure.js';

class MockClipboardItem {
  constructor(items = {}) {
    this.items = { ...items };
    this.types = Object.keys(this.items);
  }

  async getType(type) {
    const value = this.items[type];
    if (value && typeof value.then === 'function') {
      return value;
    }
    return value;
  }
}

test('clipboard hook should resolve action context only at the provider boundary', () => {
  const source = normalizeWhitespace(loadModuleSource('../../src/userscript/clipboardHook.js', import.meta.url));

  assert.match(source, /import \{ createActionContextProvider \} from '\.\.\/shared\/actionContextCompat\.js'/);
  assert.match(source, /const resolveActionContextProvider = typeof provideActionContext === 'function' \? provideActionContext : createActionContextProvider\(\{ getActionContext \}\)/);
  assert.match(source, /const actionContext = resolveActionContextProvider\(\)/);
  assert.match(source, /processedBlob = await resolveProcessedClipboardBlob\(\{ actionContext,/);
  assert.match(source, /processClipboardImageBlobFallback\(items,\s*\{/);
  assert.doesNotMatch(source, /getIntentMetadata/);
});

test('installGeminiClipboardImageHook should replace copied Gemini image data with processed blob when actionContext has a processed object url', async () => {
  const writtenItems = [];
  const originalBlob = new Blob(['original'], { type: 'image/jpeg' });
  const processedBlob = new Blob(['processed'], { type: 'image/png' });
  const clipboard = {
    async write(items) {
      writtenItems.push(items);
    }
  };
  const targetWindow = {
    navigator: { clipboard },
    ClipboardItem: MockClipboardItem
  };

  const dispose = installGeminiClipboardImageHook(targetWindow, {
    getActionContext: () => ({
      imageElement: {
        dataset: {
          gwrWatermarkObjectUrl: 'blob:https://gemini.google.com/processed'
        }
      }
    }),
    fetchBlobDirect: async (url) => {
      assert.equal(url, 'blob:https://gemini.google.com/processed');
      return processedBlob;
    }
  });

  await clipboard.write([
    new MockClipboardItem({
      'image/jpeg': originalBlob,
      'text/plain': Promise.resolve(new Blob(['caption'], { type: 'text/plain' }))
    })
  ]);

  assert.equal(writtenItems.length, 1);
  assert.equal(writtenItems[0].length, 1);
  assert.deepEqual(writtenItems[0][0].types, ['text/plain', 'image/png']);
  assert.equal(await writtenItems[0][0].getType('image/png'), processedBlob);
  assert.equal(
    await (await writtenItems[0][0].getType('text/plain')).text(),
    'caption'
  );

  dispose();
});

test('installGeminiClipboardImageHook should fall back to the original clipboard items when no processed Gemini image is available', async () => {
  const writtenItems = [];
  const originalItem = new MockClipboardItem({
    'image/jpeg': new Blob(['original'], { type: 'image/jpeg' })
  });
  const clipboard = {
    async write(items) {
      writtenItems.push(items);
    }
  };
  const targetWindow = {
    navigator: { clipboard },
    ClipboardItem: MockClipboardItem
  };

  const dispose = installGeminiClipboardImageHook(targetWindow, {
    getActionContext: () => ({
      imageElement: {
        dataset: {}
      }
    }),
    fetchBlobDirect: async () => {
      throw new Error('should not fetch without a processed object url');
    }
  });

  await clipboard.write([originalItem]);

  assert.equal(writtenItems.length, 1);
  assert.equal(writtenItems[0][0], originalItem);

  dispose();
});

test('installGeminiClipboardImageHook should reject Gemini copy actions when only preview-or-original resources are available', async () => {
  const writtenItems = [];
  const originalItem = new MockClipboardItem({
    'image/jpeg': new Blob(['original'], { type: 'image/jpeg' })
  });
  const imageSessionStore = createImageSessionStore({
    now: () => 123456
  });
  const sessionKey = imageSessionStore.getOrCreateByAssetIds({
    responseId: 'r_clipboard_missing_full',
    draftId: 'rc_clipboard_missing_full',
    conversationId: 'c_clipboard_missing_full'
  });
  imageSessionStore.updateOriginalSource(sessionKey, 'https://lh3.googleusercontent.com/rd-gg/clipboard-missing-full=s0-rp');
  imageSessionStore.updateProcessedResult(sessionKey, {
    slot: 'preview',
    objectUrl: 'blob:https://gemini.google.com/clipboard-preview-only',
    blobType: 'image/png',
    processedFrom: 'preview-candidate'
  });

  const clipboard = {
    async write(items) {
      writtenItems.push(items);
    }
  };
  const targetWindow = {
    navigator: { clipboard },
    ClipboardItem: MockClipboardItem
  };

  const dispose = installGeminiClipboardImageHook(targetWindow, {
    imageSessionStore,
    getActionContext: () => ({
      action: 'clipboard',
      sessionKey,
      assetIds: {
        draftId: 'rc_clipboard_missing_full'
      }
    }),
    fetchBlobDirect: async () => {
      throw new Error('Gemini clipboard actions should not fetch preview-or-original fallback data');
    },
    logger: { warn() {} }
  });

  await assert.rejects(
    clipboard.write([originalItem]),
    /Original image is unavailable for clipboard processing/
  );
  assert.equal(writtenItems.length, 0);

  dispose();
});

test('installGeminiClipboardImageHook should notify action-critical failures before rejecting Gemini copy actions', async () => {
  const originalItem = new MockClipboardItem({
    'image/jpeg': new Blob(['original'], { type: 'image/jpeg' })
  });
  const imageSessionStore = createImageSessionStore({
    now: () => 123456
  });
  const sessionKey = imageSessionStore.getOrCreateByAssetIds({
    responseId: 'r_clipboard_notice',
    draftId: 'rc_clipboard_notice',
    conversationId: 'c_clipboard_notice'
  });
  imageSessionStore.updateOriginalSource(sessionKey, 'https://lh3.googleusercontent.com/rd-gg/clipboard-notice=s0-rp');

  const clipboard = {
    async write() {
      throw new Error('clipboard write should not be called when Gemini copy processing fails');
    }
  };
  const targetWindow = {
    navigator: { clipboard },
    ClipboardItem: MockClipboardItem
  };

  let seenPayload = null;
  const dispose = installGeminiClipboardImageHook(targetWindow, {
    imageSessionStore,
    getActionContext: () => ({
      action: 'clipboard',
      sessionKey,
      assetIds: {
        draftId: 'rc_clipboard_notice'
      }
    }),
    onActionCriticalFailure: async (payload) => {
      seenPayload = {
        message: payload.error?.message || '',
        sessionKey: payload.actionContext?.sessionKey
      };
    },
    logger: { warn() {} }
  });

  await assert.rejects(
    clipboard.write([originalItem]),
    /Original image is unavailable for clipboard processing/
  );
  assert.deepEqual(seenPayload, {
    message: 'Original image is unavailable for clipboard processing',
    sessionKey
  });

  dispose();
});

test('installGeminiClipboardImageHook should resolve blob object urls through image decoding instead of fetch', async () => {
  const writtenItems = [];
  const processedBlob = new Blob(['processed-from-image'], { type: 'image/png' });
  const clipboard = {
    async write(items) {
      writtenItems.push(items);
    }
  };
  const targetWindow = {
    navigator: { clipboard },
    ClipboardItem: MockClipboardItem
  };

  const dispose = installGeminiClipboardImageHook(targetWindow, {
    getActionContext: () => ({
      imageElement: {
        dataset: {
          gwrWatermarkObjectUrl: 'blob:https://gemini.google.com/processed'
        }
      }
    }),
    fetchBlobDirect: async () => {
      throw new Error('blob object urls should not be fetched through Fetch API');
    },
    resolveBlobViaImageElement: async ({ objectUrl, imageElement }) => {
      assert.equal(objectUrl, 'blob:https://gemini.google.com/processed');
      assert.equal(
        imageElement?.dataset?.gwrWatermarkObjectUrl,
        'blob:https://gemini.google.com/processed'
      );
      return processedBlob;
    }
  });

  await clipboard.write([
    new MockClipboardItem({
      'image/jpeg': new Blob(['original'], { type: 'image/jpeg' })
    })
  ]);

  assert.equal(writtenItems.length, 1);
  assert.deepEqual(writtenItems[0][0].types, ['image/png']);
  assert.equal(await writtenItems[0][0].getType('image/png'), processedBlob);

  dispose();
});

test('installGeminiClipboardImageHook should resolve the processed blob from the shared image session when fullscreen intent points at the same Gemini asset', async () => {
  const writtenItems = [];
  const processedBlob = new Blob(['processed-from-session'], { type: 'image/png' });
  const imageSessionStore = createImageSessionStore({
    now: () => 123456
  });
  const sessionKey = imageSessionStore.getOrCreateByAssetIds({
    responseId: 'r_clipboard_session',
    draftId: 'rc_clipboard_session',
    conversationId: 'c_clipboard_session'
  });
  imageSessionStore.updateProcessedResult(sessionKey, {
    slot: 'full',
    objectUrl: 'blob:https://gemini.google.com/session-processed',
    blobType: 'image/png',
    processedFrom: 'page-fetch'
  });

  const clipboard = {
    async write(items) {
      writtenItems.push(items);
    }
  };
  const imageElement = {
    dataset: {
      gwrResponseId: 'r_clipboard_session',
      gwrDraftId: 'rc_clipboard_session',
      gwrConversationId: 'c_clipboard_session'
    }
  };
  const targetWindow = {
    navigator: { clipboard },
    ClipboardItem: MockClipboardItem
  };

  const dispose = installGeminiClipboardImageHook(targetWindow, {
    imageSessionStore,
    getActionContext: () => ({
      assetIds: {
        draftId: 'rc_clipboard_session'
      }
    }),
    resolveImageElement: () => imageElement,
    fetchBlobDirect: async () => {
      throw new Error('session blob urls should be resolved through image decoding when an image element is available');
    },
    resolveBlobViaImageElement: async ({ objectUrl, imageElement: resolvedImageElement }) => {
      assert.equal(objectUrl, 'blob:https://gemini.google.com/session-processed');
      assert.equal(resolvedImageElement, imageElement);
      return processedBlob;
    }
  });

  await clipboard.write([
    new MockClipboardItem({
      'image/jpeg': new Blob(['original'], { type: 'image/jpeg' })
    })
  ]);

  assert.equal(writtenItems.length, 1);
  assert.deepEqual(writtenItems[0][0].types, ['image/png']);
  assert.equal(await writtenItems[0][0].getType('image/png'), processedBlob);

  dispose();
});

test('installGeminiClipboardImageHook should reuse the processed fullscreen image blob when Gemini fullscreen copy has no original binding yet', async () => {
  const writtenItems = [];
  const processedBlob = new Blob(['processed-from-fullscreen-preview'], { type: 'image/png' });
  const imageSessionStore = createImageSessionStore({
    now: () => 123456
  });
  const sessionKey = imageSessionStore.getOrCreateByAssetIds({
    responseId: 'r_clipboard_fullscreen_preview',
    draftId: 'rc_clipboard_fullscreen_preview',
    conversationId: 'c_clipboard_fullscreen_preview'
  });
  imageSessionStore.updateProcessedResult(sessionKey, {
    slot: 'preview',
    objectUrl: 'blob:https://gemini.google.com/fullscreen-preview-processed',
    blobType: 'image/png',
    processedFrom: 'request-preview'
  });

  const clipboard = {
    async write(items) {
      writtenItems.push(items);
    }
  };
  const imageElement = {
    dataset: {
      gwrResponseId: 'r_clipboard_fullscreen_preview',
      gwrDraftId: 'rc_clipboard_fullscreen_preview',
      gwrConversationId: 'c_clipboard_fullscreen_preview',
      gwrWatermarkObjectUrl: 'blob:https://gemini.google.com/fullscreen-preview-processed'
    }
  };
  const targetWindow = {
    navigator: { clipboard },
    ClipboardItem: MockClipboardItem
  };

  const dispose = installGeminiClipboardImageHook(targetWindow, {
    imageSessionStore,
    getActionContext: () => ({
      action: 'clipboard',
      sessionKey,
      assetIds: {
        draftId: 'rc_clipboard_fullscreen_preview'
      }
    }),
    resolveImageElement: () => imageElement,
    fetchBlobDirect: async () => {
      throw new Error('fullscreen processed blob urls should be resolved through image decoding');
    },
    resolveBlobViaImageElement: async ({ objectUrl, imageElement: resolvedImageElement }) => {
      assert.equal(objectUrl, 'blob:https://gemini.google.com/fullscreen-preview-processed');
      assert.equal(resolvedImageElement, imageElement);
      return processedBlob;
    },
    logger: { warn() {} }
  });

  await clipboard.write([
    new MockClipboardItem({
      'image/jpeg': new Blob(['original'], { type: 'image/jpeg' })
    })
  ]);

  assert.equal(writtenItems.length, 1);
  assert.deepEqual(writtenItems[0][0].types, ['image/png']);
  assert.equal(await writtenItems[0][0].getType('image/png'), processedBlob);

  dispose();
});

test('installGeminiClipboardImageHook should process the clipboard image payload when fullscreen processed blob urls are stale', async () => {
  const writtenItems = [];
  const originalClipboardBlob = new Blob(['clipboard-original'], { type: 'image/png' });
  const processedClipboardBlob = new Blob(['clipboard-processed'], { type: 'image/png' });
  const imageSessionStore = createImageSessionStore({
    now: () => 123456
  });
  const sessionKey = imageSessionStore.getOrCreateByAssetIds({
    responseId: 'r_clipboard_stale_blob',
    draftId: 'rc_clipboard_stale_blob',
    conversationId: 'c_clipboard_stale_blob'
  });
  imageSessionStore.updateProcessedResult(sessionKey, {
    slot: 'preview',
    objectUrl: 'blob:https://gemini.google.com/stale-fullscreen-preview',
    blobType: 'image/png',
    processedFrom: 'request-preview'
  });

  const clipboard = {
    async write(items) {
      writtenItems.push(items);
    }
  };
  const imageElement = {
    dataset: {
      gwrResponseId: 'r_clipboard_stale_blob',
      gwrDraftId: 'rc_clipboard_stale_blob',
      gwrConversationId: 'c_clipboard_stale_blob',
      gwrWatermarkObjectUrl: 'blob:https://gemini.google.com/stale-fullscreen-preview'
    }
  };
  const targetWindow = {
    navigator: { clipboard },
    ClipboardItem: MockClipboardItem
  };

  let seenActionContext = null;
  const dispose = installGeminiClipboardImageHook(targetWindow, {
    imageSessionStore,
    getActionContext: () => ({
      action: 'clipboard',
      sessionKey,
      assetIds: {
        draftId: 'rc_clipboard_stale_blob'
      }
    }),
    resolveImageElement: () => imageElement,
    fetchBlobDirect: async () => {
      throw new Error('stale blob urls should not be fetched through Fetch API');
    },
    resolveBlobViaImageElement: async () => {
      throw new Error('Failed to load processed object URL');
    },
    processClipboardImageBlob: async (blob, { actionContext }) => {
      seenActionContext = actionContext;
      assert.equal(await blob.text(), 'clipboard-original');
      return {
        processedBlob: processedClipboardBlob
      };
    },
    logger: { warn() {} }
  });

  await clipboard.write([
    new MockClipboardItem({
      'image/png': originalClipboardBlob
    })
  ]);

  assert.equal(writtenItems.length, 1);
  assert.deepEqual(writtenItems[0][0].types, ['image/png']);
  assert.equal(await writtenItems[0][0].getType('image/png'), processedClipboardBlob);
  assert.deepEqual(seenActionContext, {
    action: 'clipboard',
    sessionKey,
    assetIds: {
      draftId: 'rc_clipboard_stale_blob'
    }
  });

  dispose();
});

test('installGeminiClipboardImageHook should notify when fallback processing produces a full clipboard blob', async () => {
  const writtenItems = [];
  const originalClipboardBlob = new Blob(['clipboard-original-cache'], { type: 'image/png' });
  const processedClipboardBlob = new Blob(['clipboard-processed-cache'], { type: 'image/png' });
  const actionContext = {
    action: 'clipboard',
    sessionKey: 'draft:rc_clipboard_cache',
    assetIds: {
      responseId: 'r_clipboard_cache',
      draftId: 'rc_clipboard_cache',
      conversationId: 'c_clipboard_cache'
    }
  };
  const clipboard = {
    async write(items) {
      writtenItems.push(items);
    }
  };
  const targetWindow = {
    navigator: { clipboard },
    ClipboardItem: MockClipboardItem
  };
  const notifications = [];

  const dispose = installGeminiClipboardImageHook(targetWindow, {
    getActionContext: () => actionContext,
    resolveImageElement: () => null,
    fetchBlobDirect: async () => {
      throw new Error('clipboard fallback should process the provided clipboard payload');
    },
    processClipboardImageBlob: async (blob) => {
      assert.equal(await blob.text(), 'clipboard-original-cache');
      return {
        processedBlob: processedClipboardBlob
      };
    },
    onProcessedBlobResolved: async (payload) => {
      notifications.push(payload);
    },
    logger: { warn() {} }
  });

  await clipboard.write([
    new MockClipboardItem({
      'image/png': originalClipboardBlob
    })
  ]);

  assert.equal(writtenItems.length, 1);
  assert.equal(await writtenItems[0][0].getType('image/png'), processedClipboardBlob);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].processedBlob, processedClipboardBlob);
  assert.equal(notifications[0].actionContext, actionContext);

  dispose();
});

test('installGeminiClipboardImageHook should reuse an existing full processed session blob without decoding object urls', async () => {
  const writtenItems = [];
  const processedBlob = new Blob(['processed-from-session-blob'], { type: 'image/png' });
  const imageSessionStore = createImageSessionStore({
    now: () => 123456
  });
  const sessionKey = imageSessionStore.getOrCreateByAssetIds({
    responseId: 'r_clipboard_blob',
    draftId: 'rc_clipboard_blob',
    conversationId: 'c_clipboard_blob'
  });
  imageSessionStore.updateProcessedResult(sessionKey, {
    slot: 'full',
    objectUrl: 'blob:https://gemini.google.com/session-full-blob',
    blob: processedBlob,
    blobType: 'image/png',
    processedFrom: 'original-download'
  });

  const clipboard = {
    async write(items) {
      writtenItems.push(items);
    }
  };
  const targetWindow = {
    navigator: { clipboard },
    ClipboardItem: MockClipboardItem
  };

  const dispose = installGeminiClipboardImageHook(targetWindow, {
    imageSessionStore,
    getActionContext: () => ({
      action: 'clipboard',
      sessionKey: 'draft:rc_clipboard_blob',
      assetIds: {
        draftId: 'rc_clipboard_blob'
      }
    }),
    fetchBlobDirect: async () => {
      throw new Error('clipboard should reuse the session blob before falling back to fetch');
    },
    resolveBlobViaImageElement: async () => {
      throw new Error('clipboard should reuse the session blob before decoding object urls');
    }
  });

  await clipboard.write([
    new MockClipboardItem({
      'image/jpeg': new Blob(['original'], { type: 'image/jpeg' })
    })
  ]);

  assert.equal(writtenItems.length, 1);
  assert.deepEqual(writtenItems[0][0].types, ['image/png']);
  assert.equal(await writtenItems[0][0].getType('image/png'), processedBlob);

  dispose();
});

test('installGeminiClipboardImageHook should use getActionContext when provided', async () => {
  const writtenItems = [];
  const processedBlob = new Blob(['processed-from-action-context'], { type: 'image/png' });
  const imageSessionStore = createImageSessionStore({
    now: () => 123456
  });
  const sessionKey = imageSessionStore.getOrCreateByAssetIds({
    responseId: 'r_clipboard_action_context',
    draftId: 'rc_clipboard_action_context',
    conversationId: 'c_clipboard_action_context'
  });
  imageSessionStore.updateProcessedResult(sessionKey, {
    slot: 'full',
    objectUrl: 'blob:https://gemini.google.com/session-full-action-context',
    blob: processedBlob,
    blobType: 'image/png',
    processedFrom: 'original-download'
  });

  const clipboard = {
    async write(items) {
      writtenItems.push(items);
    }
  };
  const targetWindow = {
    navigator: { clipboard },
    ClipboardItem: MockClipboardItem
  };

  const dispose = installGeminiClipboardImageHook(targetWindow, {
    imageSessionStore,
    getActionContext: () => ({
      action: 'clipboard',
      sessionKey: 'draft:rc_clipboard_action_context',
      assetIds: {
        draftId: 'rc_clipboard_action_context'
      }
    }),
    fetchBlobDirect: async () => {
      throw new Error('clipboard should reuse the action context session blob before falling back to fetch');
    },
    resolveBlobViaImageElement: async () => {
      throw new Error('clipboard should reuse the action context session blob before decoding object urls');
    }
  });

  await clipboard.write([
    new MockClipboardItem({
      'image/jpeg': new Blob(['original'], { type: 'image/jpeg' })
    })
  ]);

  assert.equal(writtenItems.length, 1);
  assert.deepEqual(writtenItems[0][0].types, ['image/png']);
  assert.equal(await writtenItems[0][0].getType('image/png'), processedBlob);

  dispose();
});

test('installGeminiClipboardImageHook should prefer provideActionContext over getActionContext', async () => {
  const writtenItems = [];
  const processedBlob = new Blob(['processed-from-provided-action-context'], { type: 'image/png' });
  const imageSessionStore = createImageSessionStore({
    now: () => 123456
  });
  const sessionKey = imageSessionStore.getOrCreateByAssetIds({
    responseId: 'r_clipboard_provided_action_context',
    draftId: 'rc_clipboard_provided_action_context',
    conversationId: 'c_clipboard_provided_action_context'
  });
  imageSessionStore.updateProcessedResult(sessionKey, {
    slot: 'full',
    objectUrl: 'blob:https://gemini.google.com/session-full-provided-action-context',
    blob: processedBlob,
    blobType: 'image/png',
    processedFrom: 'original-download'
  });

  const clipboard = {
    async write(items) {
      writtenItems.push(items);
    }
  };
  const targetWindow = {
    navigator: { clipboard },
    ClipboardItem: MockClipboardItem
  };

  const dispose = installGeminiClipboardImageHook(targetWindow, {
    imageSessionStore,
    provideActionContext: () => ({
      action: 'clipboard',
      sessionKey: 'draft:rc_clipboard_provided_action_context',
      assetIds: {
        draftId: 'rc_clipboard_provided_action_context'
      }
    }),
    getActionContext: () => ({
      action: 'clipboard',
      sessionKey: 'draft:rc_wrong_clipboard_action_context',
      assetIds: {
        draftId: 'rc_wrong_clipboard_action_context'
      }
    }),
    fetchBlobDirect: async () => {
      throw new Error('clipboard should reuse the provided action context session blob before falling back to fetch');
    },
    resolveBlobViaImageElement: async () => {
      throw new Error('clipboard should reuse the provided action context session blob before decoding object urls');
    }
  });

  await clipboard.write([
    new MockClipboardItem({
      'image/jpeg': new Blob(['original'], { type: 'image/jpeg' })
    })
  ]);

  assert.equal(writtenItems.length, 1);
  assert.deepEqual(writtenItems[0][0].types, ['image/png']);
  assert.equal(await writtenItems[0][0].getType('image/png'), processedBlob);

  dispose();
});

test('installGeminiClipboardImageHook should process Gemini page image clipboard items when actionContext is missing', async () => {
  const writtenItems = [];
  const originalBlob = new Blob(['clipboard-watermarked'], { type: 'image/png' });
  const processedBlob = new Blob(['clipboard-processed-without-context'], { type: 'image/png' });
  const originalItem = new MockClipboardItem({
    'image/png': originalBlob
  });
  const clipboard = {
    async write(items) {
      writtenItems.push(items);
    }
  };
  const targetWindow = {
    location: {
      hostname: 'gemini.google.com'
    },
    navigator: { clipboard },
    ClipboardItem: MockClipboardItem
  };

  let processedInputText = '';
  const dispose = installGeminiClipboardImageHook(targetWindow, {
    getActionContext: () => null,
    processClipboardImageBlob: async (blob, { actionContext }) => {
      processedInputText = await blob.text();
      assert.equal(actionContext, null);
      return {
        processedBlob
      };
    },
    fetchBlobDirect: async () => {
      throw new Error('missing actionContext should not fetch session resources');
    },
    resolveBlobViaImageElement: async () => {
      throw new Error('missing actionContext should not decode session resources');
    },
    logger: { warn() {} }
  });

  await clipboard.write([originalItem]);

  assert.equal(processedInputText, 'clipboard-watermarked');
  assert.equal(writtenItems.length, 1);
  assert.deepEqual(writtenItems[0][0].types, ['image/png']);
  assert.equal(await writtenItems[0][0].getType('image/png'), processedBlob);

  dispose();
});

test('installGeminiClipboardImageHook should not process non-Gemini image clipboard items without actionContext', async () => {
  const writtenItems = [];
  const originalItem = new MockClipboardItem({
    'image/png': new Blob(['non-gemini-image'], { type: 'image/png' })
  });
  const clipboard = {
    async write(items) {
      writtenItems.push(items);
    }
  };
  const targetWindow = {
    location: {
      hostname: 'example.com'
    },
    navigator: { clipboard },
    ClipboardItem: MockClipboardItem
  };

  const dispose = installGeminiClipboardImageHook(targetWindow, {
    getActionContext: () => null,
    processClipboardImageBlob: async () => {
      throw new Error('non-Gemini pages should not process clipboard images without actionContext');
    },
    fetchBlobDirect: async () => {
      throw new Error('non-Gemini pages should not fetch session resources');
    },
    resolveBlobViaImageElement: async () => {
      throw new Error('non-Gemini pages should not decode session resources');
    },
    logger: { warn() {} }
  });

  await clipboard.write([originalItem]);

  assert.equal(writtenItems.length, 1);
  assert.equal(writtenItems[0][0], originalItem);

  dispose();
});

test('installGeminiClipboardImageHook should fall back to original Gemini clipboard items when page fallback processing fails', async () => {
  const writtenItems = [];
  const originalItem = new MockClipboardItem({
    'image/png': new Blob(['gemini-unprocessed-on-fallback-error'], { type: 'image/png' })
  });
  const clipboard = {
    async write(items) {
      writtenItems.push(items);
    }
  };
  const targetWindow = {
    location: {
      hostname: 'business.gemini.google'
    },
    navigator: { clipboard },
    ClipboardItem: MockClipboardItem
  };

  const dispose = installGeminiClipboardImageHook(targetWindow, {
    getActionContext: () => null,
    processClipboardImageBlob: async () => {
      throw new Error('fallback processing failed');
    },
    logger: { warn() {} }
  });

  await clipboard.write([originalItem]);

  assert.equal(writtenItems.length, 1);
  assert.equal(writtenItems[0][0], originalItem);

  dispose();
});
