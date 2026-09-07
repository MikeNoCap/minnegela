import { sql, type Tx } from '@minnegela/db';

/** CLIP text embedding via the ML worker's tiny HTTP endpoint (§12.5), cached in search_text_cache. */
export async function textEmbedding(tx: Tx, url: string | undefined, text: string, log?: { warn: (o: unknown, m: string) => void }): Promise<number[] | null> {
  const key = text.trim().toLowerCase();
  const [hit] = (await tx.execute(sql`select emb::text as emb from search_text_cache where query = ${key}`)) as unknown as Array<{ emb: string }>;
  if (hit) return JSON.parse(hit.emb) as number[];
  if (!url) return null;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 3000);
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: key }), signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const body = (await res.json()) as { embedding: number[]; model?: string };
    if (!Array.isArray(body.embedding) || body.embedding.length !== 512) return null;
    await tx.execute(sql`insert into search_text_cache (query, model, emb) values (${key}, ${body.model ?? 'unknown'}, ${`[${body.embedding.join(',')}]`}::vector) on conflict (query) do nothing`);
    return body.embedding;
  } catch (e) {
    log?.warn({ err: e }, 'text embedding unavailable');
    return null;
  }
}
