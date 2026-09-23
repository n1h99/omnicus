import type { ProjectAccess } from './project-access';

export type ProjectSectionKey =
  | 'conversations'
  | 'contacts'
  | 'broadcasts'
  | 'automation'
  | 'content'
  | 'connections'
  | 'settings';

export interface ProjectSectionTab {
  path: string;
  label: string;
  permissions: readonly string[];
}

export interface ProjectSection {
  key: ProjectSectionKey;
  label: string;
  description: string;
  area: 'workspace' | 'administration';
  tabs: readonly ProjectSectionTab[];
}

/** Existing URLs remain the source of truth, including detail and creation routes. */
export const projectSections: readonly ProjectSection[] = [
  {
    key: 'conversations',
    label: 'Conversations',
    description: 'Contact conversations and your full email inbox',
    area: 'workspace',
    tabs: [
      { path: 'communications', label: 'By contact', permissions: ['communications:read'] },
      { path: 'email-inbox', label: 'Email inbox', permissions: ['email:read'] },
    ],
  },
  {
    key: 'contacts',
    label: 'Contacts',
    description: 'People, groups, tags and custom fields',
    area: 'workspace',
    tabs: [
      { path: 'contacts', label: 'All contacts', permissions: ['contacts:read'] },
      { path: 'segments', label: 'Contact groups', permissions: ['contacts:read'] },
      { path: 'tags', label: 'Tags', permissions: ['tags:read'] },
      { path: 'custom-fields', label: 'Custom fields', permissions: ['contacts:read'] },
    ],
  },
  {
    key: 'broadcasts',
    label: 'Broadcasts',
    description: 'Messenger and email broadcasts, audiences and delivery',
    area: 'workspace',
    tabs: [
      { path: 'broadcasts', label: 'Messengers', permissions: ['broadcasts:read'] },
      { path: 'email-sms-broadcast', label: 'Email', permissions: ['broadcasts:read'] },
    ],
  },
  {
    key: 'automation',
    label: 'Automation',
    description: 'Build scenarios and follow contact journeys',
    area: 'workspace',
    tabs: [
      { path: 'scenarios', label: 'Scenarios', permissions: ['automation:read'] },
      { path: 'automation-activity', label: 'Activity', permissions: ['automation:read'] },
    ],
  },
  {
    key: 'content',
    label: 'Content',
    description: 'Reusable message templates and shared files',
    area: 'workspace',
    tabs: [
      { path: 'templates', label: 'Message templates', permissions: ['templates:read'] },
      { path: 'media-assets', label: 'Files', permissions: ['media:read'] },
    ],
  },
  {
    key: 'connections',
    label: 'Connections',
    description: 'Messaging channels, CRM and email setup',
    area: 'administration',
    tabs: [
      { path: 'channels', label: 'Messaging channels', permissions: ['channels:read'] },
      { path: 'crm-config', label: 'CRM integration', permissions: ['integrations:manage'] },
      {
        path: 'email-settings',
        label: 'Email setup',
        permissions: ['email:read', 'email:manage'],
      },
    ],
  },
  {
    key: 'settings',
    label: 'Settings',
    description: 'Project preferences, team access and diagnostics',
    area: 'administration',
    tabs: [
      { path: 'settings', label: 'General', permissions: ['project:manage'] },
      { path: 'members', label: 'Members', permissions: ['project:read'] },
      { path: 'roles', label: 'Roles', permissions: ['project:read'] },
      { path: 'operations', label: 'Diagnostics & audit', permissions: ['project:read'] },
    ],
  },
];

/** A group is visible if at least one of its children is accessible. */
export function availableProjectSections(access: ProjectAccess | undefined): ProjectSection[] {
  return projectSections
    .map((section) => ({
      ...section,
      tabs: section.tabs.filter((tab) =>
        tab.permissions.every((permission) => access?.permissions.includes(permission)),
      ),
    }))
    .filter((section) => section.tabs.length > 0);
}

export function projectSectionFor(pathname: string): ProjectSection | undefined {
  const route = pathname.match(/^\/projects\/[^/]+\/([^/]+)(?:\/|$)/)?.[1];
  return projectSections.find((section) => section.tabs.some((tab) => tab.path === route));
}

export function projectSectionPath(projectId: string, section: ProjectSection): string {
  return `/projects/${projectId}/${section.tabs[0]!.path}`;
}
