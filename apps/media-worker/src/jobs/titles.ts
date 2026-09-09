import { sql, eq, and, isNull, inArray, events, eventAssets, blobs, assets, persons, users, places } from '@minnegela/db';
import { JobPayloads, TAGS, INTEREST, LOCALES, cleanTag, tagLabel, type StoredTag, type Locale, type Localized } from '@minnegela/shared';
import type { Ctx } from '../context.js';
import { haversineM } from '../geo.js';
import { reverseGeocode } from '../geocode.js';

export { cleanTag };

type P = ReturnType<typeof JobPayloads.titles.parse>;

export type Participant = { name: string | null; birthday: string | null; userId: string | null };

export type TitleInput = {
  startAt: Date; endAt: Date; tz: string | null;
  participants: Participant[];                                   // birthday as YYYY-MM-DD
  placeName: string | null; city: string | null;
  tags: StoredTag[][];                                           // per asset
};

type Tod = 'morning' | 'afternoon' | 'evening' | 'night';
const TOD = (h: number): Tod => (h >= 5 && h < 11 ? 'morning' : h >= 11 && h < 17 ? 'afternoon' : h >= 17 && h < 22 ? 'evening' : 'night');

/** The words a title is built from; names, places and tag labels are slotted in between. */
const WORDS: Record<Locale, { intl: string; tod: Record<Tod, string>; and: string; others: (n: number) => string; with: string; in: string; birthday: (name: string) => string }> = {
  en: { intl: 'en-GB', tod: { morning: 'morning', afternoon: 'afternoon', evening: 'evening', night: 'night' }, and: 'and', others: (n) => `${n} other${n === 1 ? '' : 's'}`, with: 'with', in: 'in', birthday: (n) => `${n}'s birthday` },
  nb: { intl: 'nb-NO', tod: { morning: 'morgen', afternoon: 'ettermiddag', evening: 'kveld', night: 'natt' }, and: 'og', others: (n) => `${n} ${n === 1 ? 'annen' : 'andre'}`, with: 'med', in: 'i', birthday: (n) => (/[sxz]$/i.test(n) ? `${n}' bursdag` : `${n}s bursdag`) },
};

