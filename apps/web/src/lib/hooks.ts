'use client';
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs } from './api';
import { useGroupId } from './group';
import type { EventCard, EventDetail, MediaItem, Page, PersonSummary, MemberSummary, VisibilityInfo, GroupStatus, ReviewQueue, PersonDetail, MediaDetail, SearchResult, TimelineDay, GroupInfo, AuditRow, Invite, MapPin } from './types';

export function useEvents(filters: { from?: string; to?: string; people?: number[]; place?: string; quiet?: 'hide' | 'only' | 'all' } = {}) {
  const g = useGroupId();
  return useInfiniteQuery({
    queryKey: ['events', g, filters],
    enabled: !!g,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api<Page<EventCard>>(`/v1/groups/${g}/events${qs({ ...filters, cursor: pageParam ?? undefined })}`),
    getNextPageParam: (last) => last.nextCursor,
  });
}
export const useEvent = (id: string) => useQuery({ queryKey: ['event', id], queryFn: () => api<EventDetail>(`/v1/events/${id}`), enabled: !!id });
export function useEventMedia(id: string, f: { tier?: string; person?: number; type?: string } = {}) {
  return useInfiniteQuery({
    queryKey: ['event-media', id, f],
    enabled: !!id,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api<Page<MediaItem>>(`/v1/events/${id}/media${qs({ ...f, cursor: pageParam ?? undefined, limit: 500 })}`),
    getNextPageParam: (last) => last.nextCursor,
  });
}
export const useVisibility = (id: string) => useQuery({ queryKey: ['visibility', id], queryFn: () => api<VisibilityInfo>(`/v1/events/${id}/visibility`), enabled: !!id });
export function usePeople() {
  const g = useGroupId();
  return useQuery({ queryKey: ['people', g], queryFn: () => api<{ items: PersonSummary[] } | PersonSummary[]>(`/v1/groups/${g}/people`).then((r) => (Array.isArray(r) ? r : r.items)), enabled: !!g });
}
export const usePerson = (id: string) => useQuery({ queryKey: ['person', id], queryFn: () => api<PersonDetail>(`/v1/people/${id}`), enabled: !!id });
export function useMembers() {
  const g = useGroupId();
  return useQuery({ queryKey: ['members', g], queryFn: () => api<{ items: MemberSummaryT[] } | MemberSummaryT[]>(`/v1/groups/${g}/members`).then((r) => (Array.isArray(r) ? r : r.items)), enabled: !!g });
}
type MemberSummaryT = MemberSummary;
export function useGroupInfo() {
  const g = useGroupId();
  return useQuery({ queryKey: ['group', g], queryFn: () => api<GroupInfo>(`/v1/groups/${g}`), enabled: !!g });
}
export function useStatus() {
  const g = useGroupId();
  return useQuery({ queryKey: ['status', g], queryFn: () => api<GroupStatus>(`/v1/groups/${g}/status`), enabled: !!g, refetchInterval: 30_000 });
}
export function useReview() {
  const g = useGroupId();
  return useQuery({ queryKey: ['review', g], queryFn: () => api<ReviewQueue>(`/v1/groups/${g}/review`), enabled: !!g });
}
export const useMedia = (blobId: string | null) => useQuery({ queryKey: ['media', blobId], queryFn: () => api<MediaDetail>(`/v1/media/${blobId}`), enabled: !!blobId });
export function useSearch(q: string, mode: 'events' | 'media') {
  const g = useGroupId();
  return useQuery({ queryKey: ['search', g, q, mode], queryFn: () => api<SearchResult>(`/v1/groups/${g}/search${qs({ q, mode })}`), enabled: !!g && q.trim().length > 0 });
}
export function useTimeline(day: string) {
  const g = useGroupId();
  return useQuery({ queryKey: ['timeline', g, day], queryFn: () => api<TimelineDay | { items: TimelineDay[] }>(`/v1/groups/${g}/timeline${qs({ day })}`), enabled: !!g });
}
export function useMap(f: { from?: string; to?: string } = {}) {
  const g = useGroupId();
  return useQuery({ queryKey: ['map', g, f], queryFn: () => api<{ items: MapPin[] } | MapPin[]>(`/v1/groups/${g}/map${qs(f)}`).then((r) => (Array.isArray(r) ? r : r.items)), enabled: !!g });
}
export function useAudit(enabled: boolean) {
  const g = useGroupId();
  return useQuery({ queryKey: ['audit', g], queryFn: () => api<Page<AuditRow> | AuditRow[]>(`/v1/groups/${g}/audit`).then((r) => (Array.isArray(r) ? r : r.items)), enabled: !!g && enabled });
}

