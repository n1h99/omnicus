import { describe, expect, it, vi } from 'vitest';

import { backfillSystemProjectRoles, seedProjectRoles } from './seed-project-roles';

describe('seed project role backfill', () => {
  it('idempotently adds channel permissions to existing system roles', async () => {
    const permissions = new Map(
      [
        'project:read',
        'project:manage',
        'members:manage',
        'contacts:read',
        'contacts:manage',
        'contacts:update',
        'contacts:export',
        'contacts:merge',
        'communications:read',
        'communications:send',
        'tags:read',
        'tags:manage',
        'automation:read',
        'automation:manage',
        'integrations:manage',
        'channels:read',
        'channels:manage',
        'channels:rotate_secrets',
        'broadcasts:read',
        'broadcasts:create',
        'broadcasts:launch',
        'broadcasts:pause',
        'broadcasts:cancel',
        'media:read',
        'email:read',
        'email:send',
        'email:manage',
        'media:manage',
        'templates:read',
        'templates:manage',
      ].map((code) => [code, `permission-${code}`]),
    );
    const upsertPermission = vi.fn().mockResolvedValue(undefined);
    const transaction = {
      projectRole: { upsert: vi.fn().mockResolvedValue({ id: 'role-id' }) },
      projectRolePermission: { upsert: upsertPermission },
    };

    await backfillSystemProjectRoles(transaction as never, 'project-a', permissions);
    await backfillSystemProjectRoles(transaction as never, 'project-a', permissions);

    const channelPermissionIds = upsertPermission.mock.calls
      .map(([input]) => input.create.permissionId as string)
      .filter((permissionId) => permissionId.startsWith('permission-channels:'));
    expect(channelPermissionIds).toEqual(
      expect.arrayContaining([
        'permission-channels:read',
        'permission-channels:manage',
        'permission-channels:rotate_secrets',
      ]),
    );
    expect(upsertPermission.mock.calls.map(([input]) => input.create.permissionId)).toEqual(
      expect.arrayContaining(['permission-broadcasts:read', 'permission-broadcasts:launch']),
    );
    expect(upsertPermission).toHaveBeenCalledTimes(
      seedProjectRoles.reduce((total, [, , rolePermissions]) => total + rolePermissions.length, 0) *
        2,
    );
  });
});
