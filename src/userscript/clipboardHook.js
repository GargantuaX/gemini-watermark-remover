import { createActionContextProvider } from '../shared/actionContextCompat.js';
import { resolveImageSessionContext } from '../shared/imageSessionContext.js';
import { getDefaultImageSessionStore } from '../shared/imageSessionStore.js';
import { canvasToBlob } from '../core/canvasBlob.js';

function isImageMimeType(type) {
  return typeof type === 'string' && /^image\//i.test(type);
}

function isBlobUrl(url) {
  return typeof url === 'string' && /^blob:/i.test(url);
}

function hasClipboardImageItems(items) {
  return Array.from(items || []).some((item) => (
    Array.isArray(item?.types) && item.types.some(isImageMimeType)
  ));
}

async function getFirstClipboardImageBlob(items) {
  for (const item of Array.from(items || [])) {
    const types = Array.isArray(item?.types) ? item.types.filter(isImageMimeType) : [];
    for (const type of types) {
      if (typeof item?.getType !== 'function') {
        continue;
      }
      const blob = await item.getType(type);
      if (blob instanceof Blob) {
        return blob;
      }
    }
  }

  return null;
}

function isGeminiClipboardActionContext(actionContext) {
  if (!actionContext || typeof actionContext !== 'object') {
    return false;
  }

  if (actionContext.action === 'clipboard') {
    return true;
  }

  if (typeof actionContext.sessionKey === 'string' && actionContext.sessionKey.trim()) {
    return true;
  }

  const assetIds = actionContext.assetIds;
  return Boolean(
    assetIds
      && typeof assetIds === 'object'
      && (assetIds.responseId || assetIds.draftId || assetIds.conversationId)
  );
}

function isGeminiClipboardTargetPage(targetWindow) {
  const hostname = typeof targetWindow?.location?.hostname === 'string'
    ? targetWindow.location.hostname.trim().toLowerCase()
    : '';
  if (!hostname) {
    return false;
  }

  return hostname === 'gemini.google.com'
    || hostname.endsWith('.gemini.google.com')
    || hostname === 'business.gemini.google'
    || hostname.endsWith('.business.gemini.google');
}

async function notifyActionCriticalFailure(onActionCriticalFailure, payload) {
  if (typeof onActionCriticalFailure !== 'function') {
    return;
  }

  try {
    await onActionCriticalFailure(payload);
  } catch {
    // User notice failures must not mask the primary clipboard error.
  }
}

async function createBlobFromObjectUrlImage(objectUrl, imageElement, targetWindow = globalThis) {
  const ImageClass = targetWindow?.Image || globalThis.Image;
  const documentRef = imageElement?.ownerDocument || targetWindow?.document || globalThis.document;
  if (typeof ImageClass !== 'function' || !documentRef?.createElement) {
    throw new Error('Image decode fallback unavailable');
  }

  const image = new ImageClass();
  image.decoding = 'async';
  image.src = objectUrl;
  if (typeof image.decode === 'function') {
    await image.decode();
  } else {
    await new Promise((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Failed to load processed object URL'));
    });
  }

  const width = Number(image.naturalWidth) || Number(image.width) || Number(imageElement?.naturalWidth) || Number(imageElement?.width) || 0;
  const height = Number(image.naturalHeight) || Number(image.height) || Number(imageElement?.naturalHeight) || Number(imageElement?.height) || 0;
  if (width <= 0 || height <= 0) {
    throw new Error('Processed object URL image has no renderable size');
  }

  const canvas = documentRef.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext?.('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('2D canvas context unavailable');
  }
  context.drawImage(image, 0, 0, width, height);
  return canvasToBlob(canvas, 'image/png', {
    unavailableMessage: 'Canvas toBlob unavailable',
    nullBlobMessage: 'Canvas toBlob returned null'
  });
}

async function buildClipboardReplacementItems(items, replacementBlob, ClipboardItemClass) {
  const replacementItems = [];
  let replacedAny = false;

  for (const item of Array.from(items || [])) {
    const types = Array.isArray(item?.types) ? item.types.filter(Boolean) : [];
    if (!types.some(isImageMimeType) || typeof ClipboardItemClass !== 'function') {
      replacementItems.push(item);
      continue;
    }

    const replacementData = {};
    for (const type of types) {
      if (isImageMimeType(type)) {
        continue;
      }
      if (typeof item.getType === 'function') {
        replacementData[type] = item.getType(type);
      }
    }

    replacementData[replacementBlob.type || 'image/png'] = replacementBlob;
    replacementItems.push(new ClipboardItemClass(replacementData));
    replacedAny = true;
  }

  return replacedAny ? replacementItems : items;
}

async function processClipboardImageBlobFallback(items, {
  processClipboardImageBlob = null,
  actionContext = null
} = {}) {
  if (typeof processClipboardImageBlob !== 'function') {
    return null;
  }

  const sourceBlob = await getFirstClipboardImageBlob(items);
  if (!(sourceBlob instanceof Blob)) {
    return null;
  }

  const result = await processClipboardImageBlob(sourceBlob, {
    actionContext,
    items
  });
  if (result instanceof Blob) {
    return result;
  }
  return result?.processedBlob instanceof Blob ? result.processedBlob : null;
}