/** Mutation helper that invalidates the given query keys on success. */
export function useAction<TVars = void, TOut = unknown>(fn: (vars: TVars) => Promise<TOut>, invalidate: (vars: TVars) => unknown[][]) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: (_d, vars) => { for (const k of invalidate(vars)) void qc.invalidateQueries({ queryKey: k }); } });
}

export const eventActions = {
  rename: (id: string, title: string) => api<EventDetail>(`/v1/events/${id}`, { method: 'PATCH', body: { title } }),
  interest: (id: string, interest: 'keep' | 'quiet' | 'auto') => api<EventDetail>(`/v1/events/${id}`, { method: 'PATCH', body: { interest } }),
  open: (id: string) => api(`/v1/events/${id}/open`, { method: 'POST', body: {} }),
  close: (id: string) => api(`/v1/events/${id}/close`, { method: 'POST', body: {} }),
  tag: (id: string, personId: number) => api(`/v1/events/${id}/tags`, { method: 'POST', body: { personId } }),
  untag: (id: string, personId: number) => api(`/v1/events/${id}/tags/${personId}`, { method: 'DELETE' }),
  split: (id: string, at: string) => api(`/v1/events/${id}/split`, { method: 'POST', body: { at } }),
  merge: (id: string, withEventId: string) => api(`/v1/events/${id}/merge`, { method: 'POST', body: { withEventId } }),
  exclude: (id: string, assetIds: string[]) => api(`/v1/events/${id}/exclude`, { method: 'POST', body: { assetIds } }),
  include: (id: string, assetIds: string[]) => api(`/v1/events/${id}/include`, { method: 'POST', body: { assetIds } }),
};
export const faceActions = {
  label: (faceId: string, personId: number, verdict: 'confirm' | 'reject') => api(`/v1/faces/${faceId}/label`, { method: 'POST', body: { personId, verdict } }),
};
export const peopleActions = {
  create: (g: string, body: { name: string; clusterId?: string }) => api<PersonSummary>(`/v1/groups/${g}/people`, { method: 'POST', body }),
  patch: (id: number, body: { name?: string; hidden?: boolean; mergeInto?: number }) => api<PersonSummary>(`/v1/people/${id}`, { method: 'PATCH', body }),
  dismissCluster: (g: string, clusterId: string) => api(`/v1/groups/${g}/review/clusters/${clusterId}/dismiss`, { method: 'POST', body: {} }),
};
export const groupActions = {
  create: (name: string) => api<GroupInfo>('/v1/groups', { method: 'POST', body: { name } }),
  accept: (code: string) => api<{ groupId: string }>(`/v1/invites/${encodeURIComponent(code)}/accept`, { method: 'POST', body: {} }),
  invite: (g: string) => api<Invite>(`/v1/groups/${g}/invites`, { method: 'POST', body: {} }),
  consent: (g: string, consentFaces: boolean) => api(`/v1/groups/${g}/members/me`, { method: 'PATCH', body: { consentFaces } }),
  recluster: (g: string) => api(`/v1/groups/${g}/recluster`, { method: 'POST', body: {} }),
  retryJobs: (g: string) => api(`/v1/groups/${g}/jobs/retry`, { method: 'POST', body: {} }),
};
