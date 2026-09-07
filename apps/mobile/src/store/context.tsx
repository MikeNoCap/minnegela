import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { openLocalDb } from '@/db';
import type { LocalDb } from '@/db/types';
import { createClient } from '@/api/client';
import { makeApi, type Api, type Me } from '@/api';
import { loadToken, saveToken, loadApiUrl, saveApiUrl } from '@/auth/session';
import { parseSettings, type Settings } from './settings';

type AppState = {
  ready: boolean;
  db: LocalDb;
  api: Api;
  token: string | null;
  me: Me | null;
  settings: Settings;
  setToken: (t: string | null) => Promise<void>;
  setApiUrl: (u: string) => Promise<void>;
  refreshMe: () => Promise<Me | null>;
  updateSettings: (patch: (s: Settings) => Settings) => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AppState | null>(null);
export const useApp = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
};
export const platform = (): 'ios' | 'android' => (Platform.OS === 'ios' ? 'ios' : 'android');

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [db, setDb] = useState<LocalDb | null>(null);
  const [token, setTokenState] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [settings, setSettings] = useState<Settings>(() => parseSettings(null));
  const tokenRef = useRef<string | null>(null);
  const urlRef = useRef<string>(settings.apiUrl);

  const api = useMemo(() => makeApi(createClient({
    baseUrl: () => urlRef.current,
    token: () => tokenRef.current,
    onUnauthorized: () => { tokenRef.current = null; setTokenState(null); setMe(null); void saveToken(null); },
  })), []);

  useEffect(() => {
    (async () => {
      const d = await openLocalDb();
      const s = parseSettings(await d.getSyncState('settings'));
      const storedUrl = await loadApiUrl();
      if (storedUrl) s.apiUrl = storedUrl;
      urlRef.current = s.apiUrl;
      const t = await loadToken();
      tokenRef.current = t;
      setDb(d); setSettings(s); setTokenState(t);
      if (t && s.apiUrl) { try { setMe(await api.me()); } catch { /* offline or expired: gate decides */ } }
      setReady(true);
    })();
  }, [api]);

  const updateSettings = useCallback(async (patch: (s: Settings) => Settings) => {
    setSettings((prev) => {
      const next = patch(prev);
      urlRef.current = next.apiUrl;
      void db?.setSyncState('settings', JSON.stringify(next));
      return next;
    });
  }, [db]);

  const value: AppState | null = db ? {
    ready, db, api, token, me, settings,
    setToken: async (t) => { tokenRef.current = t; setTokenState(t); await saveToken(t); },
    setApiUrl: async (u) => { await saveApiUrl(u); await updateSettings((s) => ({ ...s, apiUrl: u.trim().replace(/\/$/, '') })); },
    refreshMe: async () => { try { const m = await api.me(); setMe(m); return m; } catch { return null; } },
    updateSettings,
    signOut: async () => { tokenRef.current = null; setTokenState(null); setMe(null); await saveToken(null); },
  } : null;

  if (!value) return null;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
