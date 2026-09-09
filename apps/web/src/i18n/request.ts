import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { DEFAULT_LOCALE, isLocale } from '@minnegela/shared';
import { LOCALE_COOKIE } from './config';

export default getRequestConfig(async () => {
  const v = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(v) ? v : DEFAULT_LOCALE;
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
    timeZone: 'Europe/Oslo',
  };
});
