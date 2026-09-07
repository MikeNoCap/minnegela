import { z } from 'zod';

/** Job kinds consumed from the Postgres `jobs` table. Node and Python workers share this contract. */
export const JobKind = z.enum(['derive', 'analyze', 'identify', 'dedupe', 'recluster', 'titles', 'reconcile_staging', 'hard_delete', 'export']);
export type JobKind = z.infer<typeof JobKind>;

/** Which worker consumes which kind. Used by the consumers to build their claim query. */
export const JOB_OWNER: Record<JobKind, 'media' | 'ml'> = {
  derive: 'media',
  dedupe: 'media',
  titles: 'media',
  reconcile_staging: 'media',
  hard_delete: 'media',
  export: 'media',
  analyze: 'ml',
  identify: 'ml',
  recluster: 'ml',
};

export const JobPayloads = {
  derive: z.object({ blobId: z.string().uuid(), groupId: z.string().uuid(), kind: z.enum(['preview', 'original']), stagingKey: z.string() }),
  analyze: z.object({ blobId: z.string().uuid(), groupId: z.string().uuid() }),
  identify: z.object({ groupId: z.string().uuid(), blobId: z.string().uuid().optional(), personId: z.number().int().optional() }),
  dedupe: z.object({ blobId: z.string().uuid(), groupId: z.string().uuid() }),
  recluster: z.object({ groupId: z.string().uuid(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), full: z.boolean().optional() }),
  titles: z.object({ groupId: z.string().uuid(), eventIds: z.array(z.string().uuid()).optional() }),
  reconcile_staging: z.object({ groupId: z.string().uuid().optional() }),
  hard_delete: z.object({ assetId: z.string().uuid() }),
  export: z.object({ userId: z.string().uuid(), groupId: z.string().uuid() }),
} satisfies Record<JobKind, z.ZodTypeAny>;

export type JobPayload<K extends JobKind> = z.infer<(typeof JobPayloads)[K]>;

/** Debounce key for jobs that should coalesce (recluster per group, identify per group). */
export function jobDedupeKey(kind: JobKind, payload: Record<string, unknown>): string | null {
  switch (kind) {
    case 'recluster':
      return `recluster:${payload.groupId}`;
    case 'identify':
      return payload.blobId ? null : `identify:${payload.groupId}`;
    case 'titles':
      return payload.eventIds ? null : `titles:${payload.groupId}`;
    default:
      return null;
  }
}
