import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'minnegela.session';
const URL_KEY = 'minnegela.apiUrl';

/** Session token lives in the OS keystore (§18.10); never in SQLite. */
export async function loadToken(): Promise<string | null> {
  try { return await SecureStore.getItemAsync(TOKEN_KEY); } catch { return null; }
}
export async function saveToken(token: string | null): Promise<void> {
  if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}
export async function loadApiUrl(): Promise<string | null> {
  try { return await SecureStore.getItemAsync(URL_KEY); } catch { return null; }
}
export async function saveApiUrl(url: string): Promise<void> {
  await SecureStore.setItemAsync(URL_KEY, url.trim().replace(/\/$/, ''));
}
