import { describe, it, expect } from 'vitest';
import { parseQuery } from '../src/search/parser.js';

const people = [{ id: 1, name: 'Emma' }, { id: 2, name: 'Jonas' }, { id: 3, name: 'Emma S', aliases: [] }, { id: 4, name: 'Mikkel' }];
const now = new Date('2026-09-07T12:00:00Z');

describe('search parser', () => {
  it('people → all, events mode', async () => {
    const r = await parseQuery('Emma and Jonas', { people, mePersonId: 4, now });
    expect(r.query.people).toEqual({ all: [1, 2] });
    expect(r.query.mode).toBe('events');
    expect(r.query.semantic).toBeUndefined();
    expect(r.chips.map((c) => c.kind)).toEqual(['person', 'person']);
  });
  it('longest name wins and "me" maps to the caller', async () => {
    const r = await parseQuery('me with Emma S', { people, mePersonId: 4, now });
    expect(r.query.people?.all).toEqual([4, 3]);   // in order of appearance
  });
  it('Norwegian month: "i mars" → March 2026', async () => {
    const r = await parseQuery('Emma i mars', { people, mePersonId: null, now });
    expect(r.query.people?.all).toEqual([1]);
    expect(r.query.time?.from?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(r.query.time?.to?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(r.query.semantic).toBeUndefined();
  });
  it('"party in March 2025" keeps the semantic remainder', async () => {
    const r = await parseQuery('party in March 2025', { people, mePersonId: null, now });
    expect(r.query.time?.from?.toISOString()).toBe('2025-03-01T00:00:00.000Z');
    expect(r.query.semantic).toBe('party');
    expect(r.query.mode).toBe('media');
  });
  it('"last summer" → previous year season', async () => {
    const r = await parseQuery('beach last summer', { people, mePersonId: null, now });
    expect(r.query.time?.from?.toISOString()).toBe('2025-06-01T00:00:00.000Z');
    expect(r.query.time?.to?.toISOString()).toBe('2025-09-01T00:00:00.000Z');
    expect(r.query.semantic).toBe('beach');
  });
  it('event title match consumes the remainder', async () => {
    const r = await parseQuery("Emma's birthday", { people, mePersonId: null, now, matchEventTitle: async (t) => (t.toLowerCase().includes('birthday') ? { id: '11111111-1111-4111-8111-111111111111', title: "Emma's birthday", score: 0.6 } : null) });
    expect(r.query.eventId).toBe('11111111-1111-4111-8111-111111111111');
    expect(r.chips.find((c) => c.kind === 'event')?.label).toBe("Emma's birthday");
  });
  it('person:<id> tokens from the UI', async () => {
    const r = await parseQuery('person:2 beach', { people, mePersonId: null, now });
    expect(r.query.people?.all).toEqual([2]);
    expect(r.query.semantic).toBe('beach');
  });
  it('videos → media type', async () => {
    const r = await parseQuery('videos with Jonas', { people, mePersonId: null, now });
    expect(r.query.mediaType).toBe('video');
    expect(r.query.people?.all).toEqual([2]);
    expect(r.query.mode).toBe('media');
  });
  it('a year alone → whole year', async () => {
    const r = await parseQuery('2024', { people, mePersonId: null, now });
    expect(r.query.time?.from?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(r.query.time?.to?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });
});
