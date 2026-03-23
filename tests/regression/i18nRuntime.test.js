import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const i18nModuleUrl = pathToFileURL(path.join(repoRoot, 'src', 'i18n.js')).href;

const originalNavigator = globalThis.navigator;
const originalLocalStorage = globalThis.localStorage;
const originalDocument = globalThis.document;
const originalFetch = globalThis.fetch;

function createStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      store[key] = String(value);
    },
    removeItem(key) {
      delete store[key];
    },
    clear() {
      for (const key of Object.keys(store)) delete store[key];
    },
  };
}

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

function setupRuntime({
  savedLocale = null,
  navigatorLanguage = 'en-US',
  navigatorLanguages = [navigatorLanguage],
  fetchImpl,
}) {
  const removedClasses = [];
  const localStorage = createStorage(savedLocale ? { locale: savedLocale } : {});
  const document = {
    body: {
      classList: {
        remove(className) {
          removedClasses.push(className);
        },
      },
    },
    documentElement: { lang: '' },
    title: '',
    querySelectorAll() {
      return [];
    },
  };

  setGlobal('localStorage', localStorage);
  setGlobal('navigator', { language: navigatorLanguage, languages: navigatorLanguages });
  setGlobal('document', document);
  setGlobal('fetch', fetchImpl);

  return { removedClasses, localStorage, document };
}

async function importFreshI18n() {
  const mod = await import(`${i18nModuleUrl}?test=${Date.now()}-${Math.random()}`);
  return mod.default;
}

function restoreGlobals() {
  setGlobal('navigator', originalNavigator);
  setGlobal('localStorage', originalLocalStorage);
  setGlobal('document', originalDocument);
  setGlobal('fetch', originalFetch);
}

test.afterEach(() => {
  restoreGlobals();
});

test('should infer pt-BR locale from navigator language', async () => {
  setupRuntime({
    navigatorLanguage: 'pt-PT',
    navigatorLanguages: ['pt-PT', 'en-US'],
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { title: 'Teste' };
      },
    }),
  });

  const i18n = await importFreshI18n();
  assert.equal(i18n.locale, 'pt-BR');
});

test('loadTranslations should fetch stable locale url without timestamp busting', async () => {
  const urls = [];
  setupRuntime({
    fetchImpl: async (url) => {
      urls.push(String(url));
      return {
        ok: true,
        async json() {
          return { title: 'OK' };
        },
      };
    },
  });

  const i18n = await importFreshI18n();
  await i18n.loadTranslations('zh-CN');
  assert.equal(urls.length, 1);
  assert.equal(urls[0], './i18n/zh-CN.json');
});

test('init should fallback to en-US and always clear loading class when locale load fails', async () => {
  const requested = [];
  const { removedClasses } = setupRuntime({
    savedLocale: 'fr-FR',
    navigatorLanguage: 'fr-FR',
    navigatorLanguages: ['fr-FR'],
    fetchImpl: async (url) => {
      requested.push(String(url));
      if (String(url).includes('/en-US.json') || String(url).endsWith('en-US.json')) {
        return {
          ok: true,
          async json() {
            return { title: 'English Title' };
          },
        };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    },
  });

  const i18n = await importFreshI18n();
  await i18n.init();

  assert.equal(i18n.locale, 'en-US');
  assert.equal(i18n.t('title'), 'English Title');
  assert.deepEqual(requested, ['./i18n/en-US.json']);
  assert.deepEqual(removedClasses, ['loading']);
});

test('should provide locale rotation for all supported locales', async () => {
  setupRuntime({
    savedLocale: 'zh-CN',
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { title: 'ok' };
      },
    }),
  });

  const i18n = await importFreshI18n();
  assert.equal(typeof i18n.getNextLocale, 'function');
  assert.equal(i18n.getNextLocale('zh-CN'), 'en-US');
  assert.equal(i18n.getNextLocale('en-US'), 'pt-BR');
  assert.equal(i18n.getNextLocale('pt-BR'), 'zh-CN');
  assert.equal(i18n.getLocaleShort('pt-BR'), 'PT');
});
