'use server';
import { cookies } from 'next/headers';
import { isLocale } from '@minnegela/shared';
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from './config';

export async function setLocale(locale: string): Promise<void> {
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, { path: '/', maxAge: LOCALE_COOKIE_MAX_AGE, sameSite: 'lax' });
}
