'use client';
import { useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { Locale } from '@minnegela/shared';
import { INTL_TAG } from '@/i18n/config';

export type Fmt = ReturnType<typeof makeFormat>;

function makeFormat(locale: Locale, never: string) {
  const tag = INTL_TAG[locale];
  const dt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(tag, opts);
  const fmtDate = (iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }): string => (iso ? dt(opts).format(new Date(iso)) : '');
  const fmtTime = (iso: string | null | undefined): string => (iso ? dt({ hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '');
  /** "Friday 14 March · 21:30–03:12" or a day range for multi-day events. */
  const fmtSpan = (start: string, end: string): string => {
    const s = new Date(start), e = new Date(end);
    const sameDay = s.toDateString() === e.toDateString() || e.getTime() - s.getTime() < 18 * 3600_000;
    if (sameDay) return `${fmtDate(start, { weekday: 'long', day: 'numeric', month: 'long' })} · ${fmtTime(start)}–${fmtTime(end)}`;
    return `${fmtDate(start, { day: 'numeric', month: 'short' })} – ${fmtDate(end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  };
  const fmtBytes = (n: number | undefined | null): string => {
    if (!n) return new Intl.NumberFormat(tag, { style: 'unit', unit: 'byte', unitDisplay: 'short' }).format(0);
    const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
    let i = 0; let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return new Intl.NumberFormat(tag, { style: 'unit', unit: units[i], unitDisplay: 'short', maximumFractionDigits: i >= 2 ? 1 : 0 }).format(v);
  };
  const fmtRelative = (iso: string | null | undefined): string => {
    if (!iso) return never;
    const rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto', style: 'short' });
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return rtf.format(0, 'second');
    if (d < 3600) return rtf.format(-Math.floor(d / 60), 'minute');
    if (d < 86400) return rtf.format(-Math.floor(d / 3600), 'hour');
    return rtf.format(-Math.floor(d / 86400), 'day');
  };
  const listNames = (names: string[]): string => (names.length ? new Intl.ListFormat(tag, { style: 'long', type: 'conjunction' }).format(names) : '');
  const fmtNumber = (n: number, opts?: Intl.NumberFormatOptions) => new Intl.NumberFormat(tag, opts).format(n);
  const kmDelta = (a: { lat: number; lon: number } | null | undefined, b: { lat: number; lon: number } | null | undefined): string | null => {
    if (!a || !b) return null;
    const R = 6371, dLat = ((b.lat - a.lat) * Math.PI) / 180, dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    const km = 2 * R * Math.asin(Math.sqrt(x));
    if (km < 0.05) return null;
    return km < 1
      ? `→ ${fmtNumber(Math.round(km * 1000), { style: 'unit', unit: 'meter', unitDisplay: 'short' })}`
      : `→ ${fmtNumber(km, { style: 'unit', unit: 'kilometer', unitDisplay: 'short', maximumFractionDigits: 1 })}`;
  };
  return { locale, tag, fmtDate, fmtTime, fmtSpan, fmtBytes, fmtRelative, listNames, fmtNumber, kmDelta };
}

/** Locale-bound formatters for the language the page is rendered in. */
export function useFormat(): Fmt {
  const locale = useLocale() as Locale;
  const t = useTranslations('common');
  const never = t('never');
  return useMemo(() => makeFormat(locale, never), [locale, never]);
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name.split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}
