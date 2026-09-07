import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Sha256, sha256Hex, base64ToBytes } from '@/sync/hash';

describe('incremental sha256 + base64', () => {
  it('matches node for known vectors', () => {
    expect(sha256Hex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('is chunk-order independent on a 1 MB random buffer', () => {
    const buf = new Uint8Array(1_000_003); for (let i = 0; i < buf.length; i++) buf[i] = (i * 7919 + 13) & 255;
    const expected = createHash('sha256').update(buf).digest('hex');
    const h = new Sha256(); for (let p = 0; p < buf.length; p += 65_521) h.update(buf.subarray(p, p + 65_521));
    expect(h.hex()).toBe(expected);
  });
  it('decodes base64 with and without padding', () => {
    for (const s of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar', 'hello world!!']) {
      const b64 = Buffer.from(s).toString('base64');
      expect(Buffer.from(base64ToBytes(b64)).toString()).toBe(s);
      expect(Buffer.from(base64ToBytes(b64.replace(/=+$/, ''))).toString()).toBe(s);
    }
  });
});
