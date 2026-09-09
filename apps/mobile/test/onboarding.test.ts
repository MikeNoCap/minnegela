import { describe, it, expect } from 'vitest';
import { nextStep } from '@/onboarding';
import { defaultSettings } from '@/store/settings';

const me = { user: { id: 'u', email: 'a@b', displayName: 'Mikkel' }, groups: [{ id: 'g', name: 'G', role: 'owner' as const, personId: 1, consentFacesAt: null }] };
const s = defaultSettings();
// Past the group step: this device adopted the group and registered itself.
const bound = { ...s, groupId: 'g', deviceId: 'd' };

describe('onboarding gate', () => {
  it('walks the steps in order', () => {
    expect(nextStep({ token: null, me: null, settings: s, photoPermission: 'unknown' })).toBe('sign-in');
    expect(nextStep({ token: 't', me: { ...me, user: { ...me.user, displayName: '' } }, settings: s, photoPermission: 'unknown' })).toBe('profile');
    expect(nextStep({ token: 't', me: { ...me, groups: [] }, settings: s, photoPermission: 'unknown' })).toBe('group');
    expect(nextStep({ token: 't', me, settings: bound, photoPermission: 'unknown' })).toBe('permissions');
    expect(nextStep({ token: 't', me, settings: bound, photoPermission: 'granted' })).toBe('enroll');
    expect(nextStep({ token: 't', me, settings: { ...bound, enrollment: { pendingLocalIds: ['x'], doneAt: null, lastError: null } }, photoPermission: 'limited' })).toBe('policy');
    expect(nextStep({ token: 't', me, settings: { ...bound, onboardingDone: true }, photoPermission: 'granted' })).toBe('done');
  });
  it('membership alone does not pass the group step: the device must adopt the group and register', () => {
    // The group existed before this install (e.g. created on the web): still route to the group screen.
    expect(nextStep({ token: 't', me, settings: s, photoPermission: 'granted' })).toBe('group');
    // Adopted but never registered a device (partial state): back to the group screen too.
    expect(nextStep({ token: 't', me, settings: { ...s, groupId: 'g' }, photoPermission: 'granted' })).toBe('group');
    // Even after onboarding finished, a lost device binding routes back.
    expect(nextStep({ token: 't', me, settings: { ...s, groupId: 'g', onboardingDone: true }, photoPermission: 'granted' })).toBe('group');
  });
  it('a member who already consented skips enrollment', () => {
    expect(nextStep({ token: 't', me: { ...me, groups: [{ ...me.groups[0]!, consentFacesAt: '2026-01-01' }] }, settings: bound, photoPermission: 'granted' })).toBe('policy');
  });
});
