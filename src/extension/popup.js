const EXTENSION_ENABLED_STORAGE_KEY = 'gwrEnabled';
const EXTENSION_PREVIEW_ENABLED_STORAGE_KEY = 'gwrPreviewEnabled';
const GEMINI_ORIGIN_PATTERN = /^https:\/\/(?:business\.)?gemini\.google\//i;

function getExtensionApi() {
  return globalThis.chrome || null;
}

function getManifestVersion() {
  const manifest = getExtensionApi()?.runtime?.getManifest?.();
  return typeof manifest?.version === 'string' ? manifest.version : '';
}

function getCurrentActiveTab() {
  return new Promise((resolve) => {
    const extensionApi = getExtensionApi();
    if (!extensionApi?.tabs?.query) {
      resolve(null);
      return;
    }

    extensionApi.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(Array.isArray(tabs) ? tabs[0] || null : null);
    });
  });
}

async function reloadCurrentGeminiTab() {
  const tab = await getCurrentActiveTab();
  if (!tab?.id || !GEMINI_ORIGIN_PATTERN.test(tab.url || '')) {
    return;
  }
  getExtensionApi()?.tabs?.reload?.(tab.id);
}

function readSettings(callback) {
  const storage = getExtensionApi()?.storage?.local;
  if (!storage?.get) {
    callback({ enabled: true, previewEnabled: true });
    return;
  }

  storage.get({
    [EXTENSION_ENABLED_STORAGE_KEY]: true,
    [EXTENSION_PREVIEW_ENABLED_STORAGE_KEY]: true
  }, (items) => {
    callback({
      enabled: items?.[EXTENSION_ENABLED_STORAGE_KEY] !== false,
      previewEnabled: items?.[EXTENSION_PREVIEW_ENABLED_STORAGE_KEY] !== false
    });
  });
}

function writeEnabled(enabled, callback) {
  const storage = getExtensionApi()?.storage?.local;
  if (!storage?.set) {
    callback?.();
    return;
  }

  storage.set({ [EXTENSION_ENABLED_STORAGE_KEY]: Boolean(enabled) }, callback);
}

function writePreviewEnabled(previewEnabled, callback) {
  const storage = getExtensionApi()?.storage?.local;
  if (!storage?.set) {
    callback?.();
    return;
  }

  storage.set({ [EXTENSION_PREVIEW_ENABLED_STORAGE_KEY]: Boolean(previewEnabled) }, callback);
}

document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('enable-toggle');
  const previewToggle = document.getElementById('preview-toggle');
  const versionLabel = document.getElementById('extension-version');

  if (versionLabel) {
    const version = getManifestVersion();
    versionLabel.textContent = version ? `v${version}` : '';
  }

  readSettings(({ enabled, previewEnabled }) => {
    if (toggle) {
      toggle.checked = enabled;
    }
    if (previewToggle) {
      previewToggle.checked = previewEnabled;
    }
  });

  if (toggle) {
    toggle.addEventListener('change', () => {
      writeEnabled(toggle.checked, () => {
        void reloadCurrentGeminiTab();
      });
    });
  }

  if (previewToggle) {
    previewToggle.addEventListener('change', () => {
      writePreviewEnabled(previewToggle.checked, () => {
        void reloadCurrentGeminiTab();
      });
    });
  }
});