async function resolveProcessedClipboardBlob({
  actionContext = null,
  resolveImageElement,
  imageSessionStore = getDefaultImageSessionStore(),
  fetchBlobDirect,
  resolveBlobViaImageElement,
  requireFullProcessedResource = false
}) {
  const sessionContext = resolveImageSessionContext({
    action: 'clipboard',
    actionContext,
    resolveImageElement,
    imageSessionStore
  });
  const imageElement = sessionContext?.imageElement || actionContext?.imageElement || null;
  const sessionBlob = sessionContext?.resource?.kind === 'processed'
    && sessionContext.resource.blob instanceof Blob
    ? sessionContext.resource.blob
    : null;
  if (sessionBlob) {
    return sessionBlob;
  }

  const processedResource = sessionContext?.resource?.kind === 'processed'
    ? sessionContext.resource
    : null;
  const processedImageElementObjectUrl = typeof imageElement?.dataset?.gwrWatermarkObjectUrl === 'string'
    ? imageElement.dataset.gwrWatermarkObjectUrl.trim()
    : '';
  const canReuseProcessedImageElementFallback = Boolean(
    processedImageElementObjectUrl
      && (
        !requireFullProcessedResource
        || !sessionContext?.resource
        || sessionContext.resource.kind === 'preview'
        || sessionContext.resource.kind === 'blob'
      )
  );
  if (requireFullProcessedResource && !processedResource && !canReuseProcessedImageElementFallback) {
    return null;
  }

  const resourceUrl = processedResource
    && typeof sessionContext.resource.url === 'string'
    ? sessionContext.resource.url.trim()
    : '';
  const objectUrl = resourceUrl || (
    canReuseProcessedImageElementFallback
      ? processedImageElementObjectUrl
      : ''
  );
  if (!objectUrl) {
    return null;
  }

  if (imageElement && isBlobUrl(objectUrl) && typeof resolveBlobViaImageElement === 'function') {
    try {
      return await resolveBlobViaImageElement({
        objectUrl,
        imageElement
      });
    } catch (error) {
      if (!requireFullProcessedResource && typeof fetchBlobDirect === 'function') {
        return fetchBlobDirect(objectUrl);
      }
      throw error;
    }
  }

  if (typeof fetchBlobDirect !== 'function') {
    return null;
  }

  return fetchBlobDirect(objectUrl);
}

export function installGeminiClipboardImageHook(targetWindow, {
  provideActionContext = null,
  getActionContext = () => null,
  resolveImageElement = null,
  imageSessionStore = getDefaultImageSessionStore(),
  onActionCriticalFailure = null,
  onProcessedBlobResolved = null,
  processClipboardImageBlob = null,
  fetchBlobDirect = async (url) => {
    const response = await fetch(url);
    return response.blob();
  },
  resolveBlobViaImageElement = ({ objectUrl, imageElement }) => (
    createBlobFromObjectUrlImage(objectUrl, imageElement, targetWindow)
  ),
  logger = console
} = {}) {
  const clipboard = targetWindow?.navigator?.clipboard;
  if (!clipboard || typeof clipboard.write !== 'function') {
    return () => {};
  }

  const originalWrite = clipboard.write.bind(clipboard);
  const ClipboardItemClass = targetWindow?.ClipboardItem || globalThis.ClipboardItem;
  const resolveActionContextProvider = typeof provideActionContext === 'function'
    ? provideActionContext
    : createActionContextProvider({ getActionContext });

  const hookedWrite = async function gwrClipboardWriteHook(items) {
    const actionContext = resolveActionContextProvider();
    const containsImageItems = hasClipboardImageItems(items);
    const requiresOriginalGeminiBlob = containsImageItems
      && isGeminiClipboardActionContext(actionContext);
    const shouldTryClipboardImageProcessing = requiresOriginalGeminiBlob
      || (containsImageItems && isGeminiClipboardTargetPage(targetWindow));
    let clipboardResolutionError = null;

    try {
      if (!containsImageItems) {
        return originalWrite(items);
      }

      let processedBlob = null;
      try {
        processedBlob = await resolveProcessedClipboardBlob({
          actionContext,
          resolveImageElement,
          imageSessionStore,
          fetchBlobDirect,
          resolveBlobViaImageElement,
          requireFullProcessedResource: requiresOriginalGeminiBlob
        });
      } catch (error) {
        clipboardResolutionError = error;
      }
      if (!processedBlob && shouldTryClipboardImageProcessing) {
        processedBlob = await processClipboardImageBlobFallback(items, {
          processClipboardImageBlob,
          actionContext
        });
        if (processedBlob && typeof onProcessedBlobResolved === 'function') {
          await onProcessedBlobResolved({
            actionContext,
            processedBlob
          });
        }
      }
      if (!processedBlob) {
        if (requiresOriginalGeminiBlob) {
          throw clipboardResolutionError || new Error('Original image is unavailable for clipboard processing');
        }
        return originalWrite(items);
      }

      const replacementItems = await buildClipboardReplacementItems(
        items,
        processedBlob,
        ClipboardItemClass
      );
      return originalWrite(replacementItems);
    } catch (error) {
      logger?.warn?.('[Gemini Watermark Remover] Clipboard image hook failed, falling back:', error);
      if (requiresOriginalGeminiBlob) {
        await notifyActionCriticalFailure(onActionCriticalFailure, {
          error,
          actionContext,
          items
        });
        throw error;
      }
      return originalWrite(items);
    }
  };
  clipboard.write = hookedWrite;

  return () => {
    if (clipboard.write === hookedWrite) {
      clipboard.write = originalWrite;
    }
  };
}
