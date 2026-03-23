import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createUserscriptProcessBridgeClient,
  createUserscriptProcessBridgeServer,
  installUserscriptProcessBridge,
  USERSCRIPT_PROCESS_REQUEST,
  USERSCRIPT_PROCESS_RESPONSE
} from '../../src/userscript/processBridge.js';

function createMockWindow() {
  const listeners = new Set();
  const windowLike = {
    addEventListener(type, listener) {
      if (type !== 'message') return;
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type !== 'message') return;
      listeners.delete(listener);
    },
    postMessage(message) {
      const event = {
        data: message,
        source: windowLike
      };
      for (const listener of [...listeners]) {
        listener(event);
      }
    }
  };
  return windowLike;
}

const mockWindow = createMockWindow();

test('createUserscriptProcessBridgeServer should process watermark requests and reply with meta', async () => {
  installUserscriptProcessBridge({
    targetWindow: mockWindow,
    logger: { warn() {} },
    processWatermarkBlob: async (blob) => ({
      processedBlob: new Blob([await blob.text() + '-processed'], { type: 'image/png' }),
      processedMeta: {
        applied: true,
        source: 'bridge-test'
      }
    }),
    removeWatermarkFromBlob: async () => {
      throw new Error('should not call remove path');
    }
  });

  const client = createUserscriptProcessBridgeClient({
    targetWindow: mockWindow,
    logger: { warn() {} },
    fallbackProcessWatermarkBlob: async () => {
      throw new Error('should not fallback');
    },
    fallbackRemoveWatermarkFromBlob: async () => {
      throw new Error('should not fallback');
    }
  });

  const result = await client.processWatermarkBlob(new Blob(['raw'], { type: 'image/png' }));
  assert.equal(await result.processedBlob.text(), 'raw-processed');
  assert.equal(result.processedBlob.type, 'image/png');
  assert.deepEqual(result.processedMeta, {
    applied: true,
    source: 'bridge-test'
  });
});

test('createUserscriptProcessBridgeClient should fall back locally when bridge times out', async () => {
  const isolatedWindow = {
    addEventListener() {},
    removeEventListener() {},
    postMessage(message) {
      assert.equal(message.type, USERSCRIPT_PROCESS_REQUEST);
    }
  };

  const client = createUserscriptProcessBridgeClient({
    targetWindow: isolatedWindow,
    timeoutMs: 10,
    logger: { warn() {} },
    fallbackProcessWatermarkBlob: async (blob) => ({
      processedBlob: new Blob([await blob.text() + '-fallback'], { type: 'image/png' }),
      processedMeta: { source: 'fallback' }
    }),
    fallbackRemoveWatermarkFromBlob: async () => new Blob(['unused'], { type: 'image/png' })
  });

  const result = await client.processWatermarkBlob(new Blob(['raw'], { type: 'image/png' }));
  assert.equal(await result.processedBlob.text(), 'raw-fallback');
  assert.deepEqual(result.processedMeta, { source: 'fallback' });
});

test('createUserscriptProcessBridgeServer should respond to remove-watermark requests', async () => {
  const bridgeMessages = [];
  const scopedWindow = {
    addEventListener(type, listener) {
      if (type !== 'message') return;
      this.listener = listener;
    },
    removeEventListener() {},
    postMessage(message) {
      bridgeMessages.push(message);
    }
  };

  const bridge = installUserscriptProcessBridge({
    targetWindow: scopedWindow,
    logger: { warn() {} },
    processWatermarkBlob: async () => {
      throw new Error('should not call process path');
    },
    removeWatermarkFromBlob: async (blob) => new Blob([await blob.text() + '-done'], { type: 'image/png' })
  });

  const inputBuffer = await new Blob(['raw'], { type: 'image/png' }).arrayBuffer();
  await bridge.handler({
    source: scopedWindow,
    data: {
      type: USERSCRIPT_PROCESS_REQUEST,
      requestId: 'req-1',
      action: 'remove-watermark-blob',
      inputBuffer,
      mimeType: 'image/png',
      options: { adaptiveMode: 'always' }
    }
  });

  assert.equal(bridgeMessages.length, 1);
  assert.equal(bridgeMessages[0].type, USERSCRIPT_PROCESS_RESPONSE);
  assert.equal(bridgeMessages[0].requestId, 'req-1');
  const blob = new Blob([bridgeMessages[0].result.processedBuffer], {
    type: bridgeMessages[0].result.mimeType
  });
  assert.equal(await blob.text(), 'raw-done');
});
