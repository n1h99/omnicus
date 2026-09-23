import { describe, expect, it } from 'vitest';

import {
  availableProjectSections,
  projectSectionFor,
  projectSectionPath,
  projectSections,
} from './project-sections';

const sectionsFor = (...permissions: string[]) =>
  availableProjectSections({ permissions, projectRoleName: 'Test role' });

describe('grouped project navigation', () => {
  it('organizes every existing project destination into seven unique groups', () => {
    expect(projectSections).toHaveLength(7);
    expect(projectSections.filter((section) => section.area === 'workspace')).toHaveLength(5);
    const paths = projectSections.flatMap((section) => section.tabs.map((tab) => tab.path));
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual(
      expect.arrayContaining([
        'communications',
        'email-inbox',
        'contacts',
        'segments',
        'tags',
        'custom-fields',
        'scenarios',
        'automation-activity',
        'broadcasts',
        'email-sms-broadcast',
        'templates',
        'media-assets',
        'channels',
        'crm-config',
        'email-settings',
        'settings',
        'members',
        'roles',
        'operations',
      ]),
    );
  });

  it.each([
    ['contacts/contact-a', 'contacts'],
    ['channels/new', 'connections'],
    ['channels/channel-a', 'connections'],
    ['broadcasts/new', 'broadcasts'],
    ['broadcasts/broadcast-a', 'broadcasts'],
    ['scenarios/scenario-a', 'automation'],
    ['automation-activity', 'automation'],
    ['operations', 'settings'],
    ['email-settings', 'connections'],
    ['email-inbox', 'conversations'],
  ])('keeps the group selected for legacy route %s', (path, key) => {
    expect(projectSectionFor(`/projects/project-a/${path}`)?.key).toBe(key);
  });

  it('does not match project overviews, global pages or unrelated path prefixes', () => {
    for (const path of [
      '/projects/project-a',
      '/roles',
      '/projects',
      '/projects/a/contacts-archive',
    ]) {
      expect(projectSectionFor(path)).toBeUndefined();
    }
  });

  it('hides groups until their permissions are known', () => {
    expect(availableProjectSections(undefined)).toEqual([]);
    expect(sectionsFor()).toEqual([]);
  });

  it('lets email-only operators enter the inbox without communications access', () => {
    const sections = sectionsFor('email:read');
    expect(sections.map((section) => section.key)).toEqual(['conversations']);
    expect(projectSectionPath('project-a', sections[0]!)).toBe('/projects/project-a/email-inbox');
  });

  it('keeps media, templates and contact metadata permissions independent', () => {
    const sections = sectionsFor('media:read', 'tags:read');
    expect(sections.map((section) => section.key)).toEqual(['contacts', 'content']);
    expect(sections.flatMap((section) => section.tabs.map((tab) => tab.path))).toEqual([
      'tags',
      'media-assets',
    ]);
  });

  it('requires both email read and manage for email setup, not project manage', () => {
    expect(sectionsFor('email:manage')).toEqual([]);
    expect(
      sectionsFor('email:read', 'email:manage')
        .find((section) => section.key === 'connections')
        ?.tabs.map((tab) => tab.path),
    ).toEqual(['email-settings']);
  });

  it('keeps team and diagnostics accessible without general project settings', () => {
    const sections = sectionsFor('project:read');
    expect(sections.map((section) => section.key)).toEqual(['settings']);
    expect(sections[0]?.tabs.map((tab) => tab.path)).toEqual(['members', 'roles', 'operations']);
    expect(projectSectionPath('project-a', sections[0]!)).toBe('/projects/project-a/members');
  });

  it('chooses CRM as the entry for a CRM-only integration manager', () => {
    const section = sectionsFor('integrations:manage')[0]!;
    expect(section.key).toBe('connections');
    expect(projectSectionPath('project-a', section)).toBe('/projects/project-a/crm-config');
  });
});
