const FALLBACK_LOCALE = 'en-US';
const LOCALE_SHORT = Object.freeze({
  'zh-CN': '中文',
  'en-US': 'EN',
  'pt-BR': 'PT',
});
const SUPPORTED_LOCALES = Object.freeze(Object.keys(LOCALE_SHORT));

function toCanonicalLocale(locale) {
  if (!locale || typeof locale !== 'string') return null;
  if (SUPPORTED_LOCALES.includes(locale)) return locale;

  const normalized = locale.toLowerCase();
  if (normalized.startsWith('zh')) return 'zh-CN';
  if (normalized.startsWith('en')) return 'en-US';
  if (normalized.startsWith('pt')) return 'pt-BR';
  return null;
}

function safeGetStoredLocale() {
  try {
    return localStorage.getItem('locale');
  } catch {
    return null;
  }
}

function resolveInitialLocale() {
  const stored = toCanonicalLocale(safeGetStoredLocale());
  if (stored) return stored;

  const languages = [];
  if (typeof navigator !== 'undefined') {
    if (Array.isArray(navigator.languages)) languages.push(...navigator.languages);
    if (navigator.language) languages.push(navigator.language);
  }

  for (const lang of languages) {
    const match = toCanonicalLocale(lang);
    if (match) return match;
  }

  return FALLBACK_LOCALE;
}

const i18n = {
  locale: resolveInitialLocale(),
  translations: {},
  supportedLocales: SUPPORTED_LOCALES,

  resolveLocale(locale) {
    return toCanonicalLocale(locale) || FALLBACK_LOCALE;
  },

  persistLocale(locale) {
    try {
      localStorage.setItem('locale', locale);
    } catch {
      // ignore storage errors in non-browser contexts
    }
  },

  getNextLocale(current = this.locale) {
    const currentLocale = this.resolveLocale(current);
    const index = this.supportedLocales.indexOf(currentLocale);
    const nextIndex = (index + 1) % this.supportedLocales.length;
    return this.supportedLocales[nextIndex];
  },

  getLocaleShort(locale) {
    const normalized = this.resolveLocale(locale);
    return LOCALE_SHORT[normalized] || normalized;
  },

  async init() {
    try {
      await this.loadTranslations(this.locale);
    } catch (error) {
      console.error('i18n init failed for locale:', this.locale, error);
      if (this.locale !== FALLBACK_LOCALE) {
        try {
          await this.loadTranslations(FALLBACK_LOCALE);
        } catch (fallbackError) {
          console.error('i18n fallback failed:', fallbackError);
          this.locale = FALLBACK_LOCALE;
          this.translations = {};
          this.persistLocale(this.locale);
        }
      }
    } finally {
      this.applyTranslations();
      if (document?.body?.classList) {
        document.body.classList.remove('loading');
      }
    }
  },

  async loadTranslations(locale) {
    const resolvedLocale = this.resolveLocale(locale);
    const res = await fetch(`./i18n/${resolvedLocale}.json`);
    if (!res.ok) {
      throw new Error(`failed to load locale ${resolvedLocale}: ${res.status}`);
    }

    this.translations = await res.json();
    this.locale = resolvedLocale;
    this.persistLocale(resolvedLocale);
    return this.translations;
  },

  t(key) {
    let text = this.translations[key] || key;
    if (typeof text === 'string') {
      text = text.replace('{{year}}', new Date().getFullYear());
    }
    return text;
  },

  applyTranslations() {
    if (typeof document === 'undefined') return;

    if (document.documentElement) {
      document.documentElement.lang = this.locale;
    }
    document.title = this.t('title');
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (el.tagName === 'INPUT' && el.placeholder !== undefined) {
        el.placeholder = this.t(key);
      } else {
        el.textContent = this.t(key);
      }
    });
  },

  async switchLocale(locale) {
    await this.loadTranslations(locale);
    this.applyTranslations();
  },
};

export default i18n;
