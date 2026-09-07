import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { PREVIEW } from '@minnegela/shared';

/** §4.3: what the phone does. JPEG, long edge 1600 px, q82, orientation applied, metadata copied (EXIF survives). */
export async function makePreview(input: Buffer | string): Promise<Buffer> {
  return sharp(input).autoOrient().resize(PREVIEW.longEdgePx, PREVIEW.longEdgePx, { fit: 'inside', withoutEnlargement: true }).keepExif().jpeg({ quality: PREVIEW.jpegQuality, mozjpeg: true }).toBuffer();
}

/** Video "preview" = the poster frame at ~1 s, as the phone would send from expo-video-thumbnails. */
export async function makeVideoPoster(file: string, ffmpeg = process.env.FFMPEG_BIN ?? 'ffmpeg'): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mn-cli-'));
  const out = path.join(dir, 'poster.jpg');
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(ffmpeg, ['-v', 'error', '-y', '-ss', '1', '-i', file, '-frames:v', '1', '-q:v', '3', out], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err}`))));
    });
    return makePreview(await readFile(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
