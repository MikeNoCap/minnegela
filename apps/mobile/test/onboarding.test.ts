import { describe, it, expect } from 'vitest';
import { nextStep } from '@/onboarding';
import { defaultSettings } from '@/store/settings';

const me = { user: { id: 'u', email: 'a@b', displayName: 'Mikkel' }, groups: [{ id: 'g', name: 'G', role: 'owner' as const, personId: 1, consentFacesAt: null }] };
const s = defaultSettings();

describe('onboarding gate', () => {
  it('walks the steps in order', () => {
    expect(nextStep({ token: null, me: null, settings: s, photoPermission: 'unknown' })).toBe('sign-in');
    expect(nextStep({ token: 't', me: { ...me, user: { ...me.user, displayName: '' } }, settings: s, photoPermission: 'unknown' })).toBe('profile');
    expect(nextStep({ token: 't', me: { ...me, groups: [] }, settings: s, photoPermission: 'unknown' })).toBe('group');
    expect(nextStep({ token: 't', me, settings: s, photoPermission: 'unknown' })).toBe('permissions');
    expect(nextStep({ token: 't', me, settings: s, photoPermission: 'granted' })).toBe('enroll');
    expect(nextStep({ token: 't', me, settings: { ...s, enrollment: { pendingLocalIds: ['x'], doneAt: null, lastError: null } }, photoPermission: 'limited' })).toBe('policy');
    expect(nextStep({ token: 't', me, settings: { ...s, onboardingDone: true }, photoPermission: 'granted' })).toBe('done');
  });
  it('a member who already consented skips enrollment', () => {
    expect(nextStep({ token: 't', me: { ...me, groups: [{ ...me.groups[0]!, consentFacesAt: '2026-01-01' }] }, settings: s, photoPermission: 'granted' })).toBe('policy');
  });
});
