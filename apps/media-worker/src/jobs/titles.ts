import { sql, eq, and, isNull, inArray, events, eventAssets, blobs, assets, persons, users, places } from '@minnegela/db';
import { JobPayloads } from '@minnegela/shared';
import type { Ctx } from '../context.js';
import { haversineM } from '../geo.js';
import { reverseGeocode } from '../geocode.js';

type P = ReturnType<typeof JobPayloads.titles.parse>;

export type TitleInput = {
  startAt: Date; endAt: Date; tz: string | null;
  participants: Array<{ name: string; birthday: string | null }>;   // birthday as YYYY-MM-DD
  placeName: string | null; city: string | null;
  tags: Array<Array<{ tag: string; score: number }>>;               // per asset
};

const TOD = (h: number) => (h >= 5 && h < 11 ? 'morning' : h >= 11 && h < 17 ? 'afternoon' : h >= 17 && h < 22 ? 'evening' : 'night');

function localParts(d: Date, tz: string | null) {
  const zone = tz && /^[A-Za-z]+\/[A-Za-z_]+$/.test(tz) ? tz : 'Europe/Oslo';
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long', hour: 'numeric', hour12: false, month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday!, hour: Number(parts.hour) % 24, month: Number(parts.month), day: Number(parts.day) };
}

export function cleanTag(tag: string): string {
  return tag.replace(/^a photo of /, '').replace(/^an? /, '').replace(/^(the )/, '').trim();
}

/** §9.10 rule order: manual (handled by caller) → birthday → named place → dominant tag → fallback. */
export function autoTitle(i: TitleInput): string {
  const lp = localParts(i.startAt, i.tz);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const withCity = (s: string) => (i.city ? `${s} — ${i.city}` : s);
  for (const p of i.participants) {
    if (!p.birthday) continue;
    const [, m, d] = p.birthday.split('-').map(Number);
    for (const dayOff of [-1, 0, 1]) {
      const probe = new Date(i.startAt.getTime() + dayOff * 86400_000);
      const q = localParts(probe, i.tz);
      if (q.month === m && q.day === d) return `${p.name}'s birthday`;
    }
  }
  if (i.placeName) return `${i.placeName}, ${lp.weekday} ${TOD(lp.hour)}`;
  const n = i.tags.length;
  if (n >= 3) {
    const counts = new Map<string, number>();
    for (const t of i.tags) for (const { tag, score } of t) if (score >= 0.6) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const best = [...counts.entries()].filter(([tag]) => !/screenshot|document|receipt|meme|blurry|beautiful|group of people|portrait|selfie/.test(tag)).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] / n >= 0.4) return i.city ? `${cap(cleanTag(best[0]))} in ${i.city}` : cap(cleanTag(best[0]));
  }
  return withCity(`${lp.weekday} ${TOD(lp.hour)}`);
}

export async function titles(ctx: Ctx, payload: P): Promise<void> {
  const { db, cfg, log } = ctx;
  const where = payload.eventIds?.length
    ? and(eq(events.groupId, payload.groupId), inArray(events.id, payload.eventIds), isNull(events.deletedAt))
    : and(eq(events.groupId, payload.groupId), isNull(events.deletedAt));
  const evs = await db.select().from(events).where(where);
  const placeRows = await db.select().from(places).where(eq(places.groupId, payload.groupId));

  for (const ev of evs) {
    const media = await db.select({ blobId: blobs.id, tags: blobs.tags, quality: blobs.quality, nFaces: blobs.nFaces, city: blobs.city, capturedAt: blobs.capturedAt, lat: blobs.lat, lon: blobs.lon })
      .from(eventAssets).innerJoin(blobs, eq(blobs.id, eventAssets.blobId)).innerJoin(assets, eq(assets.id, eventAssets.assetId))
      .where(and(eq(eventAssets.eventId, ev.id), isNull(assets.deletedAt))).orderBy(blobs.capturedAt);
    // place: nearest existing within 300 m of the event center, else create
    let place = ev.placeId ? placeRows.find((p) => p.id === ev.placeId) ?? null : null;
    if (!place && ev.centerLat != null && ev.centerLon != null) {
      place = placeRows.filter((p) => haversineM(p.lat, p.lon, ev.centerLat!, ev.centerLon!) <= Math.max(300, p.radiusM)).sort((a, b) => haversineM(a.lat, a.lon, ev.centerLat!, ev.centerLon!) - haversineM(b.lat, b.lon, ev.centerLat!, ev.centerLon!))[0] ?? null;
      if (!place) {
        const cityVotes = new Map<string, number>();
        for (const m of media) if (m.city) cityVotes.set(m.city, (cityVotes.get(m.city) ?? 0) + 1);
        let city = [...cityVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        if (!city) city = await reverseGeocode(ev.centerLat, ev.centerLon, cfg.geocode);
        const [created] = await db.insert(places).values({ groupId: payload.groupId, lat: ev.centerLat, lon: ev.centerLon, city }).returning();
        place = created!; placeRows.push(place);
      }
    }
    if (place && !place.city && cfg.geocode) {
      const city = await reverseGeocode(place.lat, place.lon, true);
      if (city) { await db.update(places).set({ city }).where(eq(places.id, place.id)); place.city = city; }
    }
    const city = place?.city ?? media.find((m) => m.city)?.city ?? null;
    const participants = ev.personIds.length
      ? await db.select({ name: persons.name, birthday: users.birthday }).from(persons).leftJoin(users, eq(users.id, persons.userId)).where(inArray(persons.id, ev.personIds))
      : [];
    const title = autoTitle({
      startAt: ev.startAt, endAt: ev.endAt, tz: ev.tz,
      participants: participants.map((p) => ({ name: p.name ?? 'Someone', birthday: p.birthday })),
      placeName: place?.name ?? null, city,
      tags: media.map((m) => m.tags ?? []),
    });
    // cover: sharpest photo with faces, else the middle asset
    const withFaces = media.filter((m) => m.nFaces > 0).sort((a, b) => (b.quality?.sharpness ?? 0) - (a.quality?.sharpness ?? 0));
    const cover = withFaces[0]?.blobId ?? media[Math.floor(media.length / 2)]?.blobId ?? null;
    await db.update(events).set({ titleAuto: title, placeId: place?.id ?? ev.placeId, coverBlobId: cover, updatedAt: sql`now()` }).where(eq(events.id, ev.id));
  }
  // n_events per place
  await db.execute(sql`update places p set n_events = (select count(*) from events e where e.place_id = p.id and e.deleted_at is null) where p.group_id = ${payload.groupId}`);
  log.info({ groupId: payload.groupId, n: evs.length }, 'titles: done');
}
