import { z } from 'zod';

/** DTOs returned by the API. Kept small; the web app and CLI import these. */
export const Tier = z.enum(['confirmed', 'probable', 'uncertain']);
export const FaceTier = z.enum(['confirmed', 'high', 'probable', 'low']);

export const PersonSummary = z.object({ id: z.number().int(), name: z.string().nullable(), userId: z.string().uuid().nullable(), coverFaceId: z.string().uuid().nullable(), hidden: z.boolean() });
export type PersonSummary = z.infer<typeof PersonSummary>;

export const MemberSummary = z.object({ userId: z.string().uuid(), displayName: z.string(), role: z.enum(['owner', 'member']), personId: z.number().int().nullable(), consentFacesAt: z.string().nullable() });
export type MemberSummary = z.infer<typeof MemberSummary>;

export const EventCard = z.object({
  id: z.string().uuid(),
  kind: z.enum(['event', 'trip', 'loose']),
  title: z.string(),
  titleManual: z.string().nullable(),
  startAt: z.string(),
  endAt: z.string(),
  tz: z.string().nullable(),
  center: z.object({ lat: z.number(), lon: z.number() }).nullable(),
  placeId: z.string().uuid().nullable(),
  placeName: z.string().nullable(),
  contributorIds: z.array(z.string().uuid()),
  personIds: z.array(z.number().int()),
  nAssets: z.number().int(),
  nVideos: z.number().int(),
  confidence: z.number(),
  coverBlobId: z.string().uuid().nullable(),
  isPublicToGroup: z.boolean(),
  frozen: z.boolean(),
});
export type EventCard = z.infer<typeof EventCard>;

export type Visibility = z.infer<typeof Visibility>;
export const Visibility = z.object({
  viewers: z.array(z.object({ userId: z.string().uuid(), displayName: z.string(), reasons: z.array(z.enum(['contributor', 'face', 'tag', 'opened'])) })),
  isPublicToGroup: z.boolean(),
  openedBy: z.object({ userId: z.string().uuid(), displayName: z.string(), at: z.string() }).nullable(),
});

export const MediaItem = z.object({
  assetId: z.string().uuid(),
  blobId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  mime: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  capturedAt: z.string().nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  personIds: z.array(z.number().int()),
  tags: z.array(z.object({ tag: z.string(), score: z.number() })),
  isUtility: z.boolean(),
  /** Present when the item is listed inside an event. */
  membership: z.object({ eventId: z.string().uuid(), confidence: z.number(), tier: Tier, source: z.enum(['auto', 'manual']) }).optional(),
  hasOriginal: z.boolean(),
  hasThumb: z.boolean(),
  analyzed: z.boolean(),
});
export type MediaItem = z.infer<typeof MediaItem>;

export const Moment = z.object({ id: z.string().uuid(), startAt: z.string(), endAt: z.string(), label: z.string().nullable(), nAssets: z.number().int(), blobIds: z.array(z.string().uuid()) });
export type Moment = z.infer<typeof Moment>;

export const EventDetail = EventCard.extend({
  moments: z.array(Moment),
  participants: z.array(PersonSummary),
  contributors: z.array(z.object({ userId: z.string().uuid(), displayName: z.string(), nAssets: z.number().int() })),
  suggestedSplits: z.array(z.string()),
  confidenceCopy: z.string(),
});
export type EventDetail = z.infer<typeof EventDetail>;

export const SignedUrlKind = z.enum(['thumb', 'preview', 'orig', 'video720', 'poster']);
export const MediaUrlsRequest = z.object({ items: z.array(z.object({ blobId: z.string().uuid(), kind: SignedUrlKind })).min(1).max(500) });
export const MediaUrlsResponse = z.object({ urls: z.record(z.string(), z.string()).describe('`${blobId}:${kind}` -> url; missing keys were not visible or not available') });

export const Page = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const Problem = z.object({ type: z.string().default('about:blank'), title: z.string(), status: z.number().int(), detail: z.string().optional(), instance: z.string().optional() });
export type Problem = z.infer<typeof Problem>;
