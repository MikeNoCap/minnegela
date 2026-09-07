import sharp from 'sharp';

/** Deterministic synthetic photo: gradient background with a few colored shapes; seed changes the layout. */
export async function makePhoto(seed: number, opts: { width?: number; height?: number; exif?: Record<string, string>; format?: 'jpeg' | 'png' } = {}): Promise<Buffer> {
  const w = opts.width ?? 2400, h = opts.height ?? 1800;
  const rnd = mulberry32(seed);
  const rects = Array.from({ length: 6 }, () => {
    const rw = Math.floor(w * (0.1 + rnd() * 0.3)), rh = Math.floor(h * (0.1 + rnd() * 0.3));
    return `<rect x="${Math.floor(rnd() * (w - rw))}" y="${Math.floor(rnd() * (h - rh))}" width="${rw}" height="${rh}" fill="rgb(${Math.floor(rnd() * 255)},${Math.floor(rnd() * 255)},${Math.floor(rnd() * 255)})" />`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="rgb(${Math.floor(rnd() * 255)},${Math.floor(rnd() * 255)},${Math.floor(rnd() * 255)})"/><stop offset="1" stop-color="rgb(${Math.floor(rnd() * 255)},${Math.floor(rnd() * 255)},${Math.floor(rnd() * 255)})"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>${rects}</svg>`;
  let s = sharp(Buffer.from(svg));
  if (opts.format === 'png') return s.png().toBuffer();
  s = s.jpeg({ quality: 90 });
  if (opts.exif) s = s.withExif({ IFD0: { Make: opts.exif.Make ?? 'Apple', Model: opts.exif.Model ?? 'iPhone 15' }, IFD2: { DateTimeOriginal: opts.exif.DateTimeOriginal ?? '2026:03:14 21:30:00', OffsetTimeOriginal: opts.exif.OffsetTimeOriginal ?? '+01:00' }, ...(opts.exif.lat ? { IFD3: { GPSLatitudeRef: 'N', GPSLatitude: opts.exif.lat, GPSLongitudeRef: 'E', GPSLongitude: opts.exif.lon! } } : {}) } as never);
  return s.toBuffer();
}

function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
