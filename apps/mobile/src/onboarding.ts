import type { Me } from '@/api';
import type { Settings } from '@/store/settings';

export type Step = 'sign-in' | 'profile' | 'group' | 'permissions' | 'enroll' | 'policy' | 'done';

/** Where a user must go next. Pure so the gate is predictable. */
export function nextStep(input: { token: string | null; me: Me | null; settings: Settings; photoPermission: 'granted' | 'limited' | 'denied' | 'unknown' }): Step {
  if (!input.token || !input.me) return 'sign-in';
  if (!input.me.user.displayName?.trim()) return 'profile';
  const group = input.settings.groupId ? input.me.groups.find((g) => g.id === input.settings.groupId) : input.me.groups[0];
  if (!group) return 'group';
  if (input.photoPermission === 'denied' || input.photoPermission === 'unknown') return 'permissions';
  if (!input.settings.onboardingDone) {
    const enrolled = !!input.settings.enrollment.doneAt || input.settings.enrollment.pendingLocalIds.length > 0 || !!group.consentFacesAt;
    if (!enrolled) return 'enroll';
    return 'policy';
  }
  return 'done';
}
