const permissionLabels: Record<string, string> = {
  'automation:manage': 'Create and manage automations',
  'automation:read': 'View automations and activity',
  'broadcasts:cancel': 'Cancel broadcasts',
  'broadcasts:create': 'Create broadcasts',
  'broadcasts:launch': 'Launch broadcasts',
  'broadcasts:pause': 'Pause broadcasts',
  'broadcasts:read': 'View broadcasts',
  'channels:manage': 'Manage channel connections',
  'channels:read': 'View channels',
  'channels:rotate_secrets': 'Replace channel credentials',
  'contacts:export': 'Export contacts',
  'contacts:manage': 'Manage contacts',
  'contacts:merge': 'Merge duplicate contacts',
  'contacts:read': 'View contacts',
  'contacts:update': 'Update contact details',
  'communications:read': 'View communications',
  'communications:send': 'Send messages to contacts',
  'integrations:manage': 'Manage CRM integrations',
  'media:manage': 'Manage media files',
  'media:read': 'View media files',
  'members:manage': 'Manage project members',
  'project:manage': 'Manage project settings',
  'project:read': 'Open the project',
  'projects:create': 'Create projects',
  'projects:read': 'View projects',
  'roles:manage': 'Manage system roles',
  'tags:manage': 'Manage tags and segments',
  'tags:read': 'View tags and segments',
  'templates:manage': 'Manage message templates',
  'templates:read': 'View message templates',
  'users:manage': 'Manage user accounts',
  'users:read': 'View user accounts',
};

const permissionGroupLabels: Record<string, string> = {
  automation: 'Automations',
  broadcasts: 'Broadcasts',
  channels: 'Channels',
  contacts: 'Contacts',
  communications: 'Communications',
  integrations: 'Integrations',
  media: 'Media',
  members: 'Members',
  project: 'Project',
  projects: 'Projects',
  roles: 'Roles',
  tags: 'Tags and segments',
  templates: 'Templates',
  users: 'Users',
};

const auditActions: Record<string, string> = {
  'auth.login.succeeded': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.logout_all': 'Signed out on all devices',
  'auth.password_reset.link_created': 'Created a password reset link',
  'auth.password_reset.requested': 'Requested a password reset',
  'global.invitation.created': 'Created a system invitation',
  'invitation.accepted': 'Accepted an invitation',
  'project.invitation.created': 'Created a project invitation',
  'project.cloned': 'Cloned a project',
  'role.created': 'Created a role',
  'role.deleted': 'Deleted a role',
  'role.updated': 'Updated a role',
  'scenario.archived': 'Archived an automation',
  'scenario.created': 'Created an automation',
  'scenario.published': 'Published an automation',
  'scenario.updated': 'Saved an automation draft',
  'user.updated': 'Updated a user account',
};

const entityLabels: Record<string, string> = {
  AuditLog: 'Audit event',
  GlobalRole: 'System role',
  GlobalUserInviteToken: 'System invitation',
  PasswordResetToken: 'Password reset',
  Project: 'Project',
  ProjectRole: 'Project role',
  ProjectUserInviteToken: 'Project invitation',
  Scenario: 'Automation',
  ScenarioExecution: 'Automation run',
  Session: 'Sign-in session',
  User: 'User account',
};

function titleFromCode(value: string): string {
  const result = value
    .replaceAll('.', ' ')
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return result ? `${result[0]?.toUpperCase() ?? ''}${result.slice(1)}` : 'Not specified';
}

export function humanizePermission(code: string): string {
  return permissionLabels[code] ?? titleFromCode(code.split(':').at(-1) ?? code);
}

export function humanizePermissionGroup(code: string): string {
  return permissionGroupLabels[code] ?? titleFromCode(code);
}

export function humanizeAuditAction(action: string): string {
  return auditActions[action] ?? titleFromCode(action);
}

export function humanizeEntity(entity: string): string {
  return entityLabels[entity] ?? titleFromCode(entity);
}

export function humanizeReason(reason: string | null): string {
  return reason ? titleFromCode(reason) : 'No additional reason';
}

export function humanizeStatus(status: string): string {
  const labels: Record<string, string> = {
    ACTIVE: 'Active',
    CANCELLED: 'Stopped',
    COMPLETED: 'Completed',
    DEAD_LETTER: 'Could not be processed',
    FAILED: 'Needs attention',
    PAUSED: 'Paused',
    PENDING: 'Waiting to start',
    PROCESSING: 'In progress',
    RETRY: 'Waiting to try again',
    RUNNING: 'In progress',
    SENT: 'Sent',
    SUCCEEDED: 'Completed',
    UNKNOWN: 'Needs confirmation',
    WAITING: 'Waiting',
  };
  return labels[status] ?? titleFromCode(status);
}

export function humanizeOperationSource(source: string): string {
  const labels: Record<string, string> = {
    AUTOMATION: 'Automation run',
    BROADCAST: 'Broadcast',
    INBOX: 'Incoming update',
    OUTBOX: 'Outgoing action',
  };
  return labels[source] ?? titleFromCode(source);
}
