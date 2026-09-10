import type { z } from 'zod';
import type { EventCard, EventDetail, MediaItem, PersonSummary, SearchChip, Moment as MomentSchema, MemberSummary as MemberSummarySchema, Visibility, ConfidenceKey } from '@minnegela/shared';
export type { EventCard, EventDetail, MediaItem, PersonSummary, SearchChip, ConfidenceKey };
export type Moment = z.infer<typeof MomentSchema>;
export type MemberSummary = z.infer<typeof MemberSummarySchema>;
export type VisibilityInfo = z.infer<typeof Visibility>;
export type Page<T> = { items: T[]; nextCursor: string | null; quietCount?: number | null };

/** GET /v1/me */
export type Me = {
  user: { id: string; email: string; displayName?: string; name?: string; image?: string | null; birthday?: string | null };
  groups: Array<{ id: string; name: string; role: 'owner' | 'member'; personId?: number | null }>;
};

export type GroupInfo = { id: string; name: string; createdBy?: string; settings?: Record<string, unknown>; createdAt?: string };

export type GroupStatus = {
  queues?: Array<{ kind: string; pending: number; running: number; failed: number }>;
  devices?: Array<{ id: string; name: string; platform: string; userId?: string; ownerName?: string; lastSyncAt: string | null }>;
  storage?: { blobs?: number; assets?: number; bytes?: number; originals?: number; previews?: number };
  analyzing?: number;
  pendingAnalyze?: number;
};

export type PersonDetail = PersonSummary & {
  nAssets?: number;
  nEvents?: number;
  events?: EventCard[];
  coAppearances?: Array<{ personId: number; name: string | null; count: number }>;
  media?: MediaItem[];
};

export type UnknownCluster = { id: string; n: number; coverFaceId: string | null; faceIds: string[]; faces?: FaceRef[] };
export type FaceRef = { id: string; blobId: string; box: { x: number; y: number; w: number; h: number }; personId: number | null; tier: string | null; matchScore: number | null; cropUrl?: string | null; personName?: string | null };
export type ReviewQueue = {
  unnamedClusters: UnknownCluster[];
  lowConfidenceFaces: FaceRef[];
  suggestedSplits: Array<{ eventId: string; title: string; at: string[] }>;
};

export type MediaDetail = MediaItem & {
  people?: PersonSummary[];
  ownerName?: string;
  placeName?: string | null;
  events?: Array<{ id: string; title: string }>;
  similar?: MediaItem[];
  otherAngles?: MediaItem[];
  city?: string | null;
};

export type TimelineDay = { day: string; events: EventCard[]; loose: MediaItem[] };
/** GET /v1/groups/:g/timeline/overview — one compact row per visible event, every kind, newest first. */
export type TimelineEvent = {
  id: string; kind: 'event' | 'trip' | 'loose'; title: string; startAt: string; endAt: string;
  center: { lat: number; lon: number } | null; placeName: string | null; city: string | null;
  contributorIds: string[]; personIds: number[]; nAssets: number; nVideos: number; coverBlobId: string | null;
  isPublicToGroup: boolean; interest: number | null;
};
export type TimelineOverview = { items: TimelineEvent[]; span: { from: string; to: string } | null };
/** GET /v1/groups/:g/map */
export type MapPin = {
  id: string; kind: 'event' | 'trip' | 'loose'; title: string; lat: number; lon: number; nAssets: number; nVideos: number; startAt: string; endAt: string;
  coverBlobId: string | null; personIds: number[]; contributorIds: string[]; placeName: string | null; city: string | null;
};
export type MapData = { items: MapPin[]; loose: MediaItem[] };
export type AuditRow = { id: number; userId: string | null; userName?: string | null; action: string; targetType: string | null; targetId: string | null; at: string; meta?: Record<string, unknown> | null };
export type Invite = { code: string; expiresAt: string };
export type SearchResult = { parsed: SearchChip[]; events?: EventCard[]; media?: MediaItem[]; mode?: 'events' | 'media' };
