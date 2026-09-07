import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import type { SyncDeps } from './types';
import { runSync } from './runner';

export const SYNC_TASK = 'minnegela-sync';

/**
 * §16.4: iOS BGProcessingTask / Android WorkManager. The OS decides when; we promise ≤ 25 s of work
 * per run. Uploads handed to the background URLSession keep going after we return.
 */
let depsFactory: (() => Promise<SyncDeps | null>) | null = null;
export function setBackgroundDeps(factory: () => Promise<SyncDeps | null>) { depsFactory = factory; }

TaskManager.defineTask(SYNC_TASK, async () => {
  try {
    const deps = depsFactory ? await depsFactory() : null;
    if (!deps) return BackgroundTask.BackgroundTaskResult.Success;
    await runSync(deps, { budgetMs: 25_000, maxItems: 100 });
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundSync(): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Restricted) return;
    if (!(await TaskManager.isTaskRegisteredAsync(SYNC_TASK))) await BackgroundTask.registerTaskAsync(SYNC_TASK, { minimumInterval: 15 });
  } catch { /* unavailable in Expo Go or on web */ }
}
