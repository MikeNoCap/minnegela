import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { phash, hamming } from '../src/phash.js';
import { makePhoto } from './fixtures.js';

describe('pHash', () => {
  it('is stable under resize and re-encoding', async () => {
    const orig = await makePhoto(1);
    const small = await sharp(orig).resize(800).jpeg({ quality: 60 }).toBuffer();
    const webp = await sharp(orig).resize(1280).webp({ quality: 50 }).toBuffer();
    const h0 = await phash(orig), h1 = await phash(small), h2 = await phash(webp);
    expect(h0).toHaveLength(64);
    expect(hamming(h0, h1)).toBeLessThanOrEqual(4);
    expect(hamming(h0, h2)).toBeLessThanOrEqual(4);
  });
  it('separates different images', async () => {
    const hs = await Promise.all([1, 2, 3, 4, 5].map(async (s) => phash(await makePhoto(s))));
    for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) expect(hamming(hs[i]!, hs[j]!)).toBeGreaterThan(10);
  });
});
