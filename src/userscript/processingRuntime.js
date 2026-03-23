import { WatermarkEngine } from '../core/watermarkEngine.js';
import { canvasToBlob } from '../core/canvasBlob.js';
import { toWorkerScriptUrl } from './trustedTypes.js';
import { shouldUseInlineWorker } from './runtimeFlags.js';

const DEFAULT_INLINE_WORKER_TIMEOUT_MS = 120000;
const DEFAULT_WORKER_PING_TIMEOUT_MS = 3000;

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

function toError(errorLike, fallback = 'Inline worker error') {
  if (errorLike instanceof Error) return errorLike;
  if (typeof errorLike === 'string' && errorLike.length > 0) return new Error(errorLike);
  if (errorLike && typeof errorLike.message === 'string' && errorLike.message.length > 0) {
    return new Error(errorLike.message);
  }
  return new Error(fallback);
}

class InlineWorkerClient {
  constructor(workerCode) {
    const blob = new Blob([workerCode], { type: 'text/javascript' });
    this.workerUrl = URL.createObjectURL(blob);
    const workerScriptUrl = toWorkerScriptUrl(this.workerUrl);
    if (!workerScriptUrl) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
      throw new Error('Trusted Types policy unavailable for inline worker');
    }
    try {
      this.worker = new Worker(workerScriptUrl);
    } catch (error) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
      throw error;
    }
    this.pending = new Map();
    this.requestId = 0;
    this.handleMessage = this.handleMessage.bind(this);
    this.handleError = this.handleError.bind(this);
    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleError);
  }

  dispose() {
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleError);
    this.worker.terminate();
    if (this.workerUrl) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
    }
    const error = new Error('Inline worker disposed');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }

  handleMessage(event) {
    const payload = event?.data;
    if (!payload || typeof payload.id === 'undefined') return;
    const pending = this.pending.get(payload.id);
    if (!pending) return;
    this.pending.delete(payload.id);
    clearTimeout(pending.timeoutId);
    if (payload.ok) {
      pending.resolve(payload.result);
      return;
    }
    pending.reject(new Error(payload.error?.message || 'Inline worker request failed'));
  }

  handleError(event) {
    const error = new Error(event?.message || 'Inline worker crashed');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(type, payload, transferList = [], timeoutMs = DEFAULT_INLINE_WORKER_TIMEOUT_MS) {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Inline worker request timed out: ${type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeoutId });
      try {
        this.worker.postMessage({ id, type, ...payload }, transferList);
      } catch (error) {
        clearTimeout(timeoutId);
        this.pending.delete(id);
        reject(toError(error));
      }
    });
  }

  async ping(timeoutMs = DEFAULT_WORKER_PING_TIMEOUT_MS) {
    await this.request('ping', {}, [], timeoutMs);
  }

  async processWatermarkBlob(blob, options = {}) {
    const inputBuffer = await blob.arrayBuffer();
    const result = await this.request(
      'process-image',
      { inputBuffer, mimeType: blob.type || 'image/png', options },
      [inputBuffer]
    );
    return {
      processedBlob: new Blob([result.processedBuffer], { type: result.mimeType || 'image/png' }),
      processedMeta: result.meta || null
    };
  }
}

export function createUserscriptProcessingRuntime({
  workerCode = '',
  env = globalThis,
  logger = console
} = {}) {
  let enginePromise = null;
  let workerClient = null;

  function normalizeProcessingOptions(options = {}) {
    return {
      adaptiveMode: 'always',
      ...(options && typeof options === 'object' ? options : {})
    };
  }

  async function getEngine() {
    if (!enginePromise) {
      enginePromise = WatermarkEngine.create().catch((error) => {
        enginePromise = null;
        throw error;
      });
    }
    return enginePromise;
  }

  function disableInlineWorker(reason) {
    if (!workerClient) return;
    logger?.warn?.('[Gemini Watermark Remover] Disable worker path:', reason);
    workerClient.dispose();
    workerClient = null;
  }

  async function processBlobOnMainThread(blob, options = {}) {
    const engine = await getEngine();
    const blobUrl = URL.createObjectURL(blob);
    try {
      const img = await loadImage(blobUrl);
      const canvas = await engine.removeWatermarkFromImage(img, options);
      return {
        processedBlob: await canvasToBlob(canvas),
        processedMeta: canvas.__watermarkMeta || null
      };
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  async function processBlobWithBestPath(blob, options = {}) {
    const normalizedOptions = normalizeProcessingOptions(options);

    if (workerClient) {
      try {
        return await workerClient.processWatermarkBlob(blob, normalizedOptions);
      } catch (error) {
        logger?.warn?.('[Gemini Watermark Remover] Worker path failed, fallback to main thread:', error);
        disableInlineWorker(error);
      }
    }

    return processBlobOnMainThread(blob, normalizedOptions);
  }

  const runtime = {
    async initialize() {
      if (!shouldUseInlineWorker(workerCode, env)) {
        return false;
      }

      try {
        workerClient = new InlineWorkerClient(workerCode);
        await workerClient.ping();
        logger?.log?.('[Gemini Watermark Remover] Worker acceleration enabled');
        return true;
      } catch (workerError) {
        workerClient?.dispose();
        workerClient = null;
        logger?.warn?.('[Gemini Watermark Remover] Worker initialization failed, using main thread:', workerError);
        return false;
      }
    },
    dispose(reason) {
      disableInlineWorker(reason);
    },
    async processWatermarkBlob(blob, options = {}) {
      return processBlobWithBestPath(blob, options);
    },
    async removeWatermarkFromBlob(blob, options = {}) {
      return (await runtime.processWatermarkBlob(blob, options)).processedBlob;
    }
  };

  return runtime;
}
