import i18n from '@/i18n';
import { ApiError } from './client';

/** What to show a person for a failed call: the translated API code, else the server's English detail, else a generic line. */
export function apiErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const key = e.code ? `errors.${e.code}` : null;
    if (key && i18n.exists(key)) return i18n.t(key);
    return e.detail ?? e.message ?? i18n.t('errors.generic');
  }
  if (e instanceof Error && e.message) return e.message;
  return i18n.t('errors.generic');
}
