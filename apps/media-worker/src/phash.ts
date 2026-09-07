import sharp from 'sharp';

/**
 * 64-bit DCT perceptual hash (§14): 32×32 grayscale → 2-D DCT → top-left 8×8 (minus DC) vs median.
 * Returned as a 64-char '0'/'1' string, which is what Postgres bit(64) accepts.
 */
export async function phash(input: Buffer | string): Promise<string> {
  const { data } = await sharp(input).autoOrient().grayscale().resize(32, 32, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true });
  const N = 32;
  const px = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) px[i] = data[i]!;
  // separable DCT-II, only the first 8 rows/cols are needed
  const cos = new Float64Array(8 * N);
  for (let u = 0; u < 8; u++) for (let x = 0; x < N; x++) cos[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
  const rows = new Float64Array(N * 8); // rows[y][u]
  for (let y = 0; y < N; y++) for (let u = 0; u < 8; u++) {
    let s = 0;
    for (let x = 0; x < N; x++) s += px[y * N + x]! * cos[u * N + x]!;
    rows[y * 8 + u] = s;
  }
  const dct = new Float64Array(64); // dct[v][u]
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
    let s = 0;
    for (let y = 0; y < N; y++) s += rows[y * 8 + u]! * cos[v * N + y]!;
    dct[v * 8 + u] = s;
  }
  const vals = Array.from(dct).slice(1); // drop DC
  const sorted = [...vals].sort((a, b) => a - b);
  const median = (sorted[31]! + sorted[32]!) / 2;
  let bits = '';
  for (let i = 0; i < 64; i++) bits += (i === 0 ? dct[0]! > median : dct[i]! > median) ? '1' : '0';
  return bits;
}

export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}
