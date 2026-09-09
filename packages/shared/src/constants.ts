/** Numbers from docs/DESIGN.md. Every threshold lives here so the spike can tune them in one place. */

export const PREVIEW = { longEdgePx: 1600, jpegQuality: 82 } as const;
export const THUMB = { longEdgePx: 320 } as const;
export const FACE_CROP = { px: 160 } as const;
export const VIDEO = { frames: 8, transcodeHeight: 720, maxOriginalBytes: 500 * 1024 * 1024 } as const;

export const UPLOAD = { presignTtlSeconds: 15 * 60, maxPreviewBytes: 4 * 1024 * 1024, maxOriginalBytes: 5 * 1024 * 1024 * 1024 } as const;
/** GET URLs are signed with expiry aligned to 1-hour buckets so <img> tags hit the browser cache. §15.0 */
export const SIGNED_GET = { bucketSeconds: 3600 } as const;

/** §5.4 identity matching. */
export const FACE_MATCH = {
  high: { score: 0.62, margin: 0.1 },
  probable: { score: 0.5, margin: 0.06 },
  low: { score: 0.42 },
  contextBoost: 0.05,
  contextBoostMinConfirmed: 3,
  minFacePx: 32,
  minDetScore: 0.6,
  maxYawDeg: 60,
  unknownClusterDistance: 0.45,
  unknownClusterMinFaces: 4,
  prototypesMax: 12,
  prototypesPerFaces: 8,
} as const;

/** §9 Windowed Boundary Segmentation. */
export const WBS = {
  window: 8,
  tauMinMinutes: 20,
  tauMaxMinutes: 120,
  tauMedianMultiplier: 4,
  hardGapMinutes: 240,
  distScaleMeters: 800,
  samePlaceMeters: 300,
  travelMaxKmh: 90,
  travelMaxMinutes: 30,
  weights: { gap: 0.45, dist: 0.2, people: 0.15, visual: 0.1, contrib: 0.1 },
  cutThreshold: 0.5,
  adjacentMergeBand: [0.5, 0.6] as const,
  minEventAssets: 3,
  minEventMinutes: 10,
  maxEventHours: 18,
  concurrent: { minGpsAssets: 6, epsMeters: 500, minSamples: 3, minSpanMinutes: 30 },
  moments: { tauMinutes: 20, epsMeters: 150, threshold: 0.5, tagCoverage: 0.4, tagScore: 0.6 },
  membership: { weights: { interior: 0.35, geo: 0.25, people: 0.2, visual: 0.1, support: 0.1 } },
  tiers: { confirmed: 0.85, probable: 0.6 },
  eventConfidentCopy: 0.75,
  reclusterDebounceSeconds: 60,
  reclusterPadHours: 6,
  idReuseJaccard: 0.5,
  algoVersion: 1,
} as const;

/** §14 dedupe. */
export const DEDUPE = {
  reencodedMaxHamming: 4,
  burstMaxHamming: 10,
  burstMaxSeconds: 10,
  burstClipCos: 0.95,
  otherAngleMaxSeconds: 60,
  otherAngleMaxMeters: 50,
  otherAngleClipCos: 0.85,
  neighbourWindowHours: 24,   // re-encoded copies (WhatsApp saves) land up to a day later; bursts still need ≤10 s
} as const;

/** §6.3 calibrated zero-shot tags. The vocabulary lives in apps/ml-worker/minnegela_ml/vocab.py; each stored tag
 * carries its category, so nothing here needs the prompt list. `score` is a squashed per-group z-score. */
export const TAGS = {
  present: 0.6,          // a tag at/above this counts as "in the picture"
  top: 8,                // tags stored per blob (plus anything present)
  utility: 0.6,          // screenshot/document/receipt/meme threshold (plus the raw camera-photo anchor, ML side)
  vocabVersion: 3,
  /** Categories that describe *what happened*, in the order titles prefer them. */
  titleCategories: ['activity', 'scene', 'food', 'drink', 'animal', 'object'] as const,
  /** Coverage an event needs (fraction of assets with the tag present) before a tag names or scores it. */
  eventCoverage: 0.4,
} as const;
export type TagCategory = 'activity' | 'scene' | 'food' | 'drink' | 'object' | 'animal' | 'people' | 'mundane' | 'utility';
export type StoredTag = { tag: string; cat?: TagCategory; score: number; z?: number };

/** §9.11 feed interest: how likely an event is worth a card in the river. Weights sum to ~1 before penalties. */
export const INTEREST = {
  base: 0.10,
  others: 0.30,        // named people who are not the photographers, capped at 3
  faces: 0.15,         // average faces per asset, capped at 2
  contributors: 0.10,  // more than one contributor
  specific: 0.15,      // strongest activity/scene/food/... tag coverage
  size: 0.10,          // assets, capped at 24
  duration: 0.05,      // hours, capped at 4
  namedPlace: 0.05,    // the place has a user-given name
  routinePenalty: 0.35,
  mundanePenalty: 0.15,
  videoOnlyPenalty: 0.10,
  quiet: 0.30,         // below this the feed folds the event into "quiet events"
  manualHigh: 0.9,
  manualLow: 0.1,
  /** places.routine: many events, few other people, no second contributor; nudged by promote/demote feedback. */
  routine: { minEvents: 2, fullAtEvents: 10, feedback: 0.5 },
} as const;

export const STORAGE_KEYS = {
  staging: (groupId: string, assetId: string, kind: 'preview' | 'original', ext: string) => `groups/${groupId}/staging/${kind}/${assetId}.${ext}`,
  original: (groupId: string, sha256Hex: string, ext: string) => `groups/${groupId}/orig/${sha256Hex.slice(0, 2)}/${sha256Hex}.${ext}`,
  preview: (groupId: string, sha256Hex: string) => `groups/${groupId}/prev/${sha256Hex}.jpg`,
  thumb: (groupId: string, sha256Hex: string) => `groups/${groupId}/thumb/${sha256Hex}.webp`,
  faceCrop: (groupId: string, faceId: string) => `groups/${groupId}/face/${faceId}.jpg`,
  video720: (groupId: string, sha256Hex: string) => `groups/${groupId}/video/${sha256Hex}/720.mp4`,
  poster: (groupId: string, sha256Hex: string) => `groups/${groupId}/video/${sha256Hex}/poster.jpg`,
  frame: (groupId: string, sha256Hex: string, i: number) => `groups/${groupId}/video/${sha256Hex}/f${i}.jpg`,
} as const;
