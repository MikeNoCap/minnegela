import sharp from 'sharp';

/** §6.4 cheap quality features: Laplacian variance (sharpness) and mean luminance (exposure), on a 320-px gray copy. */
export async function quality(input: Buffer | string): Promise<{ sharpness: number; exposure: number }> {
  const { data, info } = await sharp(input).autoOrient().grayscale().resize(320, 320, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  let sum = 0, sumSq = 0, n = 0, lum = 0;
  for (let i = 0; i < data.length; i++) lum += data[i]!;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const lap = 4 * data[i]! - data[i - 1]! - data[i + 1]! - data[i - w]! - data[i + w]!;
    sum += lap; sumSq += lap * lap; n++;
  }
  const mean = n ? sum / n : 0;
  const variance = n ? sumSq / n - mean * mean : 0;
  return { sharpness: Math.round(variance * 100) / 100, exposure: Math.round((lum / data.length / 255) * 1000) / 1000 };
}
