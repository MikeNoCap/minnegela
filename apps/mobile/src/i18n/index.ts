import 'intl-pluralrules';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@minnegela/shared';
import nb from './nb.json';
import en from './en.json';

// Norwegian by default whatever the phone speaks; the user can switch under Group.
void i18n.use(initReactI18next).init({
  resources: { nb: { translation: nb }, en: { translation: en } },
  lng: DEFAULT_LOCALE,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});

export const currentLocale = (): Locale => (isLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE);
export const setLocale = (l: Locale) => i18n.changeLanguage(l);

/** BCP 47 tag for Intl formatting in the active language. */
export const intlTag = () => (currentLocale() === 'nb' ? 'nb-NO' : 'en-GB');
export const fmtDate = (d: Date | string | number) => new Date(d).toLocaleDateString(intlTag());
export const fmtDateTime = (d: Date | string | number) => new Date(d).toLocaleString(intlTag());

export default i18n;
