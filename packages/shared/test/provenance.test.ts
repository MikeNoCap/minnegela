import { describe, it, expect } from 'vitest';
import { classifyOrigin } from '../src/provenance.js';

const base = { mime: 'image/jpeg', hasGps: false, albums: [] as string[] };

describe('classifyOrigin', () => {
  it('Android camera folder is camera even without GPS', () => {
    expect(classifyOrigin({ ...base, filename: 'IMG_20250705_003332090.jpg', albums: ['Camera'] })).toBe('camera');
    expect(classifyOrigin({ ...base, filename: 'VID_20250705_003332090.mp4', mime: 'video/mp4', path: '/storage/emulated/0/DCIM/Camera/VID_20250705_003332090.mp4' })).toBe('camera');
  });
  it('Snapchat / WhatsApp / downloads are received, whatever folder they sit in', () => {
    expect(classifyOrigin({ ...base, filename: 'Snapchat-227822819.jpg', albums: ['Snapchat'] })).toBe('received');
    expect(classifyOrigin({ ...base, filename: 'Snapchat-283471956.mp4', mime: 'video/mp4', albums: ['Camera'] })).toBe('received');
    expect(classifyOrigin({ ...base, filename: 'IMG-20240101-WA0001.jpg', albums: ['WhatsApp Images'] })).toBe('received');
    expect(classifyOrigin({ ...base, filename: 'images (3).jpeg', albums: ['Download'] })).toBe('received');
    expect(classifyOrigin({ ...base, filename: 'fb3d9cb8f2d1db4ececd7c4ac.mp4', mime: 'video/mp4' })).toBe('received');
    expect(classifyOrigin({ ...base, filename: 'abc.webp' })).toBe('received');
    // an AirDropped photo keeps EXIF and GPS, but the Download album wins
    expect(classifyOrigin({ ...base, filename: 'IMG_0042.JPG', albums: ['Download'], hasGps: true })).toBe('received');
  });
  it('iOS: IMG_nnnn alone is unknown; GPS or an EXIF hint makes it camera', () => {
    expect(classifyOrigin({ ...base, filename: 'IMG_3805.JPG' })).toBe('unknown');
    expect(classifyOrigin({ ...base, filename: 'IMG_3805.JPG', hasGps: true })).toBe('camera');
    expect(classifyOrigin({ ...base, filename: 'IMG_3805.JPG', exif: { make: 'Apple', model: 'iPhone 15' } })).toBe('camera');
    expect(classifyOrigin({ ...base, filename: 'IMG_3806.MP4', mime: 'video/mp4' })).toBe('unknown');
  });
  it('screenshots and pngs without camera metadata are screenshots', () => {
    expect(classifyOrigin({ ...base, filename: 'Screenshot_20250101-120000.png', mime: 'image/png' })).toBe('screenshot');
    expect(classifyOrigin({ ...base, filename: 'IMG_0001.PNG', mime: 'image/png', isScreenshot: true })).toBe('screenshot');
    expect(classifyOrigin({ ...base, filename: 'Frame 3.png', mime: 'image/png' })).toBe('screenshot');
  });
  it('editor output is edited', () => {
    expect(classifyOrigin({ ...base, filename: 'lv_0_20250101.mp4', mime: 'video/mp4' })).toBe('edited');
    expect(classifyOrigin({ ...base, filename: 'IMG_20250101_120000.jpg', albums: ['Camera'], exif: { make: 'Google', software: 'Snapseed 2.0' } })).toBe('edited');
  });
  it('user albums and odd names fall through to unknown', () => {
    expect(classifyOrigin({ ...base, filename: 'tilbake_ide_vs_resultat_draft.mp4', mime: 'video/mp4', albums: ['Movies'] })).toBe('unknown');
    expect(classifyOrigin({ ...base, filename: '1.jpg', albums: ['til mikkel'] })).toBe('unknown');
  });
});
