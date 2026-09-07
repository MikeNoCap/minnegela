/**
 * Reverse geocoding via Nominatim, off unless GEOCODE=1 (never in tests). 1 request/second, identified UA,
 * results cached by the callers on places.city / blobs.city. Returns a short locality name ("Oslo").
 */
let last = 0;
const memo = new Map<string, string | null>();

export async function reverseGeocode(lat: number, lon: number, enabled: boolean): Promise<string | null> {
  if (!enabled) return null;
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (memo.has(key)) return memo.get(key)!;
  const wait = 1100 - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'minnegela/0.1 (self-hosted memory search)', Accept: 'application/json' } });
    if (!res.ok) { memo.set(key, null); return null; }
    const j = (await res.json()) as { address?: Record<string, string> };
    const a = j.address ?? {};
    const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? a.state ?? null;
    memo.set(key, city);
    return city;
  } catch {
    memo.set(key, null);
    return null;
  }
}
