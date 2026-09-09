'use client';
import { useTranslations } from 'next-intl';
import { ApiError } from './api';

/**
 * Words for a failed request: the translation of the API's error code when we have one, else the API's own
 * English detail (a code this build does not know yet), else a generic line.
 */
export function useApiErrorMessage(): (e: unknown) => string {
  const t = useTranslations('errors');
  return (e) => {
    if (e instanceof ApiError) {
      if (e.code && t.has(e.code)) return t(e.code);
      return e.problem.detail || e.problem.title || t('generic');
    }
    return t('generic');
  };
}

/** Same idea for better-auth client errors ({ code?, message? }). */
export function useAuthErrorMessage(): (err: { code?: string; message?: string } | null | undefined) => string {
  const t = useTranslations('errors.auth');
  return (err) => (err?.code && t.has(err.code) ? t(err.code) : t('generic'));
}
