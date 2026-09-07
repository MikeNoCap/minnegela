'use client';
import type { ReactNode } from 'react';
import { QueryProvider } from '@/lib/query';
import { GroupProvider } from '@/lib/group';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <GroupProvider>{children}</GroupProvider>
    </QueryProvider>
  );
}
