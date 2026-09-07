import * as chrono from 'chrono-node';
import type { SearchQuery, SearchChip } from '@minnegela/shared';

export type ParserPerson = { id: number; name: string; aliases?: string[] };
export type ParseInput = {
  people: ParserPerson[];
  /** The caller's linked person, for "me" / "meg". */
  mePersonId: number | null;
  now?: Date;
  /** Trigram match of leftover text against visible event titles; null when nothing scores ≥ 0.35. */
  matchEventTitle?: (text: string) => Promise<{ id: string; title: string; score: number } | null>;
  mode?: 'events' | 'media';
};
export type ParseResult = { query: SearchQuery; chips: SearchChip[] };

/** Norwegian → English token rewrites applied before chrono runs (token-aligned so consumed spans map back). */
const NO_WORD: Record<string, string> = {
  januar: 'january', februar: 'february', mars: 'march', mai: 'may', juni: 'june', juli: 'july', oktober: 'october', desember: 'december',
  mandag: 'monday', tirsdag: 'tuesday', onsdag: 'wednesday', torsdag: 'thursday', fredag: 'friday', lørdag: 'saturday', søndag: 'sunday',
  sommeren: 'summer', sommer: 'summer', vinteren: 'winter', vinter: 'winter', høsten: 'autumn', høst: 'autumn', våren: 'spring', vår: 'spring',
  igår: 'yesterday', idag: 'today',
};
const NO_PHRASE: Array<[string[], string[]]> = [
  [['i', 'fjor', 'sommer'], ['last', 'summer']], [['i', 'fjor', 'vinter'], ['last', 'winter']], [['i', 'fjor'], ['last', 'year']],
  [['i', 'sommer'], ['this', 'summer']], [['i', 'går'], ['yesterday']], [['i', 'dag'], ['today']],
  [['forrige', 'uke'], ['last', 'week']], [['forrige', 'måned'], ['last', 'month']], [['forrige', 'helg'], ['last', 'weekend']],
];
const MONTHS = new Set(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);
const GLUE = new Set(['and', 'og', 'with', 'med', 'the', 'a', 'in', 'at', 'på', 'i', 'from', 'fra', 'of', 'me', 'meg', 'jeg', 'my', 'min', 'mine', 'photos', 'photo', 'pictures', 'bilder', 'bilde', 'videos', 'video', 'videoer']);
const SEASONS: Record<string, [number, number]> = { spring: [2, 5], summer: [5, 8], autumn: [8, 11], fall: [8, 11], winter: [11, 14] };

