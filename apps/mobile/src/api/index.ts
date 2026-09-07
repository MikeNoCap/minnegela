import type { ManifestRequest, ManifestResponse, UploadTarget, EventCard, MemberSummary } from '@minnegela/shared';
import type { Client } from './client';

export type Me = {
  user: { id: string; email: string; displayName: string; birthday?: string | null };
  groups: Array<{ id: string; name: string; role: 'owner' | 'member'; personId: number | null; consentFacesAt: string | null }>;
};
export type GroupStatus = {
  queues: Array<{ kind: string; pending: number; running: number; failed: number }>;
  devices: Array<{ id: string; name: string; platform: string; ownerName: string; lastSyncAt: string | null }>;
  storage: { blobs: number; bytes: number; originals: number };
  analyzing: number;
  counts: { assets: number; previews: number; analyzed: number; events: number };
};
export type Page<T> = { items: T[]; nextCursor: string | null };
export type UploadsResponse = { items: Array<{ assetId: string; kind: 'preview' | 'original'; upload: UploadTarget }> };

/** Typed surface of the routes the phone uses (docs/DESIGN.md §21). */
export function makeApi(c: Client) {
  return {
    // auth (Better Auth emailOTP + bearer plugins)
    sendOtp: (email: string) => c.post<{ success: boolean }>('/v1/auth/email-otp/send-verification-otp', { email, type: 'sign-in' }),
    signInWithOtp: async (email: string, otp: string) => {
      const r = await c.raw<{ token?: string | null; user?: { id: string; email: string } }>('POST', '/v1/auth/sign-in/email-otp', { email, otp });
      const token = r.headers.get('set-auth-token') ?? r.body?.token ?? null;
      if (!token) throw new Error('Sign-in succeeded but no session token was returned');
      return { token, user: r.body?.user };
    },
    me: () => c.get<Me>('/v1/me'),
    updateMe: (body: { displayName: string; birthday?: string | null }) => c.patch<Me['user']>('/v1/me', body),
    deleteMe: () => c.delete<{ status: string; graceDays: number }>('/v1/me'),
    requestExport: (groupId?: string) => c.post<{ status: string }>('/v1/me/export', groupId ? { groupId } : {}),
    // groups
    createGroup: (name: string) => c.post<{ id: string; name: string }>('/v1/groups', { name }),
    acceptInvite: (code: string) => c.post<{ groupId: string; name: string; personId: number }>(`/v1/invites/${encodeURIComponent(code.trim())}/accept`),
    createInvite: (groupId: string) => c.post<{ code: string; expiresAt: string }>(`/v1/groups/${groupId}/invites`),
    members: (groupId: string) => c.get<MemberSummary[]>(`/v1/groups/${groupId}/members`),
    setConsent: (groupId: string, consentFaces: boolean) => c.patch<unknown>(`/v1/groups/${groupId}/members/me`, { consentFaces }),
    leaveGroup: (groupId: string, takeMedia: boolean) => c.delete<unknown>(`/v1/groups/${groupId}/members/me`, { takeMedia }),
    registerDevice: (groupId: string, name: string, platform: 'ios' | 'android') => c.post<{ id: string }>(`/v1/groups/${groupId}/devices`, { platform, name }),
    status: (groupId: string) => c.get<GroupStatus>(`/v1/groups/${groupId}/status`),
    events: (groupId: string, cursor?: string | null) => c.get<Page<EventCard>>(`/v1/groups/${groupId}/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
    // sync (§13.1)
    manifest: (groupId: string, body: ManifestRequest) => c.post<ManifestResponse>(`/v1/groups/${groupId}/sync/manifest`, body),
    uploads: (groupId: string, items: Array<{ assetId: string; kind: 'preview' | 'original'; bytes: number; mime: string }>) => c.post<UploadsResponse>(`/v1/groups/${groupId}/sync/uploads`, { items }),
    complete: (assetId: string, kind: 'preview' | 'original', sha256: string, bytes: number) => c.post<unknown>(`/v1/assets/${assetId}/complete`, { kind, sha256, bytes }),
    deleteAsset: (assetId: string) => c.delete<unknown>(`/v1/assets/${assetId}`),
    setAssetVisibility: (assetId: string, visibility: 'group' | 'hidden') => c.patch<unknown>(`/v1/assets/${assetId}`, { visibility }),
    // people
    enroll: (personId: number, assetIds: string[]) => c.post<{ personId: number; queued: string }>(`/v1/people/${personId}/enroll`, { assetIds }),
  };
}
export type Api = ReturnType<typeof makeApi>;
