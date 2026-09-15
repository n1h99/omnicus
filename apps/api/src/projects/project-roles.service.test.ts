import { describe, expect, it, vi } from 'vitest';

import { ProjectRolesService } from './project-roles.service';

describe('ProjectRolesService', () => {
  it('assigns channel permissions to the Project Admin role when creating a project', async () => {
    const upsertPermission = vi.fn().mockResolvedValue(undefined);
    const service = new ProjectRolesService({} as never, {} as never);
    const transaction = {
      permission: {
        findMany: vi.fn().mockResolvedValue([
          { code: 'project:read', id: 'permission-project-read' },
          { code: 'project:manage', id: 'permission-project-manage' },
          { code: 'members:manage', id: 'permission-members-manage' },
          { code: 'contacts:read', id: 'permission-contacts-read' },
          { code: 'contacts:manage', id: 'permission-contacts-manage' },
          { code: 'contacts:update', id: 'permission-contacts-update' },
          { code: 'contacts:export', id: 'permission-contacts-export' },
          { code: 'contacts:merge', id: 'permission-contacts-merge' },
          { code: 'tags:read', id: 'permission-tags-read' },
          { code: 'tags:manage', id: 'permission-tags-manage' },
          { code: 'automation:read', id: 'permission-automation-read' },
          { code: 'automation:manage', id: 'permission-automation-manage' },
          { code: 'integrations:manage', id: 'permission-integrations-manage' },
          { code: 'channels:read', id: 'permission-channels-read' },
          { code: 'channels:manage', id: 'permission-channels-manage' },
          { code: 'channels:rotate_secrets', id: 'permission-channels-rotate' },
          { code: 'broadcasts:read', id: 'permission-broadcasts-read' },
          { code: 'broadcasts:create', id: 'permission-broadcasts-create' },
          { code: 'broadcasts:launch', id: 'permission-broadcasts-launch' },
          { code: 'broadcasts:pause', id: 'permission-broadcasts-pause' },
          { code: 'broadcasts:cancel', id: 'permission-broadcasts-cancel' },
          { code: 'media:read', id: 'permission-media-read' },
          { code: 'email:read', id: 'permission-email-read' },
          { code: 'email:send', id: 'permission-email-send' },
          { code: 'email:manage', id: 'permission-email-manage' },
          { code: 'media:manage', id: 'permission-media-manage' },
          { code: 'templates:read', id: 'permission-templates-read' },
          { code: 'templates:manage', id: 'permission-templates-manage' },
        ]),
      },
      projectRole: { upsert: vi.fn().mockResolvedValue({ id: 'project-admin-role' }) },
      projectRolePermission: { upsert: upsertPermission },
    };

    await service.ensureForProject('project-a', transaction as never);

    const permissionIds = upsertPermission.mock.calls.map(
      ([input]) => input.create.permissionId as string,
    );
    expect(permissionIds).toEqual(
      expect.arrayContaining([
        'permission-channels-read',
        'permission-channels-manage',
        'permission-channels-rotate',
        'permission-broadcasts-read',
        'permission-broadcasts-launch',
      ]),
    );
  });
});
