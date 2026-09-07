/**
 * Incremental SHA-256 in plain JS so originals of hundreds of MB can be hashed in 4 MB chunks
 * without holding the whole file in memory (expo-crypto's digest() is one-shot). ~1.5 MB/s on Hermes
 * is fine for background windows; previews (300 KB) are instant.
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;
  private w = new Uint32Array(64);

  update(data: Uint8Array): this {
    let i = 0;
    this.total += data.length;
    if (this.bufLen) {
      const take = Math.min(64 - this.bufLen, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen); this.bufLen += take; i = take;
      if (this.bufLen === 64) { this.block(this.buf, 0); this.bufLen = 0; }
    }
    for (; i + 64 <= data.length; i += 64) this.block(data, i);
    if (i < data.length) { this.buf.set(data.subarray(i), 0); this.bufLen = data.length - i; }
    return this;
  }
  hex(): string {
    const bits = this.total * 8;
    const pad = new Uint8Array(((this.bufLen + 8) >> 6 << 6) + 64 - this.bufLen);
    pad[0] = 0x80;
    const dv = new DataView(pad.buffer);
    dv.setUint32(pad.length - 8, Math.floor(bits / 0x100000000));
    dv.setUint32(pad.length - 4, bits >>> 0);
    this.update(pad);
    return Array.from(this.h, (x) => x.toString(16).padStart(8, '0')).join('');
  }
  private block(p: Uint8Array, off: number) {
    const w = this.w;
    for (let i = 0; i < 16; i++) w[i] = ((p[off + i * 4]! << 24) | (p[off + i * 4 + 1]! << 16) | (p[off + i * 4 + 2]! << 8) | p[off + i * 4 + 3]!) >>> 0;
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.h as unknown as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    this.h[0] = (this.h[0]! + a) >>> 0; this.h[1] = (this.h[1]! + b) >>> 0; this.h[2] = (this.h[2]! + c) >>> 0; this.h[3] = (this.h[3]! + d) >>> 0;
    this.h[4] = (this.h[4]! + e) >>> 0; this.h[5] = (this.h[5]! + f) >>> 0; this.h[6] = (this.h[6]! + g) >>> 0; this.h[7] = (this.h[7]! + h) >>> 0;
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Uint8Array(256);
for (let i = 0; i < B64.length; i++) LOOKUP[B64.charCodeAt(i)] = i;
LOOKUP['-'.charCodeAt(0)] = 62; LOOKUP['_'.charCodeAt(0)] = 63;

/** base64 → bytes without Buffer/atob (Hermes-safe, and chunkable as long as chunks are multiples of 4 chars). */
export function base64ToBytes(s: string): Uint8Array {
  let len = s.length;
  while (len > 0 && s[len - 1] === '=') len--;
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0, i = 0;
  for (; i + 4 <= len; i += 4) {
    const n = (LOOKUP[s.charCodeAt(i)]! << 18) | (LOOKUP[s.charCodeAt(i + 1)]! << 12) | (LOOKUP[s.charCodeAt(i + 2)]! << 6) | LOOKUP[s.charCodeAt(i + 3)]!;
    out[o++] = (n >> 16) & 255; out[o++] = (n >> 8) & 255; out[o++] = n & 255;
  }
  if (i < len) {
    const rem = len - i;
    const n = (LOOKUP[s.charCodeAt(i)]! << 18) | (LOOKUP[s.charCodeAt(i + 1)]! << 12) | (rem > 2 ? LOOKUP[s.charCodeAt(i + 2)]! << 6 : 0);
    out[o++] = (n >> 16) & 255;
    if (rem > 2) out[o++] = (n >> 8) & 255;
  }
  return out.subarray(0, o);
}

export function sha256Hex(bytes: Uint8Array): string {
  return new Sha256().update(bytes).hex();
}
