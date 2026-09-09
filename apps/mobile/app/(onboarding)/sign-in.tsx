import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '@/store/context';
import { Screen, Card, P, Button, Field, Banner } from '@/ui/components';
import { ApiError } from '@/api/client';
import { apiErrorMessage } from '@/api/errors';

export default function SignIn() {
  const app = useApp();
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true); setError(null);
    try {
      await app.api.sendOtp(email.trim().toLowerCase());
      setStage('code');
    } catch (e) { setError(apiErrorMessage(e)); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setError(null);
    try {
      const { token } = await app.api.signInWithOtp(email.trim().toLowerCase(), otp.trim());
      await app.setToken(token);
      await app.refreshMe();
    } catch (e) { setError(e instanceof ApiError && e.status < 500 ? t('signIn.badCode') : apiErrorMessage(e)); } finally { setBusy(false); }
  };

  return (
    <Screen title={t('signIn.title')}>
      <P muted>{t('signIn.tagline')}</P>
      <Card>
        {stage === 'email' ? (
          <>
            <Field label={t('signIn.emailLabel')} value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" placeholder={t('signIn.emailPlaceholder')} />
            <Button title={t('signIn.sendCode')} onPress={send} loading={busy} disabled={!email.includes('@')} />
          </>
        ) : (
          <>
            <P>{t('signIn.sentCode', { email })}</P>
            <Field label={t('signIn.codeLabel')} value={otp} onChangeText={setOtp} keyboardType="number-pad" autoFocus placeholder="123456" maxLength={8} />
            <Button title={t('signIn.signIn')} onPress={verify} loading={busy} disabled={otp.trim().length < 4} />
            <Button title={t('signIn.differentEmail')} kind="secondary" onPress={() => { setStage('email'); setOtp(''); }} />
          </>
        )}
        {error ? <Banner tone="warn">{error}</Banner> : null}
      </Card>
    </Screen>
  );
}
