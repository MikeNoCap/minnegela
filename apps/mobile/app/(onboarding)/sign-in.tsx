import React, { useState } from 'react';
import { useApp } from '@/store/context';
import { Screen, Card, P, Button, Field, Banner } from '@/ui/components';
import { ApiError } from '@/api/client';

export default function SignIn() {
  const app = useApp();
  const [url, setUrl] = useState(app.settings.apiUrl || 'http://100.64.0.1:4000');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true); setError(null);
    try {
      await app.setApiUrl(url);
      await app.api.sendOtp(email.trim().toLowerCase());
      setStage('code');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setError(null);
    try {
      const { token } = await app.api.signInWithOtp(email.trim().toLowerCase(), otp.trim());
      await app.setToken(token);
      await app.refreshMe();
    } catch (e) { setError(e instanceof ApiError && e.status < 500 ? 'That code did not work. Check it and try again.' : e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <Screen title="Minnegela">
      <P muted>A search engine for your friend group's memories. Friends only ever see events you were at together. Everything else stays yours.</P>
      <Card>
        {stage === 'email' ? (
          <>
            <Field label="Server" value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="http://server:4000" />
            <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" placeholder="you@example.com" />
            <Button title="Send me a code" onPress={send} loading={busy} disabled={!email.includes('@') || !url.startsWith('http')} />
          </>
        ) : (
          <>
            <P>We sent a 6-digit code to {email}.</P>
            <Field label="Code" value={otp} onChangeText={setOtp} keyboardType="number-pad" autoFocus placeholder="123456" maxLength={8} />
            <Button title="Sign in" onPress={verify} loading={busy} disabled={otp.trim().length < 4} />
            <Button title="Use a different email" kind="secondary" onPress={() => { setStage('email'); setOtp(''); }} />
          </>
        )}
        {error ? <Banner tone="warn">{error}</Banner> : null}
      </Card>
    </Screen>
  );
}
