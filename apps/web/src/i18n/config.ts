import { DEFAULT_LOCALE, isLocale, type Locale } from '@minnegela/shared';

/** The language preference lives in a cookie so server and client render the same words; URLs never change. */
export const LOCALE_COOKIE = 'NEXT_LOCALE';
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const INTL_TAG: Record<Locale, string> = { nb: 'nb-NO', en: 'en-GB' };

/** The locale the browser is currently rendering with, read from the cookie (client only; the default elsewhere). */
export function currentLocale(): Locale {
  if (typeof document === 'undefined') return DEFAULT_LOCALE;
  const m = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`));
  const v = m?.[1] ? decodeURIComponent(m[1]) : null;
  return isLocale(v) ? v : DEFAULT_LOCALE;
}
