import { randomUUID } from 'node:crypto';
import { sql, eq, and, ne, isNotNull, inArray, blobs, assets } from '@minnegela/db';
import { DEDUPE, JobPayloads } from '@minnegela/shared';
import type { Ctx } from '../context.js';
import { hamming } from '../phash.js';

type P = ReturnType<typeof JobPayloads.dedupe.parse>;
type Row = { id: string; phash: string | null; width: number | null; height: number | null; sizeBytes: number | null; capturedAt: Date | null; exif: Record<string, unknown> | null; nearDupGroupId: string | null; variantOf: string | null };

const hasExifDate = (r: Row) => !!(r.exif && (r.exif.DateTimeOriginal || r.exif.CreateDate));
const pixels = (r: Row) => (r.width ?? 0) * (r.height ?? 0);
const aspect = (r: Row) => (r.width && r.height ? r.width / r.height : 0);

/** Pure decision function, unit-tested. Returns the relation between two blobs. */
export function classifyPair(a: Row, b: Row, sameOwner: boolean): 'reencoded' | 'burst' | null {
  if (!a.phash || !b.phash) return null;
  const d = hamming(a.phash, b.phash);
  const dt = a.capturedAt && b.capturedAt ? Math.abs(a.capturedAt.getTime() - b.capturedAt.getTime()) : Infinity;
  const ar = aspect(a), br = aspect(b);
  const sameAspect = ar > 0 && br > 0 && Math.abs(ar - br) / Math.max(ar, br) <= 0.01;
  if (d <= DEDUPE.reencodedMaxHamming && sameAspect && (dt <= 24 * 3600_000 || !hasExifDate(a) || !hasExifDate(b))) return 'reencoded';
  if (d <= DEDUPE.burstMaxHamming && sameOwner && dt <= DEDUPE.burstMaxSeconds * 1000) return 'burst';
  return null;
}

/** §14: exact duplicates are handled in derive; this pass links re-encoded copies and bursts by pHash. */
export async function dedupe(ctx: Ctx, payload: P): Promise<void> {
  const { db, log } = ctx;
  const [me] = await db.select().from(blobs).where(eq(blobs.id, payload.blobId));
  if (!me || !me.phash) return;
  // §14 allows re-encoded copies up to 24 h apart (a WhatsApp save lands the next morning), so scan a day, not an hour
  const windowMs = Math.max(DEDUPE.neighbourWindowHours, 24) * 3600_000;
  const t = me.capturedAt ?? me.createdAt;
  const cand = await db.select().from(blobs).where(and(
    eq(blobs.groupId, payload.groupId), ne(blobs.id, me.id), isNotNull(blobs.phash), isNotNull(blobs.derivedAt),
    // raw sql params must be ISO strings: drizzle's postgres-js driver passes Date objects through unserialized
    sql`coalesce(${blobs.capturedAt}, ${blobs.createdAt}) between ${new Date(t.getTime() - windowMs).toISOString()}::timestamptz and ${new Date(t.getTime() + windowMs).toISOString()}::timestamptz`,
  ));
  if (!cand.length) return;
  const ids = [me.id, ...cand.map((c) => c.id)];
  const owners = await db.select({ blobId: assets.blobId, owner: assets.ownerUserId }).from(assets).where(inArray(assets.blobId, ids));
  const ownersOf = (id: string) => new Set(owners.filter((o) => o.blobId === id).map((o) => o.owner));
  const mine = ownersOf(me.id);

  for (const other of cand) {
    const sameOwner = [...ownersOf(other.id)].some((o) => mine.has(o));
    const rel = classifyPair(me, other, sameOwner);
    if (rel === 'reencoded') {
      // keep the higher-quality bytes; the other becomes a variant pointer (its owner still has the file on the phone)
      const meBetter = pixels(me) > pixels(other) || (pixels(me) === pixels(other) && (me.sizeBytes ?? 0) >= (other.sizeBytes ?? 0));
      const [keep, variant] = meBetter ? [me, other] : [other, me];
      if (variant.variantOf !== keep.id && keep.variantOf !== variant.id) {
        await db.update(blobs).set({ variantOf: keep.id }).where(eq(blobs.id, variant.id));
        log.info({ keep: keep.id, variant: variant.id }, 'dedupe: re-encoded copy linked');
      }
    } else if (rel === 'burst') {
      const gid = other.nearDupGroupId ?? me.nearDupGroupId ?? randomUUID();
      await db.update(blobs).set({ nearDupGroupId: gid }).where(inArray(blobs.id, [me.id, other.id]));
      me.nearDupGroupId = gid;
    }
  }
}
