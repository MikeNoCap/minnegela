import { spawn } from 'node:child_process';

export type Probe = { durationMs: number; width: number; height: number; codec: string; creationTime: Date | null; lat: number | null; lon: number | null; rotation: number };

function run(bin: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const t = opts.timeoutMs ? setTimeout(() => p.kill('SIGKILL'), opts.timeoutMs) : null;
    p.on('error', reject);
    p.on('close', (code) => {
      if (t) clearTimeout(t);
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${bin} exited ${code}: ${err.slice(-2000)}`));
    });
  });
}

export async function ffprobe(bin: string, file: string): Promise<Probe> {
  const { stdout } = await run(bin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout) as { format?: Record<string, any>; streams?: Array<Record<string, any>> };
  const v = (j.streams ?? []).find((s) => s.codec_type === 'video') ?? {};
  const tags = { ...(j.format?.tags ?? {}), ...(v.tags ?? {}) } as Record<string, string>;
  const rotation = Number((v.side_data_list ?? []).find((s: any) => s.rotation !== undefined)?.rotation ?? tags.rotate ?? 0) || 0;
  const swap = Math.abs(rotation) % 180 === 90;
  const loc = tags['com.apple.quicktime.location.ISO6709'] ?? tags.location ?? tags['location-eng'];
  let lat: number | null = null, lon: number | null = null;
  const m = loc && /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(loc);
  if (m) { lat = Number(m[1]); lon = Number(m[2]); }
  const ct = tags['com.apple.quicktime.creationdate'] ?? tags.creation_time;
  const creationTime = ct ? new Date(ct) : null;
  return {
    durationMs: Math.round(Number(j.format?.duration ?? v.duration ?? 0) * 1000),
    width: swap ? Number(v.height ?? 0) : Number(v.width ?? 0),
    height: swap ? Number(v.width ?? 0) : Number(v.height ?? 0),
    codec: String(v.codec_name ?? ''),
    creationTime: creationTime && !Number.isNaN(creationTime.getTime()) ? creationTime : null,
    lat, lon, rotation,
  };
}

/** Extract one JPEG frame at `atSeconds`. */
export async function extractFrame(bin: string, file: string, atSeconds: number, out: string): Promise<void> {
  await run(bin, ['-v', 'error', '-y', '-ss', atSeconds.toFixed(3), '-i', file, '-frames:v', '1', '-q:v', '3', out], { timeoutMs: 120_000 });
}

/** 720p H.264 transcode; NVENC on the GPU box (Pascal supports h264_nvenc), libx264 elsewhere. */
export async function transcode720(bin: string, file: string, out: string, nvenc: boolean): Promise<void> {
  const scale = 'scale=-2:min(720\\,ih)';
  const args = ['-v', 'error', '-y', '-i', file, '-vf', scale, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'];
  if (nvenc) args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '26', '-b:v', '0');
  else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  args.push(out);
  await run(bin, args, { timeoutMs: 30 * 60_000 });
}
