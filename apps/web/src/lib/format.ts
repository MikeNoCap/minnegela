const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function fmtDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(undefined, opts).format(new Date(iso));
}
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
/** "Friday 14 March · 21:30–03:12" or a day range for multi-day events. */
export function fmtSpan(start: string, end: string): string {
  const s = new Date(start), e = new Date(end);
  const sameDay = s.toDateString() === e.toDateString() || e.getTime() - s.getTime() < 18 * 3600_000;
  if (sameDay) return `${WEEKDAYS[s.getDay()]} ${fmtDate(start, { day: 'numeric', month: 'long' })} · ${fmtTime(start)}–${fmtTime(end)}`;
  return `${fmtDate(start, { day: 'numeric', month: 'short' })} – ${fmtDate(end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}
export function fmtBytes(n: number | undefined | null): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
}
export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}
export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name.split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}
export function listNames(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
export function kmDelta(a: { lat: number; lon: number } | null | undefined, b: { lat: number; lon: number } | null | undefined): string | null {
  if (!a || !b) return null;
  const R = 6371, dLat = ((b.lat - a.lat) * Math.PI) / 180, dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(x));
  if (km < 0.05) return null;
  return km < 1 ? `→ ${Math.round(km * 1000)} m` : `→ ${km.toFixed(1)} km`;
}
export function cleanTag(tag: string): string {
  return tag.replace(/^a photo of (a |an )?/, '').replace(/^(a|an) /, '');
}
