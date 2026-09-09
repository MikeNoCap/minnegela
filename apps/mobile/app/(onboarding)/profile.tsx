import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '@/store/context';
import { apiErrorMessage } from '@/api/errors';
import { Screen, Card, P, Button, Field, Banner } from '@/ui/components';

/** First sign-in with a code creates a user without a name; ask for it before anything else. */
export default function Profile() {
  const app = useApp();
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [birthday, setBirthday] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      await app.api.updateMe({ displayName: name.trim(), birthday: /^\d{4}-\d{2}-\d{2}$/.test(birthday.trim()) ? birthday.trim() : null });
      await app.refreshMe();
    } catch (e) { setError(apiErrorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Screen title={t('profile.title')}>
      <Card>
        <Field label={t('profile.nameLabel')} value={name} onChangeText={setName} placeholder={t('profile.namePlaceholder')} autoFocus />
        <Field label={t('profile.birthdayLabel')} value={birthday} onChangeText={setBirthday} placeholder={t('profile.birthdayPlaceholder')} keyboardType="numbers-and-punctuation" />
        <Button title={t('common.continue')} onPress={save} loading={busy} disabled={name.trim().length < 1} />
        {error ? <Banner tone="warn">{error}</Banner> : null}
      </Card>
      <P muted small>{t('profile.footer')}</P>
    </Screen>
  );
}
