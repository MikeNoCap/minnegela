import { initials } from '@/lib/format';

const HUES = [255, 20, 140, 200, 300, 40, 170, 330];
function hue(seed: string | number) { let h = 0; for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return HUES[h % HUES.length]; }

export function Avatar({ name, seed, size = 22, title }: { name: string | null | undefined; seed?: string | number; size?: number; title?: string }) {
  const h = hue(seed ?? name ?? '?');
  return (
    <span
      title={title ?? name ?? undefined}
      className="inline-flex items-center justify-center rounded-full font-medium shrink-0 select-none"
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.42), background: `hsl(${h} 45% 88%)`, color: `hsl(${h} 45% 30%)` }}
    >
      {initials(name)}
    </span>
  );
}

export function AvatarStack({ people, max = 5, size = 22 }: { people: Array<{ id: string | number; name: string | null }>; max?: number; size?: number }) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <span className="inline-flex items-center">
      {shown.map((p, i) => (
        <span key={p.id} style={{ marginLeft: i ? -size * 0.3 : 0, zIndex: shown.length - i }} className="ring-2 ring-surface rounded-full">
          <Avatar name={p.name} seed={p.id} size={size} />
        </span>
      ))}
      {rest > 0 && <span className="ml-1 text-xs text-ink-3">+{rest}</span>}
    </span>
  );
}
