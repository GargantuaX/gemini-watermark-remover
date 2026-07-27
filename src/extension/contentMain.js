import { installTampermonkeyCompat } from './tampermonkeyCompat.js';
import {
  GWR_EXTENSION_STATE_REQUEST,
  GWR_EXTENSION_STATE_RESPONSE
} from './messageTypes.js';
import { initGeminiWatermarkRemoverUserscript } from '../userscript/index.js';

let nextStateRequestId = 1;

function getLocalStoragePreviewState(targetWindow = window) {
  try {
    return targetWindow.localStorage?.getItem('__gwr_enable_preview_replacement__') !== '0';
  } catch {
    return true;
  }
}

function resolveExtensionState({
  targetWindow = window,
  timeoutMs = 2000
} = {}) {
  if (!targetWindow || typeof targetWindow.postMessage !== 'function') {
    return Promise.resolve({
      enabled: true,
      previewEnabled: getLocalStoragePreviewState(targetWindow)
    });
  }

  const requestId = `gwr-extension-state-${Date.now()}-${nextStateRequestId++}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (data = {}) => {
      if (settled) return;
      settled = true;
      targetWindow.removeEventListener('message', handleMessage);
      targetWindow.clearTimeout?.(timeoutId);
      resolve({
        enabled: data.enabled !== false,
        previewEnabled: typeof data.previewEnabled === 'boolean'
          ? data.previewEnabled
          : getLocalStoragePreviewState(targetWindow)
      });
    };
    const handleMessage = (event) => {
      if (event.source !== targetWindow) return;
      const data = event.data || {};
      if (data.type !== GWR_EXTENSION_STATE_RESPONSE || data.requestId !== requestId) {
        return;
      }
      finish(data);
    };
    const timeoutId = targetWindow.setTimeout?.(() => {
      finish({
        enabled: true,
        previewEnabled: getLocalStoragePreviewState(targetWindow)
      });
    }, timeoutMs);

    targetWindow.addEventListener('message', handleMessage);
    targetWindow.postMessage({
      type: GWR_EXTENSION_STATE_REQUEST,
      requestId
    }, '*');
  });
}

async function initExtensionUserscript() {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'GWR_EXTENSION_PREVIEW_STATE_CHANGE') {
      const previewEnabled = event.data.previewEnabled !== false;
      window.__GWR_PREVIEW_ENABLED__ = previewEnabled;
      try {
        window.localStorage?.setItem('__gwr_enable_preview_replacement__', previewEnabled ? '1' : '0');
      } catch {}
    }
  });

  const { enabled, previewEnabled } = await resolveExtensionState();
  if (!enabled) {
    console.info('[Gemini Watermark Remover] Extension disabled');
    return;
  }

  try {
    window.__GWR_PREVIEW_ENABLED__ = previewEnabled;
    window.localStorage?.setItem('__gwr_enable_preview_replacement__', previewEnabled ? '1' : '0');
  } catch {
    // Ignore storage quota or cross-origin errors
  }

  installTampermonkeyCompat({
    targetWindow: window
  });

  await initGeminiWatermarkRemoverUserscript();
}

void initExtensionUserscript();
