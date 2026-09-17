import { describe, expect, it } from 'vitest';

import {
  humanizeAuditAction,
  humanizeEntity,
  humanizePermission,
  humanizePermissionGroup,
} from './humanize';

describe('human-facing system labels', () => {
  it('never exposes raw permission or audit codes in visible labels', () => {
    expect(humanizePermission('projects:create')).toBe('Create projects');
    expect(humanizePermission('communications:send')).toBe('Send messages to contacts');
    expect(humanizePermissionGroup('communications')).toBe('Communications');
    expect(humanizePermissionGroup('broadcasts')).toBe('Broadcasts');
    expect(humanizeAuditAction('auth.login.succeeded')).toBe('Signed in');
    expect(humanizeEntity('GlobalUserInviteToken')).toBe('System invitation');
  });

  it('turns new internal codes into readable fallback copy', () => {
    expect(humanizeAuditAction('automation.secret.rotated')).toBe('Automation secret rotated');
    expect(humanizeEntity('FutureInternalRecord')).toBe('Future internal record');
  });
});
