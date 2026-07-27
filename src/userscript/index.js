import {
  appendCompatibleActionContext,
  resolveCompatibleActionContextFromPayload
} from '../shared/actionContextCompat.js';
import {
  bindProcessedPreviewResultToImages,
  bindOriginalAssetUrlToImages,
  installPageImageReplacement
} from '../shared/pageImageReplacement.js';
import { getDefaultImageSessionStore } from '../shared/imageSessionStore.js';
import { installGeminiClipboardImageHook } from './clipboardHook.js';
import { createGeminiActionContextResolver, findGeminiImageElementForSourceUrl } from './actionContext.js';
import {
  createGeminiDownloadFetchHook,
  createGeminiDownloadIntentGate,
  createGeminiDownloadRpcFetchHook,
  extractGeminiAssetBindingsFromResponseText,
  installGeminiDownloadRpcXmlHttpRequestHook,
  installGeminiDownloadHook,
  resolveGeminiActionKind
} from './downloadHook.js';
import { createUserscriptBlobFetcher } from './crossOriginFetch.js';
import {
  createPageProcessBridgeClient
} from './pageProcessBridge.js';
import {
  requestGeminiConversationHistoryBindings
} from './historyBindingBootstrap.js';
import {
  installUserscriptProcessBridge
} from './processBridge.js';
import { installInjectedPageProcessorRuntime } from './pageProcessorRuntime.js';
import { createUserscriptProcessingRuntime } from './processingRuntime.js';
import {
  GWR_ORIGINAL_ASSET_REFRESH_MESSAGE,
  showUserNotice
} from './userNotice.js';
import {
  isGeminiDisplayPreviewAssetUrl,
  isGeminiOriginalAssetUrl,
  normalizeGoogleusercontentImageUrl
} from './urlUtils.js';

const USERSCRIPT_WORKER_CODE = typeof __US_WORKER_CODE__ === 'string' ? __US_WORKER_CODE__ : '';
const USERSCRIPT_PAGE_PROCESSOR_CODE =
  typeof __US_PAGE_PROCESSOR_CODE__ === 'string' ? __US_PAGE_PROCESSOR_CODE__ : '';

function shouldSkipFrame(targetWindow) {
  if (!targetWindow) {
    return false;
  }
  try {
    return targetWindow.top && targetWindow.top !== targetWindow.self;
  } catch {
    return false;
  }
}

function isPreviewReplacementEnabled(targetWindow) {
  try {
    if (targetWindow?.__GWR_PREVIEW_ENABLED__ === false) {
      return false;
    }
    return targetWindow?.localStorage?.getItem('__gwr_enable_preview_replacement__') !== '0';
  } catch {
    return true;
  }
}

