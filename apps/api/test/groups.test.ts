import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAS_DB, testApp, cleanupUsers, createUser, sessionFor, auth } from './helpers.js';
import type { App } from '../src/app.js';
import type { DbHandle } from '@minnegela/db';

describe.skipIf(!HAS_DB)('groups, invites, members, devices', () => {
  let app: App, admin: DbHandle, owner: string, friend: string;
  beforeAll(async () => {
    ({ app, admin } = await testApp());
    owner = await sessionFor(admin, await createUser(admin, `owner-${Date.now()}@apitest.local`, 'Owner'));
    friend = await sessionFor(admin, await createUser(admin, `friend-${Date.now()}@apitest.local`, 'Friend'));
  });
  afterAll(async () => { await cleanupUsers(admin, '%@apitest.local'); await app.close(); await admin.close(); });

  it('create → invite → accept → members; roles enforced; device registration; status', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/groups', headers: auth(owner), payload: { name: 'Test crew' } });
    expect(created.statusCode).toBe(201);
    const g = created.json();
    expect(g.role).toBe('owner'); expect(typeof g.personId).toBe('number');

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: auth(owner) });
    expect(me.json().groups).toEqual([{ id: g.id, name: 'Test crew', role: 'owner', personId: g.personId, consentFacesAt: null }]);

    // friend cannot see the group yet
    expect((await app.inject({ method: 'GET', url: `/v1/groups/${g.id}`, headers: auth(friend) })).statusCode).toBe(404);
    // friend cannot create invites even after joining (member role)
    const inv = await app.inject({ method: 'POST', url: `/v1/groups/${g.id}/invites`, headers: auth(owner), payload: {} });
    expect(inv.statusCode).toBe(201);
    const { code } = inv.json();

    const bad = await app.inject({ method: 'POST', url: `/v1/invites/nope/accept`, headers: auth(friend) });
    expect(bad.statusCode).toBe(400);
    const acc = await app.inject({ method: 'POST', url: `/v1/invites/${code}/accept`, headers: auth(friend) });
    expect(acc.statusCode).toBe(200);
    expect(acc.json().groupId).toBe(g.id);
    // single use
    expect((await app.inject({ method: 'POST', url: `/v1/invites/${code}/accept`, headers: auth(friend) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/v1/groups/${g.id}/invites`, headers: auth(friend), payload: {} })).statusCode).toBe(403);

    const members = await app.inject({ method: 'GET', url: `/v1/groups/${g.id}/members`, headers: auth(friend) });
    expect(members.json().map((m: { displayName: string; role: string }) => [m.displayName, m.role]).sort()).toEqual([['Friend', 'member'], ['Owner', 'owner']]);

    const consent = await app.inject({ method: 'PATCH', url: `/v1/groups/${g.id}/members/me`, headers: auth(friend), payload: { consentFaces: true } });
    expect(consent.json().consentFacesAt).toBeTruthy();

    const dev = await app.inject({ method: 'POST', url: `/v1/groups/${g.id}/devices`, headers: auth(friend), payload: { platform: 'cli', name: 'laptop' } });
    expect(dev.statusCode).toBe(201);
    const devices = await app.inject({ method: 'GET', url: `/v1/groups/${g.id}/devices`, headers: auth(owner) });
    expect(devices.json().map((d: { name: string }) => d.name)).toEqual(['laptop']);

    const status = await app.inject({ method: 'GET', url: `/v1/groups/${g.id}/status`, headers: auth(owner) });
    expect(status.statusCode).toBe(200);
    expect(status.json().devices[0].ownerName).toBe('Friend');
    expect(status.json().storage.blobs).toBe(0);

    const audit = await app.inject({ method: 'GET', url: `/v1/groups/${g.id}/audit`, headers: auth(owner) });
    expect(audit.json().items.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['group.create', 'invite.create', 'group.join', 'device.register', 'consent.faces.granted']));
    expect((await app.inject({ method: 'GET', url: `/v1/groups/${g.id}/audit`, headers: auth(friend) })).statusCode).toBe(403);

    // leave
    expect((await app.inject({ method: 'DELETE', url: `/v1/groups/${g.id}/members/me`, headers: auth(friend), payload: { takeMedia: true } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/v1/groups/${g.id}`, headers: auth(friend) })).statusCode).toBe(404);
  });
});
