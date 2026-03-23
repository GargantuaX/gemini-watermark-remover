import { installPageImageReplacement } from '../shared/pageImageReplacement.js';
import { installGeminiDownloadHook } from './downloadHook.js';
import { createUserscriptBlobFetcher } from './crossOriginFetch.js';
import {
  createUserscriptProcessBridgeClient,
  installUserscriptProcessBridge
} from './processBridge.js';
import { createUserscriptProcessingRuntime } from './processingRuntime.js';
import { isGeminiGeneratedAssetUrl, normalizeGoogleusercontentImageUrl } from './urlUtils.js';

const USERSCRIPT_WORKER_CODE = typeof __US_WORKER_CODE__ === 'string' ? __US_WORKER_CODE__ : '';

(async function init() {
  try {
    console.log('[Gemini Watermark Remover] Initializing...');

    const targetWindow = typeof unsafeWindow === 'object' && unsafeWindow
      ? unsafeWindow
      : window;
    const originalPageFetch = typeof unsafeWindow?.fetch === 'function'
      ? unsafeWindow.fetch.bind(unsafeWindow)
      : null;
    const userscriptRequest = typeof GM_xmlhttpRequest === 'function'
      ? GM_xmlhttpRequest
      : globalThis.GM_xmlhttpRequest;

    const processingRuntime = createUserscriptProcessingRuntime({
      workerCode: USERSCRIPT_WORKER_CODE,
      env: globalThis,
      logger: console
    });
    await processingRuntime.initialize();

    installUserscriptProcessBridge({
      targetWindow,
      processWatermarkBlob: processingRuntime.processWatermarkBlob,
      removeWatermarkFromBlob: processingRuntime.removeWatermarkFromBlob,
      logger: console
    });

    const bridgeClient = createUserscriptProcessBridgeClient({
      targetWindow,
      fallbackProcessWatermarkBlob: processingRuntime.processWatermarkBlob,
      fallbackRemoveWatermarkFromBlob: processingRuntime.removeWatermarkFromBlob,
      logger: console
    });

    installGeminiDownloadHook(targetWindow, {
      isTargetUrl: isGeminiGeneratedAssetUrl,
      normalizeUrl: normalizeGoogleusercontentImageUrl,
      processBlob: bridgeClient.removeWatermarkFromBlob,
      logger: console
    });

    installPageImageReplacement({
      logger: console,
      fetchPreviewBlob: createUserscriptBlobFetcher({
        gmRequest: userscriptRequest,
        fallbackFetch: originalPageFetch
      }),
      processWatermarkBlobImpl: bridgeClient.processWatermarkBlob,
      removeWatermarkFromBlobImpl: bridgeClient.removeWatermarkFromBlob
    });

    window.addEventListener('beforeunload', () => {
      processingRuntime.dispose('beforeunload');
    });

    console.log('[Gemini Watermark Remover] Ready');
  } catch (error) {
    console.error('[Gemini Watermark Remover] Initialization failed:', error);
  }
})();
