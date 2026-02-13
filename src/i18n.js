const i18n = {
  locale: 'en-US',
  translations: {},

  async init() {
    await this.loadTranslations(this.locale);
    this.applyTranslations();
    document.body.classList.remove('loading');
  },

  async loadTranslations(locale) {
    const res = await fetch(`./i18n/${locale}.json?_=${Date.now()}`);
    this.translations = await res.json();
    this.locale = locale;
  },

  t(key) {
    let text = this.translations[key] || key;
    if (typeof text === 'string') {
      text = text.replace('{{year}}', new Date().getFullYear());
    }
    return text;
  },

  applyTranslations() {
    document.documentElement.lang = this.locale;
    document.title = this.t('title');
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (el.tagName === 'INPUT' && el.placeholder !== undefined) {
        el.placeholder = this.t(key);
      } else {
        el.textContent = this.t(key);
      }
    });
  }
};

export default i18n;
