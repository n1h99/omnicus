import { describe, expect, it } from 'vitest';

import { breadcrumbsFor } from './breadcrumbs';

describe('breadcrumbsFor', () => {
  it('builds a navigable project hierarchy', () => {
    expect(breadcrumbsFor('/projects/project-a/contacts/contact-a', 'Omnicus Local')).toEqual([
      { label: 'Projects', path: '/projects' },
      { label: 'Omnicus Local', path: '/projects/project-a' },
      { label: 'Contacts', path: '/projects/project-a/contacts' },
      { label: 'Contact details' },
    ]);
  });

  it('labels creation routes without exposing identifiers', () => {
    expect(breadcrumbsFor('/projects/project-a/channels/new', 'Omnicus Local')).toEqual([
      { label: 'Projects', path: '/projects' },
      { label: 'Omnicus Local', path: '/projects/project-a' },
      { label: 'Channels', path: '/projects/project-a/channels' },
      { label: 'Connect a channel' },
    ]);
  });

  it('keeps root routes concise', () => {
    expect(breadcrumbsFor('/projects')).toEqual([{ label: 'Projects' }]);
    expect(breadcrumbsFor('/users')).toEqual([{ label: 'Users' }]);
  });

  it('uses the actual project name on the project overview', () => {
    expect(breadcrumbsFor('/projects/project-a', 'Omnicus Local')).toEqual([
      { label: 'Projects', path: '/projects' },
      { label: 'Omnicus Local' },
    ]);
  });

  it('labels the unified communications workspace', () => {
    expect(breadcrumbsFor('/projects/project-a/communications', 'Omnicus Local')).toEqual([
      { label: 'Projects', path: '/projects' },
      { label: 'Omnicus Local', path: '/projects/project-a' },
      { label: 'Communications' },
    ]);
  });
});
