export const USERSCRIPT_PROCESS_REQUEST = 'gwr:userscript-process-request';
export const USERSCRIPT_PROCESS_RESPONSE = 'gwr:userscript-process-response';

const USERSCRIPT_PROCESS_BRIDGE_FLAG = '__gwrUserscriptProcessBridgeInstalled__';

function normalizeErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error || 'Userscript bridge failed');
}

function buildBlobResult(processedBlob, processedMeta = null) {
  return {
    processedBlob,
    processedMeta
  };
}

async function blobResultToPayload(result) {
  const normalizedResult = result instanceof Blob
    ? buildBlobResult(result, null)
    : buildBlobResult(result?.processedBlob, result?.processedMeta ?? null);
  const processedBlob = normalizedResult.processedBlob;
  if (!(processedBlob instanceof Blob)) {
    throw new Error('Bridge processor must return a Blob');
  }

  const processedBuffer = await processedBlob.arrayBuffer();
  return {
    processedBuffer,
    mimeType: processedBlob.type || 'image/png',
    meta: normalizedResult.processedMeta ?? null
  };
}

export function createUserscriptProcessBridgeServer({
  targetWindow = globalThis.window || null,
  processWatermarkBlob,
  removeWatermarkFromBlob,
  logger = console
} = {}) {
  return async function handleUserscriptProcessBridge(event) {
    if (!event?.data || event.data.type !== USERSCRIPT_PROCESS_REQUEST) {
      return;
    }
    if (targetWindow && event.source && event.source !== targetWindow) {
      return;
    }
    if (!targetWindow || typeof targetWindow.postMessage !== 'function') {
      return;
    }

    const requestId = typeof event.data.requestId === 'string' ? event.data.requestId : '';
    const action = typeof event.data.action === 'string' ? event.data.action : '';
    if (!requestId || !action) {
      return;
    }

    try {
      const inputBlob = new Blob([event.data.inputBuffer], {
        type: event.data.mimeType || 'image/png'
      });
      let result;
      if (action === 'process-watermark-blob') {
        if (typeof processWatermarkBlob !== 'function') {
          throw new Error('processWatermarkBlob bridge handler unavailable');
        }
        result = await processWatermarkBlob(inputBlob, event.data.options || {});
      } else if (action === 'remove-watermark-blob') {
        if (typeof removeWatermarkFromBlob !== 'function') {
          throw new Error('removeWatermarkFromBlob bridge handler unavailable');
        }
        result = await removeWatermarkFromBlob(inputBlob, event.data.options || {});
      } else {
        throw new Error(`Unknown bridge action: ${action}`);
      }

      const payload = await blobResultToPayload(result);
      targetWindow.postMessage({
        type: USERSCRIPT_PROCESS_RESPONSE,
        requestId,
        ok: true,
        action,
        result: payload
      }, '*', [payload.processedBuffer]);
    } catch (error) {
      logger?.warn?.('[Gemini Watermark Remover] Userscript bridge request failed:', error);
      targetWindow.postMessage({
        type: USERSCRIPT_PROCESS_RESPONSE,
        requestId,
        ok: false,
        action,
        error: normalizeErrorMessage(error)
      }, '*');
    }
  };
}

export function installUserscriptProcessBridge(options = {}) {
  const {
    targetWindow = globalThis.window || null
  } = options;

  if (!targetWindow || typeof targetWindow.addEventListener !== 'function') {
    return null;
  }
  if (targetWindow[USERSCRIPT_PROCESS_BRIDGE_FLAG]) {
    return targetWindow[USERSCRIPT_PROCESS_BRIDGE_FLAG];
  }

  const handler = createUserscriptProcessBridgeServer({
    ...options,
    targetWindow
  });

  const listener = (event) => {
    void handler(event);
  };
  targetWindow.addEventListener('message', listener);
  targetWindow[USERSCRIPT_PROCESS_BRIDGE_FLAG] = {
    handler,
    dispose() {
      targetWindow.removeEventListener?.('message', listener);
      delete targetWindow[USERSCRIPT_PROCESS_BRIDGE_FLAG];
    }
  };
  return targetWindow[USERSCRIPT_PROCESS_BRIDGE_FLAG];
}

function createRequestId() {
  return `gwr-us-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createBlobResultFromResponse(result = {}) {
  return {
    processedBlob: new Blob([result.processedBuffer], {
      type: result.mimeType || 'image/png'
    }),
    processedMeta: result.meta ?? null
  };
}

export function createUserscriptProcessBridgeClient({
  targetWindow = globalThis.window || null,
  timeoutMs = 120000,
  fallbackProcessWatermarkBlob,
  fallbackRemoveWatermarkFromBlob,
  logger = console
} = {}) {
  async function request(action, blob, options, fallback) {
    if (!(blob instanceof Blob)) {
      throw new TypeError('blob must be a Blob');
    }

    if (
      !targetWindow
      || typeof targetWindow.addEventListener !== 'function'
      || typeof targetWindow.removeEventListener !== 'function'
      || typeof targetWindow.postMessage !== 'function'
    ) {
      return fallback(blob, options);
    }

    const inputBuffer = await blob.arrayBuffer();
    const requestId = createRequestId();

    try {
      return await new Promise((resolve, reject) => {
        const cleanup = () => {
          targetWindow.removeEventListener('message', handleMessage);
          globalThis.clearTimeout(timeoutId);
        };

        const handleMessage = (event) => {
          if (targetWindow && event.source && event.source !== targetWindow) {
            return;
          }
          if (!event?.data || event.data.type !== USERSCRIPT_PROCESS_RESPONSE) {
            return;
          }
          if (event.data.requestId !== requestId) {
            return;
          }

          cleanup();
          if (event.data.ok === false) {
            reject(new Error(normalizeErrorMessage(event.data.error)));
            return;
          }
          resolve(createBlobResultFromResponse(event.data.result));
        };

        const timeoutId = globalThis.setTimeout(() => {
          cleanup();
          reject(new Error(`Userscript bridge timed out: ${action}`));
        }, timeoutMs);

        targetWindow.addEventListener('message', handleMessage);
        targetWindow.postMessage({
          type: USERSCRIPT_PROCESS_REQUEST,
          requestId,
          action,
          inputBuffer,
          mimeType: blob.type || 'image/png',
          options: options || {}
        }, '*', [inputBuffer]);
      });
    } catch (error) {
      logger?.warn?.('[Gemini Watermark Remover] Userscript bridge fallback:', error);
      return fallback(blob, options);
    }
  }

  return {
    async processWatermarkBlob(blob, options = {}) {
      if (typeof fallbackProcessWatermarkBlob !== 'function') {
        throw new Error('fallbackProcessWatermarkBlob must be a function');
      }
      return request('process-watermark-blob', blob, options, fallbackProcessWatermarkBlob);
    },
    async removeWatermarkFromBlob(blob, options = {}) {
      if (typeof fallbackRemoveWatermarkFromBlob !== 'function') {
        throw new Error('fallbackRemoveWatermarkFromBlob must be a function');
      }
      const result = await request('remove-watermark-blob', blob, options, async (inputBlob, inputOptions) => {
        const processedBlob = await fallbackRemoveWatermarkFromBlob(inputBlob, inputOptions);
        return buildBlobResult(processedBlob, null);
      });
      return result.processedBlob;
    }
  };
}
