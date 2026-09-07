import type { Settings } from '@/store/settings';

export type Conditions = { online: boolean; wifi: boolean; charging: boolean };
export type PolicyDecision = { allowPreview: boolean; allowOriginal: boolean; reason: string | null };

/** §4.3 upload policy. Pure so it is unit-testable. */
export function decide(c: Conditions, policy: Settings['policy'], asset: { isVideo: boolean; size: number }): PolicyDecision {
  if (!c.online) return { allowPreview: false, allowOriginal: false, reason: 'offline' };
  if (asset.isVideo && !policy.includeVideos) return { allowPreview: false, allowOriginal: false, reason: 'videos disabled' };
  const allowPreview = c.wifi || policy.previewsOnCellular;
  let allowOriginal = true;
  let reason: string | null = allowPreview ? null : 'waiting for Wi-Fi';
  if (policy.originalsWifiCharging && !(c.wifi && c.charging)) { allowOriginal = false; reason = reason ?? 'originals wait for Wi-Fi and charging'; }
  if (asset.isVideo && asset.size > policy.videosMaxMb * 1024 * 1024) { allowOriginal = false; reason = reason ?? `video over ${policy.videosMaxMb} MB cap`; }
  return { allowPreview, allowOriginal, reason };
}
