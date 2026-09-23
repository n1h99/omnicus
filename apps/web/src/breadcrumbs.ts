import {
  projectSectionFor,
  projectSectionPath,
  projectSections,
  type ProjectSection,
} from './project-sections';

export interface AppBreadcrumb {
  label: string;
  path?: string;
}

const sectionLabels: Record<string, string> = {
  broadcasts: 'Broadcasts',
  channels: 'Channels',
  communications: 'By contact',
  contacts: 'Contacts',
  'crm-config': 'CRM integration',
  'custom-fields': 'Custom fields',
  'email-sms-broadcast': 'Email broadcasts',
  'email-inbox': 'Email Inbox',
  'email-settings': 'Email setup',
  'media-assets': 'Content library',
  members: 'Members',
  operations: 'Operations & audit',
  'automation-activity': 'Automation activity',
  roles: 'Roles',
  scenarios: 'Automation',
  segments: 'Contact groups',
  tags: 'Tags',
  templates: 'Templates',
  settings: 'Settings',
};

const detailLabels: Record<string, string> = {
  broadcasts: 'Broadcast details',
  channels: 'Channel details',
  contacts: 'Contact details',
  scenarios: 'Scenario editor',
};

const newLabels: Record<string, string> = {
  broadcasts: 'New broadcast',
  channels: 'Connect a channel',
  scenarios: 'New scenario',
};

export function breadcrumbsFor(
  pathname: string,
  projectName?: string,
  availableSections: readonly ProjectSection[] = projectSections,
): AppBreadcrumb[] {
  const segments = pathname.split('/').filter(Boolean);

  if (segments[0] === 'users') return [{ label: 'Users' }];
  if (segments[0] === 'roles') return [{ label: 'System roles' }];
  if (segments[0] === 'system-health') return [{ label: 'System health' }];
  if (segments[0] !== 'projects') return [];
  if (segments.length === 1) return [{ label: 'Projects' }];

  const breadcrumbs: AppBreadcrumb[] = [{ label: 'Projects', path: '/projects' }];
  const projectId = segments[1];
  if (!projectId) return breadcrumbs;

  const projectPath = `/projects/${projectId}`;

  if (segments.length === 2) {
    breadcrumbs.push({ label: projectName ?? 'Project' });
    return breadcrumbs;
  }

  breadcrumbs.push({ label: projectName ?? 'Project', path: projectPath });
  const section = segments[2];
  if (!section) return breadcrumbs;

  const sectionLabel = sectionLabels[section] ?? section;
  const group = projectSectionFor(pathname);
  if (group && group.label !== sectionLabel) {
    const available = availableSections.find((item) => item.key === group.key);
    breadcrumbs.push({
      label: group.label,
      ...(available ? { path: projectSectionPath(projectId, available) } : {}),
    });
  }

  if (segments.length === 3) {
    breadcrumbs.push({ label: sectionLabel });
    return breadcrumbs;
  }

  breadcrumbs.push({ label: sectionLabel, path: `${projectPath}/${section}` });
  const detail = segments[3];
  if (!detail) return breadcrumbs;

  breadcrumbs.push({
    label: detail === 'new' ? (newLabels[section] ?? 'New') : (detailLabels[section] ?? 'Details'),
  });
  return breadcrumbs;
}
