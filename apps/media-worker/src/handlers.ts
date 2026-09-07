import { JobPayloads, type JobKind } from '@minnegela/shared';
import type { Ctx } from './context.js';
import { derive } from './jobs/derive.js';
import { dedupe } from './jobs/dedupe.js';
import { titles } from './jobs/titles.js';
import { reconcileStaging } from './jobs/reconcile-staging.js';
import { hardDelete } from './jobs/hard-delete.js';
import { exportUser } from './jobs/export.js';

export const MEDIA_KINDS = ['derive', 'dedupe', 'titles', 'reconcile_staging', 'hard_delete', 'export'] as const satisfies readonly JobKind[];

export async function handle(ctx: Ctx, kind: JobKind, payload: Record<string, unknown>): Promise<void> {
  switch (kind) {
    case 'derive': return derive(ctx, JobPayloads.derive.parse(payload));
    case 'dedupe': return dedupe(ctx, JobPayloads.dedupe.parse(payload));
    case 'titles': return titles(ctx, JobPayloads.titles.parse(payload));
    case 'reconcile_staging': return reconcileStaging(ctx, JobPayloads.reconcile_staging.parse(payload));
    case 'hard_delete': return hardDelete(ctx, JobPayloads.hard_delete.parse(payload));
    case 'export': { await exportUser(ctx, JobPayloads.export.parse(payload)); return; }
    default: throw new Error(`media-worker does not handle job kind ${kind}`);
  }
}