export async function initGeminiWatermarkRemoverUserscript() {
  try {
    const targetWindow = typeof unsafeWindow === 'object' && unsafeWindow
      ? unsafeWindow
      : window;
    if (shouldSkipFrame(targetWindow)) {
      return;
    }

    console.log('[Gemini Watermark Remover] Initializing...');
    const originalPageFetch = typeof unsafeWindow?.fetch === 'function'
      ? unsafeWindow.fetch.bind(unsafeWindow)
      : null;
    const userscriptRequest = typeof GM_xmlhttpRequest === 'function'
      ? GM_xmlhttpRequest
      : globalThis.GM_xmlhttpRequest;
    const previewBlobFetcher = createUserscriptBlobFetcher({
      gmRequest: userscriptRequest,
      fallbackFetch: originalPageFetch
    });

    const processingRuntime = createUserscriptProcessingRuntime({
      workerCode: USERSCRIPT_WORKER_CODE,
      env: globalThis,
      logger: console
    });
    const imageSessionStore = getDefaultImageSessionStore();
    const actionContextResolver = createGeminiActionContextResolver({
      targetWindow,
      imageSessionStore
    });
    let pageProcessClient = null;
    const processPreviewBlobAtBestPath = async (blob, options = {}) => {
      const result = pageProcessClient?.processWatermarkBlob
        ? await pageProcessClient.processWatermarkBlob(blob, options)
        : await processingRuntime.processWatermarkBlob(blob, options);
      return result.processedBlob;
    };
    const processClipboardImageBlobAtBestPath = (blob, options = {}) => (
      pageProcessClient?.processWatermarkBlob
        ? pageProcessClient.processWatermarkBlob(blob, options)
        : processingRuntime.processWatermarkBlob(blob, options)
    );
    const removeWatermarkFromBestAvailablePath = (blob, options = {}) => (
      pageProcessClient?.removeWatermarkFromBlob
        ? pageProcessClient.removeWatermarkFromBlob(blob, options)
        : processingRuntime.removeWatermarkFromBlob(blob, options)
    );

    const handleOriginalAssetDiscovered = (payload = {}) => {
      const sourceUrl = payload.normalizedUrl || payload.discoveredUrl || '';
      const resolvedActionContext = resolveCompatibleActionContextFromPayload(payload);
      const assetIds = resolvedActionContext?.assetIds;
      if (!assetIds || !sourceUrl) return;
      bindOriginalAssetUrlToImages({
        root: targetWindow.document || document,
        assetIds,
        sourceUrl,
        imageSessionStore
      });
    };
    const handleRpcAssetDiscovered = (payload) => {
      handleOriginalAssetDiscovered({
        ...payload,
        normalizedUrl: payload?.discoveredUrl || ''
      });
    };
    const handleActionCriticalFailure = () => {
      showUserNotice(targetWindow, GWR_ORIGINAL_ASSET_REFRESH_MESSAGE);
    };
    const storeProcessedBlobResolved = (payload = {}, {
      slot = 'full',
      processedFrom = 'processed'
    } = {}) => {
      const resolvedActionContext = resolveCompatibleActionContextFromPayload(payload);
      const processedBlob = payload?.processedBlob instanceof Blob
        ? payload.processedBlob
        : null;
      const sessionKey = (
        typeof resolvedActionContext?.sessionKey === 'string'
          ? resolvedActionContext.sessionKey.trim()
          : ''
      ) || imageSessionStore.getOrCreateByAssetIds(resolvedActionContext?.assetIds);
      const urlApi = targetWindow?.URL || globalThis.URL;
      if (!processedBlob || !sessionKey || typeof urlApi?.createObjectURL !== 'function') {
        return;
      }

      const previousObjectUrl = imageSessionStore.getSnapshot(sessionKey)?.derived?.processedSlots?.[slot]?.objectUrl || '';
      const nextObjectUrl = urlApi.createObjectURL(processedBlob);
      if (
        previousObjectUrl
        && previousObjectUrl !== nextObjectUrl
        && typeof urlApi?.revokeObjectURL === 'function'
      ) {
        urlApi.revokeObjectURL(previousObjectUrl);
      }

      imageSessionStore.updateProcessedResult(sessionKey, {
        slot,
        objectUrl: nextObjectUrl,
        blob: processedBlob,
        blobType: processedBlob.type || 'image/png',
        processedFrom
      });
    };
    const handlePreviewBlobResolved = (payload = {}) => {
      if (!isPreviewReplacementEnabled(targetWindow)) return;
      const resolvedActionContext = resolveCompatibleActionContextFromPayload(payload);
      const sessionKey = (
        typeof resolvedActionContext?.sessionKey === 'string'
          ? resolvedActionContext.sessionKey.trim()
          : ''
      ) || imageSessionStore.getOrCreateByAssetIds(resolvedActionContext?.assetIds);
      if (sessionKey && typeof payload?.normalizedUrl === 'string' && payload.normalizedUrl.trim()) {
        imageSessionStore.updateSourceSnapshot?.(sessionKey, {
          sourceUrl: payload.normalizedUrl.trim(),
          isPreviewSource: true
        });
      }
      storeProcessedBlobResolved(payload, {
        slot: 'preview',
        processedFrom: 'request-preview'
      });
      bindProcessedPreviewResultToImages({
        root: targetWindow.document || document,
        sourceUrl: payload?.normalizedUrl || '',
        processedBlob: payload?.processedBlob || null,
        processedMeta: null,
        processedFrom: 'request-preview',
        sessionKey,
        assetIds: resolvedActionContext?.assetIds || null,
        imageSessionStore
      });
    };
    const resolvePreviewRequestActionContext = ({ url = '', normalizedUrl = '' } = {}) => {
      const targetUrl = normalizedUrl || url;
      const imageElement = findGeminiImageElementForSourceUrl(targetWindow.document || document, targetUrl);
      return actionContextResolver.resolveActionContext(imageElement, {
        action: 'display'
      });
    };
    const handleProcessedBlobResolved = (payload = {}) => {
      const resolvedActionContext = resolveCompatibleActionContextFromPayload(payload);
      const isClipboardResult = resolvedActionContext?.action === 'clipboard';
      storeProcessedBlobResolved(payload, {
        slot: isClipboardResult ? 'preview' : 'full',
        processedFrom: isClipboardResult ? 'original-clipboard' : 'original-download'
      });
    };
    const handleClipboardFallbackBlobResolved = (payload = {}) => {
      storeProcessedBlobResolved(payload, {
        slot: 'preview',
        processedFrom: 'clipboard-fallback'
      });
    };
    const downloadIntentGate = createGeminiDownloadIntentGate({
      targetWindow,
      resolveActionContext: (target) => {
        const intentAction = resolveGeminiActionKind(target) || 'clipboard';
        const sessionContext = actionContextResolver.resolveActionContext(target, {
          action: intentAction
        });
        return {
          action: intentAction,
          target,
          assetIds: sessionContext.assetIds,
          sessionKey: sessionContext.sessionKey,
          resource: sessionContext.resource,
          imageElement: sessionContext.imageElement || actionContextResolver.resolveImageElement({
            target,
            assetIds: sessionContext.assetIds
          })
        };
      }
    });
    const downloadRpcFetch = createGeminiDownloadRpcFetchHook({
      originalFetch: targetWindow.fetch.bind(targetWindow),
      getActionContext: () => downloadIntentGate.getRecentActionContext(),
      onOriginalAssetDiscovered: handleRpcAssetDiscovered,
      logger: console
    });
    const previewFetch = createGeminiDownloadFetchHook({
      originalFetch: downloadRpcFetch,
      isTargetUrl: isGeminiDisplayPreviewAssetUrl,
      normalizeUrl: normalizeGoogleusercontentImageUrl,
      getActionContext: resolvePreviewRequestActionContext,
      processBlob: processPreviewBlobAtBestPath,
      shouldProcessRequest: ({ url = '' } = {}) => isPreviewReplacementEnabled(targetWindow) && isGeminiDisplayPreviewAssetUrl(url),
      failOpenOnProcessingError: true,
      onProcessedBlobResolved: handlePreviewBlobResolved,
      logger: console
    });
    installGeminiDownloadRpcXmlHttpRequestHook(targetWindow, {
      getActionContext: () => downloadIntentGate.getRecentActionContext(),
      onOriginalAssetDiscovered: handleRpcAssetDiscovered,
      logger: console
    });
    installGeminiDownloadHook(targetWindow, {
      originalFetch: previewFetch,
      intentGate: downloadIntentGate,
      isTargetUrl: isGeminiOriginalAssetUrl,
      normalizeUrl: normalizeGoogleusercontentImageUrl,
      processBlob: removeWatermarkFromBestAvailablePath,
      onOriginalAssetDiscovered: handleOriginalAssetDiscovered,
      onProcessedBlobResolved: handleProcessedBlobResolved,
      onActionCriticalFailure: handleActionCriticalFailure,
      logger: console
    });
    const disposeClipboardHook = installGeminiClipboardImageHook(targetWindow, {
      getActionContext: () => downloadIntentGate.getRecentActionContext(),
      imageSessionStore: imageSessionStore,
      onProcessedBlobResolved: handleClipboardFallbackBlobResolved,
      onActionCriticalFailure: handleActionCriticalFailure,
      processClipboardImageBlob: (blob, { actionContext } = {}) => (
        processClipboardImageBlobAtBestPath(blob, { actionContext })
      ),
      resolveImageElement: (actionContext) => actionContextResolver.resolveImageElement(actionContext),
      logger: console
    });
    await requestGeminiConversationHistoryBindings({
      targetWindow,
      fetchImpl: targetWindow.fetch.bind(targetWindow),
      onResponseText: async (responseText, { request }) => {
        for (const binding of extractGeminiAssetBindingsFromResponseText(responseText)) {
          handleRpcAssetDiscovered(appendCompatibleActionContext({
            rpcUrl: request?.url || '',
            discoveredUrl: binding.discoveredUrl
          }, {
            assetIds: binding.assetIds
          }));
        }
      },
      logger: console
    });
    await processingRuntime.initialize();
    const injectedRuntime = await installInjectedPageProcessorRuntime({
      targetWindow,
      scriptCode: USERSCRIPT_PAGE_PROCESSOR_CODE,
      logger: console
    });

    if (injectedRuntime) {
      pageProcessClient = createPageProcessBridgeClient({
        targetWindow,
        logger: console,
        fallbackProcessWatermarkBlob: processingRuntime.processWatermarkBlob,
        fallbackRemoveWatermarkFromBlob: processingRuntime.removeWatermarkFromBlob
      });

      installUserscriptProcessBridge({
        targetWindow,
        processWatermarkBlob: processingRuntime.processWatermarkBlob,
        removeWatermarkFromBlob: processingRuntime.removeWatermarkFromBlob,
        logger: console
      });
    }

    const pageImageReplacementController = isPreviewReplacementEnabled(targetWindow)
      ? installPageImageReplacement({
        imageSessionStore: imageSessionStore,
        logger: console,
        fetchPreviewBlob: previewBlobFetcher,
        processWatermarkBlobImpl: pageProcessClient.processWatermarkBlob,
        removeWatermarkFromBlobImpl: pageProcessClient.removeWatermarkFromBlob
      })
      : null;

    window.addEventListener('beforeunload', () => {
      pageImageReplacementController?.dispose?.();
      disposeClipboardHook();
      downloadIntentGate.dispose();
      processingRuntime.dispose('beforeunload');
    });

    console.log('[Gemini Watermark Remover] Ready');
  } catch (error) {
    console.error('[Gemini Watermark Remover] Initialization failed:', error);
  }
}

if (typeof __GWR_AUTO_INIT_USERSCRIPT__ === 'undefined' || __GWR_AUTO_INIT_USERSCRIPT__) {
  void initGeminiWatermarkRemoverUserscript();
}
