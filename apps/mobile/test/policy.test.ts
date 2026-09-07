import { describe, it, expect } from 'vitest';
import { decide } from '@/sync/policy';
import { defaultSettings } from '@/store/settings';

const policy = defaultSettings().policy;
const photo = { isVideo: false, size: 3_000_000 };
const bigVideo = { isVideo: true, size: 700 * 1024 * 1024 };

describe('upload policy (§4.3)', () => {
  it('offline uploads nothing', () => expect(decide({ online: false, wifi: false, charging: false }, policy, photo)).toMatchObject({ allowPreview: false, allowOriginal: false, reason: 'offline' }));
  it('previews on cellular by default, originals wait for wifi + charging', () => {
    expect(decide({ online: true, wifi: false, charging: false }, policy, photo)).toMatchObject({ allowPreview: true, allowOriginal: false });
    expect(decide({ online: true, wifi: true, charging: false }, policy, photo)).toMatchObject({ allowPreview: true, allowOriginal: false });
    expect(decide({ online: true, wifi: true, charging: true }, policy, photo)).toMatchObject({ allowPreview: true, allowOriginal: true, reason: null });
  });
  it('previews on cellular can be turned off', () => {
    expect(decide({ online: true, wifi: false, charging: true }, { ...policy, previewsOnCellular: false }, photo)).toMatchObject({ allowPreview: false, reason: 'waiting for Wi-Fi' });
  });
  it('originals policy can be relaxed', () => {
    expect(decide({ online: true, wifi: false, charging: false }, { ...policy, originalsWifiCharging: false }, photo).allowOriginal).toBe(true);
  });
  it('videos over the cap get a preview but never an original; videos can be excluded entirely', () => {
    const d = decide({ online: true, wifi: true, charging: true }, policy, bigVideo);
    expect(d.allowPreview).toBe(true); expect(d.allowOriginal).toBe(false); expect(d.reason).toMatch(/cap/);
    expect(decide({ online: true, wifi: true, charging: true }, { ...policy, includeVideos: false }, bigVideo)).toMatchObject({ allowPreview: false, allowOriginal: false });
  });
});
