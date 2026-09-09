/** Languages the product speaks. Norwegian Bokmål is the default everywhere; English is the fallback for anything untranslated. */
export const LOCALES = ['nb', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'nb';

export const isLocale = (x: unknown): x is Locale => typeof x === 'string' && (LOCALES as readonly string[]).includes(x);

/** Best supported locale for an Accept-Language header or any BCP 47 tag list; the default when nothing matches. */
export function pickLocale(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  const ranked = header.split(',').map((part, i) => {
    const [tag = '', ...params] = part.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return { tag: tag.trim().toLowerCase(), q: q ? Number(q.slice(2)) : 1, i };
  }).filter((r) => r.tag && r.q > 0).sort((a, b) => b.q - a.q || a.i - b.i);
  for (const r of ranked) {
    const base = r.tag.split('-')[0]!;
    if (base === 'nb' || base === 'nn' || base === 'no') return 'nb';
    if (base === 'en') return 'en';
  }
  return DEFAULT_LOCALE;
}

/** A string in every locale it has been produced for (generated content such as event titles). */
export type Localized = Partial<Record<Locale, string>>;

/** The string for `locale`, falling back to the default locale and then to anything present. */
export function localized(map: Localized | null | undefined, locale: Locale): string | null {
  if (!map) return null;
  return map[locale] ?? map[DEFAULT_LOCALE] ?? LOCALES.map((l) => map[l]).find((s): s is string => !!s) ?? null;
}
