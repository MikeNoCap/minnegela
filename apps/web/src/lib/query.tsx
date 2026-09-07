'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: (n, err) => (err as { status?: number })?.status === 404 ? false : n < 2, refetchOnWindowFocus: false } },
  }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
