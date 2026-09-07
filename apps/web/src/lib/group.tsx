'use client';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { GROUP_KEY } from './config';
import type { Me } from './types';

type GroupCtx = {
  me: Me | null;
  groupId: string | null;
  group: Me['groups'][number] | null;
  personId: number | null;
  setGroupId: (id: string) => void;
  loading: boolean;
  refresh: () => void;
};
const Ctx = createContext<GroupCtx>({ me: null, groupId: null, group: null, personId: null, setGroupId: () => {}, loading: true, refresh: () => {} });

export function GroupProvider({ children }: { children: ReactNode }) {
  const q = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/v1/me'), retry: false });
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { try { setSelected(localStorage.getItem(GROUP_KEY)); } catch {} }, []);
  const me = q.data ?? null;
  const groups = me?.groups ?? [];
  const groupId = useMemo(() => {
    if (!groups.length) return null;
    return groups.some((g) => g.id === selected) ? selected : groups[0]!.id;
  }, [groups, selected]);
  const group = groups.find((g) => g.id === groupId) ?? null;
  const value: GroupCtx = {
    me, groupId, group,
    personId: group?.personId ?? null,
    setGroupId: (id) => { setSelected(id); try { localStorage.setItem(GROUP_KEY, id); } catch {} },
    loading: q.isLoading,
    refresh: () => { void q.refetch(); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useGroup = () => useContext(Ctx);
/** Throws-free accessor for pages that require a group; the AppShell guarantees one exists. */
export const useGroupId = () => useContext(Ctx).groupId ?? '';
