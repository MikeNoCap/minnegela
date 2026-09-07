import React, { useState } from 'react';
import { useApp } from '@/store/context';
import { Screen, Card, P, Button, Field, Banner } from '@/ui/components';

/** First sign-in with a code creates a user without a name; ask for it before anything else. */
export default function Profile() {
  const app = useApp();
  const [name, setName] = useState('');
  const [birthday, setBirthday] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      await app.api.updateMe({ displayName: name.trim(), birthday: /^\d{4}-\d{2}-\d{2}$/.test(birthday.trim()) ? birthday.trim() : null });
      await app.refreshMe();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <Screen title="What should friends call you?">
      <Card>
        <Field label="Name" value={name} onChangeText={setName} placeholder="Mikkel" autoFocus />
        <Field label="Birthday (optional, for “Emma's birthday” titles)" value={birthday} onChangeText={setBirthday} placeholder="1998-03-14" keyboardType="numbers-and-punctuation" />
        <Button title="Continue" onPress={save} loading={busy} disabled={name.trim().length < 1} />
        {error ? <Banner tone="warn">{error}</Banner> : null}
      </Card>
      <P muted small>Your name is shown to members of groups you join, on the events you were part of.</P>
    </Screen>
  );
}