function localParts(d: Date, tz: string | null, locale: Locale = 'en') {
  const zone = tz && /^[A-Za-z]+\/[A-Za-z_]+$/.test(tz) ? tz : 'Europe/Oslo';
  const f = new Intl.DateTimeFormat(WORDS[locale].intl, { timeZone: zone, weekday: 'long', hour: 'numeric', hour12: false, month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday!, hour: Number(parts.hour) % 24, month: Number(parts.month), day: Number(parts.day) };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Stefan", "Stefan and Åsmul", "Mikkel, Stefan and Åsmul", "Mikkel, Stefan, Åsmul and 2 others" — in the given language. */
export function listNames(names: string[], locale: Locale = 'en', max = 3): string {
  const w = WORDS[locale];
  if (!names.length) return '';
  if (names.length === 1) return names[0]!;
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} ${w.and} ${names[names.length - 1]}`;
  return `${names.slice(0, max).join(', ')} ${w.and} ${w.others(names.length - max)}`;
}

export type TagVote = { tag: string; cat: string; coverage: number; meanScore: number };

/**
 * Event-level vote: for every tag, the fraction of assets on which it is present (score >= TAGS.present).
 * Per-image tags are noisy by design (≈200 candidates); coverage across the event is what we trust.
 */
export function voteTags(perAsset: StoredTag[][]): TagVote[] {
  const n = perAsset.length;
  if (!n) return [];
  const acc = new Map<string, { cat: string; hits: number; sum: number }>();
  for (const tags of perAsset) {
    const seen = new Set<string>();
    for (const t of tags ?? []) {
      if (t.score < TAGS.present || seen.has(t.tag)) continue;
      seen.add(t.tag);
      const key = t.tag;
      const cur = acc.get(key) ?? { cat: t.cat ?? legacyCategory(t.tag), hits: 0, sum: 0 };
      cur.hits += 1; cur.sum += t.score;
      acc.set(key, cur);
    }
  }
  return [...acc.entries()].map(([tag, v]) => ({ tag, cat: v.cat, coverage: v.hits / n, meanScore: v.sum / v.hits }))
    .sort((a, b) => b.coverage - a.coverage || b.meanScore - a.meanScore);
}

/** Old prompt-style tags carried no category; keep them out of titles except a few obvious scenes. */
function legacyCategory(tag: string): string {
  if (/screenshot|document|receipt|meme|text message|map/.test(tag)) return 'utility';
  if (/selfie|group of people|portrait/.test(tag)) return 'people';
  if (/blurry|beautiful/.test(tag)) return 'quality';
  if (/beach|concert|party|hike|wedding|sunset|fireworks|birthday|mountain|forest|lake|snow|cabin|boat/.test(tag)) return 'activity';
  return 'object';
}

/** The tag that names the event: best coverage among title categories, activity preferred over scenery over things. */
export function dominantTag(votes: TagVote[], minCoverage = TAGS.eventCoverage): TagVote | null {
  for (const cat of TAGS.titleCategories) {
    const best = votes.find((v) => v.cat === cat && v.coverage >= minCoverage);
    if (best) return best;
  }
  return null;
}

/**
 * §9.10 rule order: manual (caller) → birthday → activity with names → named place with names → activity
 * → named place → names → fallback. Names are the recognised, named participants; the photographer is not
 * excluded because the title is group-wide ("Frisbee golf with Mikkel, Stefan and Åsmul").
 */
export function autoTitle(i: TitleInput, locale: Locale = 'en'): string {
  const w = WORDS[locale];
  const lp = localParts(i.startAt, i.tz, locale);
  const when = `${lp.weekday} ${w.tod[TOD(lp.hour)]}`;
  const withCity = (s: string) => (i.city ? `${s} — ${i.city}` : s);
  const build = (): string => {
    for (const p of i.participants) {
      if (!p.birthday || !p.name) continue;
      const [, m, d] = p.birthday.split('-').map(Number);
      for (const dayOff of [-1, 0, 1]) {
        const probe = new Date(i.startAt.getTime() + dayOff * 86400_000);
        const q = localParts(probe, i.tz);
        if (q.month === m && q.day === d) return w.birthday(p.name);
      }
    }
    const names = listNames(i.participants.map((p) => p.name).filter((n): n is string => !!n?.trim()), locale);
    const dom = i.tags.length >= 3 ? dominantTag(voteTags(i.tags)) : null;
    const activity = dom ? cap(tagLabel(dom.tag, locale)) : null;
    if (activity && names) return `${activity} ${w.with} ${names}`;
    if (i.placeName && names) return `${i.placeName} ${w.with} ${names}`;
    if (activity) return i.city && dom!.cat !== 'scene' ? `${activity} ${w.in} ${i.city}` : i.city ? `${activity} — ${i.city}` : activity;
    if (i.placeName) return `${i.placeName}, ${when}`;
    if (names) return `${when} ${w.with} ${names}`;
    return withCity(when);
  };
  // Norwegian weekdays are lowercase mid-sentence ("Blå, fredag kveld") but a title still starts with a capital.
  return cap(build());
}

/** The title in every language the product speaks; the API serves the viewer's one. */
export const autoTitles = (i: TitleInput): Localized => Object.fromEntries(LOCALES.map((l) => [l, autoTitle(i, l)]));

// ---------------------------------------------------------------------------------------------- interest

export type InterestInput = {
  nAssets: number; nVideos: number; hours: number;
  others: number;                 // named persons who are not among the contributors
  facesPerAsset: number;
  contributors: number;
  votes: TagVote[];
  placeNamed: boolean;
  routine: number;                // places.routine, 0..1
  manual: -1 | 1 | null;
};

/** §9.11: 0..1, weights from INTEREST. Pure so it can be tuned against a labelled feed. */
export function interestScore(i: InterestInput): number {
  const W = INTEREST;
  const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
  const specific = Math.max(0, ...i.votes.filter((v) => (TAGS.titleCategories as readonly string[]).includes(v.cat)).map((v) => v.coverage));
  const mundane = Math.max(0, ...i.votes.filter((v) => v.cat === 'mundane').map((v) => v.coverage));
  let s = W.base
    + W.others * clamp(i.others / 3)
    + W.faces * clamp(i.facesPerAsset / 2)
    + W.contributors * (i.contributors >= 2 ? 1 : 0)
    + W.specific * clamp(specific)
    + W.size * clamp(i.nAssets / 24)
    + W.duration * clamp(i.hours / 4)
    + W.namedPlace * (i.placeNamed ? 1 : 0)
    - W.routinePenalty * clamp(i.routine)
    - W.mundanePenalty * clamp(mundane)
    - W.videoOnlyPenalty * (i.nAssets > 0 && i.nVideos >= i.nAssets ? 1 : 0);
  if (i.manual === 1) s = Math.max(s, W.manualHigh);
  if (i.manual === -1) s = Math.min(s, W.manualLow);
  return Math.round(clamp(s) * 1000) / 1000;
}

/** places.routine from the place's history: many events, few other people, one contributor; feedback nudges it. */
export function routineScore(p: { nEvents: number; avgOthers: number; multiContribFraction: number; demoted: number; promoted: number }): number {
  const R = INTEREST.routine;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const base = clamp((p.nEvents - R.minEvents) / (R.fullAtEvents - R.minEvents)) * (1 - clamp(p.avgOthers / 1.5)) * (1 - clamp(p.multiContribFraction * 2));
  const fb = p.nEvents ? (p.demoted - p.promoted) / p.nEvents : 0;
  return Math.round(clamp(base + R.feedback * fb) * 1000) / 1000;
}

// ---------------------------------------------------------------------------------------------- job

export async function titles(ctx: Ctx, payload: P): Promise<void> {
  const { db, cfg, log } = ctx;
  const where = payload.eventIds?.length
    ? and(eq(events.groupId, payload.groupId), inArray(events.id, payload.eventIds), isNull(events.deletedAt))
    : and(eq(events.groupId, payload.groupId), isNull(events.deletedAt));
  const evs = await db.select().from(events).where(where);
  await refreshPlaceStats(ctx, payload.groupId, null);   // routines feed the interest score below
  const placeRows = await db.select().from(places).where(eq(places.groupId, payload.groupId));
  const touchedPlaces = new Set<string>();

  for (const ev of evs) {
    const media = await db.select({ blobId: blobs.id, tags: blobs.tags, quality: blobs.quality, nFaces: blobs.nFaces, city: blobs.city, capturedAt: blobs.capturedAt, lat: blobs.lat, lon: blobs.lon, durationMs: blobs.durationMs })
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
    if (place) touchedPlaces.add(place.id);
    const city = place?.city ?? media.find((m) => m.city)?.city ?? null;
    const participants: Participant[] = ev.personIds.length
      ? await db.select({ name: persons.name, birthday: users.birthday, userId: persons.userId }).from(persons).leftJoin(users, eq(users.id, persons.userId)).where(inArray(persons.id, ev.personIds))
      : [];
    const perAsset = media.map((m) => (m.tags ?? []) as StoredTag[]);
    const title = autoTitles({ startAt: ev.startAt, endAt: ev.endAt, tz: ev.tz, participants, placeName: place?.name ?? null, city, tags: perAsset });
    const votes = voteTags(perAsset);
    const others = participants.filter((p) => p.name && !(p.userId && ev.contributorIds.includes(p.userId))).length;
    const interest = interestScore({
      nAssets: media.length, nVideos: media.filter((m) => m.durationMs != null).length,
      hours: (ev.endAt.getTime() - ev.startAt.getTime()) / 3600_000,
      others, facesPerAsset: media.length ? media.reduce((a, m) => a + m.nFaces, 0) / media.length : 0,
      contributors: ev.contributorIds.length, votes, placeNamed: !!place?.name, routine: place?.routine ?? 0,
      manual: (ev.interestManual as -1 | 1 | null) ?? null,
    });
    // cover: sharpest photo with faces, else the middle asset
    const withFaces = media.filter((m) => m.nFaces > 0 && m.durationMs == null).sort((a, b) => (b.quality?.sharpness ?? 0) - (a.quality?.sharpness ?? 0));
    const cover = withFaces[0]?.blobId ?? media[Math.floor(media.length / 2)]?.blobId ?? null;
    await db.update(events).set({ titleAuto: title, placeId: place?.id ?? ev.placeId, coverBlobId: cover, interest, updatedAt: sql`now()` }).where(eq(events.id, ev.id));
  }

  await refreshPlaceStats(ctx, payload.groupId, payload.eventIds?.length ? [...touchedPlaces] : placeRows.map((p) => p.id));
  log.info({ groupId: payload.groupId, n: evs.length }, 'titles: done');
}

const uuidArr = (ids: readonly string[]) => sql`${'{' + ids.join(',') + '}'}::uuid[]`;

/** places.n_events and places.routine from every event at the place (null = every place in the group). */
async function refreshPlaceStats(ctx: Ctx, groupId: string, placeIds: string[] | null): Promise<void> {
  const { db } = ctx;
  await db.execute(sql`update places p set n_events = (select count(*) from events e where e.place_id = p.id and e.deleted_at is null) where p.group_id = ${groupId}`);
  if (placeIds && !placeIds.length) return;
  const stats = (await db.execute(sql`
    select e.place_id, count(*)::int as n,
      avg((select count(*) from persons pr where pr.id = any(e.person_ids) and pr.name is not null and (pr.user_id is null or not (pr.user_id = any(e.contributor_ids)))))::float as avg_others,
      avg(case when cardinality(e.contributor_ids) >= 2 then 1 else 0 end)::float as multi,
      count(*) filter (where e.interest_manual = -1)::int as demoted,
      count(*) filter (where e.interest_manual = 1)::int as promoted
    from events e where e.group_id = ${groupId} and e.deleted_at is null and e.kind <> 'loose' and e.place_id is not null
      ${placeIds ? sql`and e.place_id = any(${uuidArr(placeIds)})` : sql``}
    group by e.place_id`)) as unknown as Array<{ place_id: string; n: number; avg_others: number | null; multi: number | null; demoted: number; promoted: number }>;
  for (const s of stats) {
    const routine = routineScore({ nEvents: s.n, avgOthers: s.avg_others ?? 0, multiContribFraction: s.multi ?? 0, demoted: s.demoted, promoted: s.promoted });
    await db.update(places).set({ routine }).where(eq(places.id, s.place_id));
  }
}
