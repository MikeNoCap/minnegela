'use client';
import { createAuthClient } from 'better-auth/react';
import { magicLinkClient } from 'better-auth/client/plugins';
import { API_URL } from './config';

export const authClient = createAuthClient({
  baseURL: `${API_URL}/v1/auth`,
  plugins: [magicLinkClient()],
  fetchOptions: { credentials: 'include' },
});
