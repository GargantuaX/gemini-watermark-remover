import {
  GWR_EXTENSION_GM_XHR_REQUEST,
  GWR_EXTENSION_GM_XHR_RESPONSE,
  GWR_EXTENSION_STATE_REQUEST,
  GWR_EXTENSION_STATE_RESPONSE
} from './messageTypes.js';

const EXTENSION_ENABLED_STORAGE_KEY = 'gwrEnabled';
const EXTENSION_PREVIEW_ENABLED_STORAGE_KEY = 'gwrPreviewEnabled';

function readExtensionState(callback) {
  chrome.storage.local.get({
    [EXTENSION_ENABLED_STORAGE_KEY]: true,
    [EXTENSION_PREVIEW_ENABLED_STORAGE_KEY]: true
  }, (items) => {
    callback({
      enabled: items?.[EXTENSION_ENABLED_STORAGE_KEY] !== false,
      previewEnabled: items?.[EXTENSION_PREVIEW_ENABLED_STORAGE_KEY] !== false
    });
  });
}

try {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[EXTENSION_PREVIEW_ENABLED_STORAGE_KEY]) {
      const previewEnabled = changes[EXTENSION_PREVIEW_ENABLED_STORAGE_KEY].newValue !== false;
      window.postMessage({
        type: 'GWR_EXTENSION_PREVIEW_STATE_CHANGE',
        previewEnabled
      }, '*');
    }
  });
} catch {}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data || {};
  if (data.type === GWR_EXTENSION_STATE_REQUEST && data.requestId) {
    readExtensionState(({ enabled, previewEnabled }) => {
      window.postMessage({
        type: GWR_EXTENSION_STATE_RESPONSE,
        requestId: data.requestId,
        enabled,
        previewEnabled
      }, '*');
    });
    return;
  }

  if (data.type !== GWR_EXTENSION_GM_XHR_REQUEST || !data.requestId) {
    return;
  }

  chrome.runtime.sendMessage({
    type: GWR_EXTENSION_GM_XHR_REQUEST,
    requestId: data.requestId,
    request: data.request || {}
  }, (response) => {
    window.postMessage({
      type: GWR_EXTENSION_GM_XHR_RESPONSE,
      requestId: data.requestId,
      response: response || {
        ok: false,
        status: 0,
        statusText: '',
        headers: {},
        bytes: [],
        error: chrome.runtime.lastError?.message || 'No extension response'
      }
    }, '*');
  });
});
