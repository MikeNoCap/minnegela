import { describe, it, expect } from 'vitest';
import { pathFrom, exifHintFrom } from '@/sync/provenance';

describe('provenance signals (§7.4)', () => {
  it('keeps Android file paths and drops platform handles', () => {
    expect(pathFrom('file:///storage/emulated/0/DCIM/Camera/IMG_1.jpg')).toBe('/storage/emulated/0/DCIM/Camera/IMG_1.jpg');
    expect(pathFrom('file:///storage/emulated/0/Pictures/Snapchat/Snapchat-1%20(1).jpg')).toBe('/storage/emulated/0/Pictures/Snapchat/Snapchat-1 (1).jpg');
    expect(pathFrom('ph://ABC/L0/001')).toBeNull();
    expect(pathFrom('content://media/external/images/media/12')).toBeNull();
  });
  it('reads Android flat keys and iOS nested dictionaries', () => {
    expect(exifHintFrom({ Make: 'Google', Model: 'Pixel 8', DateTimeOriginal: '2026:07:08 20:19:26', OffsetTimeOriginal: '+02:00' }))
      .toEqual({ make: 'Google', model: 'Pixel 8', dateTimeOriginal: '2026:07:08 20:19:26', offset: '+02:00' });
    expect(exifHintFrom({ '{TIFF}': { Make: 'Apple', Model: 'iPhone 15', Software: '17.5' }, '{Exif}': { DateTimeOriginal: '2026:07:08 21:13:09' } }))
      .toEqual({ make: 'Apple', model: 'iPhone 15', software: '17.5', dateTimeOriginal: '2026:07:08 21:13:09' });
    expect(exifHintFrom({ ImageWidth: 1080, Orientation: 1 })).toBeNull();
    expect(exifHintFrom(null)).toBeNull();
  });
});
