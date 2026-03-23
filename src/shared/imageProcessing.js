import { canvasToBlob } from '../core/canvasBlob.js';
import { removeWatermarkFromImage } from '../sdk/browser.js';

function loadImageFromObjectUrl(objectUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to decode Gemini image blob'));
    image.src = objectUrl;
  });
}

async function loadRenderableFromBlobFallback(blob, originalError) {
  if (typeof createImageBitmap !== 'function') {
    throw originalError;
  }

  try {
    return await createImageBitmap(blob);
  } catch {
    throw originalError;
  }
}

export async function loadImageFromBlob(blob) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    try {
      return await loadImageFromObjectUrl(objectUrl);
    } catch (error) {
      return await loadRenderableFromBlobFallback(blob, error);
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function withProcessorPath(meta, processorPath) {
  return {
    ...(meta && typeof meta === 'object' ? meta : {}),
    processorPath
  };
}

export async function processWatermarkBlobOnMainThread(blob, options = { adaptiveMode: 'always' }) {
  const image = await loadImageFromBlob(blob);
  const result = await removeWatermarkFromImage(image, options);
  return {
    processedBlob: await canvasToBlob(result.canvas),
    processedMeta: withProcessorPath(result.meta || null, 'main-thread')
  };
}

export function createSharedBlobProcessor({
  processMainThread = processWatermarkBlobOnMainThread
} = {}) {
  return async function processWithBestPath(blob, options = { adaptiveMode: 'always' }) {
    const result = await processMainThread(blob, options);
    return {
      processedBlob: result.processedBlob,
      processedMeta: withProcessorPath(result.processedMeta || null, 'main-thread')
    };
  };
}

const processWatermarkBlobWithBestPath = createSharedBlobProcessor();

export async function processWatermarkBlob(blob, options = { adaptiveMode: 'always' }) {
  return processWatermarkBlobWithBestPath(blob, options);
}

export async function removeWatermarkFromBlob(blob, options = { adaptiveMode: 'always' }) {
  const result = await processWatermarkBlob(blob, options);
  return result.processedBlob;
}
