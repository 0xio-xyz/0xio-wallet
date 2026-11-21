import i18n from './core';
import en from './locales/en.json';
import id from './locales/id.json';
import zh from './locales/zh.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'zh', label: '简体中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
] as const;

i18n.init({ resources: { en, id, zh, ja, ko }, lng: 'en', fallbackLng: 'en' });

export async function loadSavedLanguage(): Promise<void> {
  try {
    const result = await chrome.storage.local.get('app_language');
    if (result.app_language && result.app_language !== i18n.language) {
      await i18n.changeLanguage(result.app_language);
    }
  } catch {}
}

export async function setLanguage(lang: string): Promise<void> {
  await i18n.changeLanguage(lang);
  await chrome.storage.local.set({ app_language: lang });
}

export default i18n;
