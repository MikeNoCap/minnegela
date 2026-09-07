'use client';
import { useMemo } from 'react';
import { usePeople, useMembers } from '@/lib/hooks';
import type { PersonSummary, MemberSummary } from '@/lib/types';

export function usePeopleIndex(): Map<number, PersonSummary> {
  const q = usePeople();
  return useMemo(() => new Map((q.data ?? []).map((p) => [p.id, p])), [q.data]);
}
export function useMemberIndex(): Map<string, MemberSummary> {
  const q = useMembers();
  return useMemo(() => new Map((q.data ?? []).map((m) => [m.userId, m])), [q.data]);
}
