import type { Prisma } from './generated/prisma/client';

export const seedProjectRoles = [
  [
    'Project Admin',
    'project-admin',
    [
      'project:read',
      'email:read',
      'email:send',
      'email:manage',
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
      'media:manage',
      'templates:read',
      'templates:manage',
    ],
  ],
  [
    'Automation Editor',
    'automation-editor',
    [
      'project:read',
      'automation:read',
      'automation:manage',
      'media:read',
      'media:manage',
      'templates:read',
      'templates:manage',
    ],
  ],
  [
    'Integration Manager',
    'integration-manager',
    [
      'project:read',
      'integrations:manage',
      'channels:read',
      'channels:manage',
      'channels:rotate_secrets',
    ],
  ],
  [
    'Contact Manager',
    'contact-manager',
    [
      'project:read',
      'contacts:read',
      'contacts:manage',
      'contacts:update',
      'contacts:export',
      'contacts:merge',
      'communications:read',
      'communications:send',
      'tags:read',
      'tags:manage',
    ],
  ],
  [
    'Viewer',
    'viewer',
    [
      'project:read',
      'contacts:read',
      'communications:read',
      'tags:read',
      'automation:read',
      'media:read',
      'templates:read',
    ],
  ],
] as const;

export async function backfillSystemProjectRoles(
  transaction: Pick<Prisma.TransactionClient, 'projectRole' | 'projectRolePermission'>,
  projectId: string,
  permissionIdsByCode: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [name, normalizedName, permissions] of seedProjectRoles) {
    const role = await transaction.projectRole.upsert({
      create: { name, normalizedName, projectId, system: true },
      update: { name, system: true },
      where: { projectId_normalizedName: { normalizedName, projectId } },
    });
    for (const permissionCode of permissions) {
      const permissionId = permissionIdsByCode.get(permissionCode);
      if (!permissionId) {
        throw new Error(`Missing seed permission: ${permissionCode}`);
      }
      await transaction.projectRolePermission.upsert({
        create: { permissionId, projectId, projectRoleId: role.id },
        update: {},
        where: {
          projectId_projectRoleId_permissionId: {
            permissionId,
            projectId,
            projectRoleId: role.id,
          },
        },
      });
    }
  }
}
