import { sql, type Tx, type ViewerCtx } from '@minnegela/db';
import { alias } from 'drizzle-orm/pg-core';
import { visibleEventsWhere, events, assets, WBS, type EventCard, type MediaItem } from './deps.js';

/** Aliases matching the `events e` / `assets a` used in the raw queries; pass these to the predicate builders. */
export const E = alias(events, 'e') as unknown as typeof events;
export const A = alias(assets, 'a') as unknown as typeof assets;

/** Row shape produced by the events query below. */
export type EventRow = {
  id: string; kind: 'event' | 'trip' | 'loose'; title_auto: string | null; title_manual: string | null;
  start_at: Date; end_at: Date; tz: string | null; center_lat: number | null; center_lon: number | null;
  place_id: string | null; place_name: string | null; contributor_ids: string[]; person_ids: number[];
  n_assets: number; n_videos: number; confidence: number; cover_blob_id: string | null;
  is_public_to_group: boolean; frozen: boolean; suggested_splits: Date[] | null; opened_by_user_id: string | null; opened_at: Date | null;
};

export const EVENT_COLUMNS = sql`e.id, e.kind, e.title_auto, e.title_manual, e.start_at, e.end_at, e.tz, e.center_lat, e.center_lon,
  e.place_id, p.name as place_name, e.contributor_ids, e.person_ids, e.n_assets, e.n_videos, e.confidence, e.cover_blob_id,
  e.is_public_to_group, e.frozen, e.suggested_splits::text[] as suggested_splits, e.opened_by_user_id, e.opened_at`;

export function eventTitle(r: { title_manual: string | null; title_auto: string | null; start_at: Date }): string {
  return r.title_manual ?? r.title_auto ?? r.start_at.toISOString().slice(0, 10);
}

export function toEventCard(r: EventRow): EventCard {
  return {
    id: r.id, kind: r.kind, title: eventTitle(r), titleManual: r.title_manual,
    startAt: r.start_at.toISOString(), endAt: r.end_at.toISOString(), tz: r.tz,
    center: r.center_lat !== null && r.center_lon !== null ? { lat: r.center_lat, lon: r.center_lon } : null,
    placeId: r.place_id, placeName: r.place_name, contributorIds: r.contributor_ids, personIds: r.person_ids,
    nAssets: r.n_assets, nVideos: r.n_videos, confidence: r.confidence, coverBlobId: r.cover_blob_id,
    isPublicToGroup: r.is_public_to_group, frozen: r.frozen,
  };
}

export function confidenceCopy(confidence: number, suggestedSplits: number): string {
  if (suggestedSplits > 0) return 'This might be two events';
  return confidence >= WBS.eventConfidentCopy ? "We're fairly sure this was one event" : 'This might be more than one event';
}

/** Events visible to the viewer, with the place name joined. Callers append their own filters and ordering. */
export function visibleEventsFrom(ctx: ViewerCtx) {
  return sql`from events e left join places p on p.id = e.place_id where ${visibleEventsWhere(ctx, E)}`;
}

export type MediaRow = {
  asset_id: string; blob_id: string; owner_user_id: string; mime: string; width: number | null; height: number | null;
  duration_ms: number | null; captured_at: Date | null; lat: number | null; lon: number | null; person_ids: number[];
  tags: Array<{ tag: string; score: number }>; is_utility: boolean; storage_key: string | null; thumb_key: string | null; analyzed_at: Date | null;
  event_id?: string | null; ea_confidence?: number | null; ea_tier?: 'confirmed' | 'probable' | 'uncertain' | null; ea_source?: 'auto' | 'manual' | null;
};
export const MEDIA_COLUMNS = sql`a.id as asset_id, b.id as blob_id, a.owner_user_id, b.mime, b.width, b.height, b.duration_ms, b.captured_at, b.lat, b.lon,
  a.person_ids, b.tags, b.is_utility, b.storage_key, b.thumb_key, b.analyzed_at`;

export function toMediaItem(r: MediaRow): MediaItem {
  return {
    assetId: r.asset_id, blobId: r.blob_id, ownerUserId: r.owner_user_id, mime: r.mime, width: r.width, height: r.height,
    durationMs: r.duration_ms, capturedAt: r.captured_at?.toISOString() ?? null, lat: r.lat, lon: r.lon,
    personIds: r.person_ids ?? [], tags: r.tags ?? [], isUtility: r.is_utility,
    membership: r.event_id ? { eventId: r.event_id, confidence: r.ea_confidence ?? 0, tier: r.ea_tier ?? 'uncertain', source: r.ea_source ?? 'auto' } : undefined,
    hasOriginal: r.storage_key !== null, hasThumb: r.thumb_key !== null, analyzed: r.analyzed_at !== null,
  };
}

/** Raw `execute` rows carry timestamps as strings (drizzle disables the driver's date parsing). */
export async function rows<T>(tx: Tx, q: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(q)) as unknown as T[];
}
/**
 * Array and Date parameters for raw `sql` templates. Drizzle flattens a JS array into `$1, $2, …`
 * (an IN-list) and hands Dates to the driver untouched, so pg arrays go in as literals and Dates as ISO strings.
 */
export const uuidArr = (ids: readonly string[]) => sql`${'{' + ids.join(',') + '}'}::uuid[]`;
export const intArr = (ns: readonly number[]) => sql`${'{' + ns.join(',') + '}'}::int[]`;
export const bigintArr = (ns: readonly number[]) => sql`${'{' + ns.join(',') + '}'}::bigint[]`;
export const ts = (d: Date | string) => sql`${d instanceof Date ? d.toISOString() : d}::timestamptz`;
export const asDate = (x: Date | string | null | undefined): Date | null => (x === null || x === undefined ? null : x instanceof Date ? x : new Date(x));
export const iso = (x: Date | string | null | undefined): string | null => asDate(x)?.toISOString() ?? null;

export async function eventRows(tx: Tx, q: ReturnType<typeof sql>): Promise<EventRow[]> {
  return (await rows<EventRow>(tx, q)).map((r) => ({
    ...r, start_at: asDate(r.start_at)!, end_at: asDate(r.end_at)!, opened_at: asDate(r.opened_at),
    suggested_splits: (r.suggested_splits ?? []).map((d) => asDate(d)!),
  }));
}
export async function mediaRows<T extends MediaRow = MediaRow>(tx: Tx, q: ReturnType<typeof sql>): Promise<T[]> {
  return (await rows<T>(tx, q)).map((r) => ({ ...r, captured_at: asDate(r.captured_at), analyzed_at: asDate(r.analyzed_at) }));
}