function seasonRange(word: string, year: number): { from: Date; to: Date } {
  const [m0, m1] = SEASONS[word]!;
  return { from: new Date(Date.UTC(year, m0, 1)), to: new Date(Date.UTC(year, m1, 1)) };
}

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Deterministic natural-language → SearchQuery. §12.2. */
export async function parseQuery(raw: string, input: ParseInput): Promise<ParseResult> {
  const now = input.now ?? new Date();
  const chips: SearchChip[] = [];
  const query: SearchQuery = { mode: input.mode ?? 'events' };
  let text = ` ${raw.trim().replace(/\s+/g, ' ')} `;
  const consume = (start: number, len: number) => { text = text.slice(0, start) + ' '.repeat(len) + text.slice(start + len); };

  // 1. people (longest names first so "Emma S" beats "Emma"); explicit person:<id> tokens from the UI first
  const found: Array<{ id: number; n: string; at: number; text: string }> = [];
  for (const m of [...text.matchAll(/(?<=\s)person:(\d+)(?=[\s,.!?])/gi)]) {
    const id = Number(m[1]);
    const p = input.people.find((x) => x.id === id);
    if (!found.some((f) => f.id === id)) found.push({ id, n: p?.name ?? `#${id}`, at: m.index, text: m[0] });
  }
  for (const f of found) consume(f.at, f.text.length);
  const candidates = input.people.flatMap((p) => [p.name, ...(p.aliases ?? [])].filter(Boolean).map((n) => ({ id: p.id, n })));
  candidates.sort((a, b) => b.n.length - a.n.length);
  for (const c of candidates) {
    const m = new RegExp(`(?<=\\s)${escapeRe(c.n)}(?=[\\s,.!?])`, 'i').exec(text);
    if (m && !found.some((f) => f.id === c.id)) { found.push({ id: c.id, n: c.n, at: m.index, text: m[0] }); consume(m.index, m[0].length); }
  }
  const me = /(?<=\s)(me|meg|jeg|myself)(?=[\s,.!?])/i.exec(text);
  if (me && input.mePersonId !== null && !found.some((f) => f.id === input.mePersonId)) { found.push({ id: input.mePersonId, n: 'me', at: me.index, text: me[0] }); consume(me.index, me[0].length); }
  found.sort((a, b) => a.at - b.at);
  for (const f of found) chips.push({ kind: 'person', label: f.n, value: f.id, text: f.text });
  const all = found.map((f) => f.id);
  if (all.length) query.people = { all };

  // 2. media type
  const vid = /(?<=\s)(videos?|videoer|film(er)?)(?=[\s,.!?])/i.exec(text);
  if (vid) { query.mediaType = 'video'; chips.push({ kind: 'type', label: 'videos', value: 'video', text: vid[0] }); consume(vid.index, vid[0].length); }

  // 3. time: tokenize, rewrite Norwegian → English keeping a map back to the original spans
  type Tok = { start: number; len: number; en: string };
  const toks: Tok[] = [];
  for (const m of text.matchAll(/\S+/g)) toks.push({ start: m.index, len: m[0].length, en: m[0].toLowerCase().replace(/^[,.!?]+|[,.!?]+$/g, '') });
  const enToks: Array<{ words: string[]; orig: Tok[] }> = [];
  for (let i = 0; i < toks.length; ) {
    const phrase = NO_PHRASE.find(([no]) => no.every((w, k) => toks[i + k]?.en === w));
    if (phrase) { enToks.push({ words: phrase[1], orig: toks.slice(i, i + phrase[0].length) }); i += phrase[0].length; continue; }
    const t = toks[i]!;
    let w = NO_WORD[t.en] ?? t.en;
    const next = toks[i + 1]?.en;
    if ((t.en === 'i' || t.en === 'på') && next && (MONTHS.has(NO_WORD[next] ?? next) || /^\d{4}$/.test(next))) w = 'in';
    enToks.push({ words: [w], orig: [t] });
    i++;
  }
  const enSpans: Array<{ s: number; e: number; orig: Tok[] }> = [];
  let en = '';
  for (const et of enToks) { const s0 = en.length; en += et.words.join(' ') + ' '; enSpans.push({ s: s0, e: en.length - 1, orig: et.orig }); }
  const consumeEn = (s0: number, e0: number, dropPreposition = true) => {
    const hit = enSpans.filter((sp) => sp.s < e0 && sp.e > s0);
    const first = enSpans.indexOf(hit[0]!);
    const before = enSpans[first - 1];
    if (dropPreposition && before && ['in', 'i', 'på', 'at', 'on', 'during'].includes(before.orig.map((o) => o.en).join(' '))) hit.unshift(before);
    for (const sp of hit) for (const o of sp.orig) consume(o.start, o.len);
    return hit.flatMap((sp) => sp.orig).map((o) => text.slice(o.start, o.start + o.len)).join(' ').trim();
  };
  const setTime = (from: Date, to: Date, label: string, consumed: string) => {
    query.time = { from, to };
    chips.push({ kind: 'time', label, value: { from: from.toISOString(), to: to.toISOString() }, text: consumed });
  };

  const season = /(?:^|\s)((?:last|this)\s+)?(summer|winter|spring|autumn|fall)(?:\s+(\d{4}))?(?=\s|$)/i.exec(en);
  const bareYear = /(?:^|\s)((?:19|20)\d{2})(?=\s|$)/.exec(en);
  if (season) {
    const word = season[2]!.toLowerCase();
    let year = season[3] ? Number(season[3]) : now.getUTCFullYear();
    if (!season[3] && (season[1]?.trim().toLowerCase() === 'last' || seasonRange(word, year).from > now)) year -= 1;
    const rng = seasonRange(word, year);
    const s0 = season.index + (season[0].startsWith(' ') ? 1 : 0);
    const consumed = consumeEn(s0, season.index + season[0].length);
    setTime(rng.from, rng.to, `${word} ${year}`, consumed);
  } else {
    const [res] = chrono.parse(en, now, { forwardDate: false });
    if (res) {
      const st = res.start;
      let from: Date, to: Date, label: string;
      if (!st.isCertain('day') && st.isCertain('month')) {
        let y = st.get('year')!; const m = st.get('month')! - 1;
        if (!st.isCertain('year') && Date.UTC(y, m, 1) > now.getTime()) y -= 1;
        from = new Date(Date.UTC(y, m, 1)); to = new Date(Date.UTC(y, m + 1, 1));
        label = from.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      } else if (!st.isCertain('month') && st.isCertain('year')) {
        from = new Date(Date.UTC(st.get('year')!, 0, 1)); to = new Date(Date.UTC(st.get('year')! + 1, 0, 1)); label = String(st.get('year'));
      } else {
        const d = st.date(); from = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        to = res.end ? res.end.date() : new Date(from.getTime() + 86_400_000);
        label = res.end ? `${from.toISOString().slice(0, 10)} – ${to.toISOString().slice(0, 10)}` : from.toISOString().slice(0, 10);
      }
      const consumed = consumeEn(res.index, res.index + res.text.length);
      setTime(from, to, label, consumed);
    } else if (bareYear) {
      const y = Number(bareYear[1]);
      const s0 = bareYear.index + (bareYear[0].startsWith(' ') ? 1 : 0);
      const consumed = consumeEn(s0, bareYear.index + bareYear[0].length);
      setTime(new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y + 1, 0, 1)), String(y), consumed);
    }
  }

  // 4. leftover words, minus glue
  const leftover = text.split(/\s+/).map((w) => w.replace(/^[,.!?]+|[,.!?]+$/g, '')).filter((w) => w && !GLUE.has(w.toLowerCase()));
  const remainder = leftover.join(' ');

  // 5. event title
  if (remainder.length >= 3 && input.matchEventTitle) {
    const hit = await input.matchEventTitle(remainder);
    if (hit) {
      query.eventId = hit.id;
      chips.push({ kind: 'event', label: hit.title, value: hit.id, text: remainder });
      query.mode = input.mode ?? 'media';
      return { query, chips };
    }
  }

  // 6. remaining text → semantic (media mode)
  if (remainder) {
    query.semantic = remainder;
    chips.push({ kind: 'semantic', label: remainder, value: remainder, text: remainder });
    query.mode = input.mode ?? 'media';
  } else if (query.mediaType) {
    query.mode = input.mode ?? 'media';
  }
  return { query, chips };
}
