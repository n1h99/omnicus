import { expect, test, type Page } from '@playwright/test';

const identity = {
  email: 'admin@example.test',
  firstName: 'Admin',
  globalPermissions: [],
  globalRoleNames: [],
  lastName: 'User',
  status: 'ACTIVE',
  userId: 'user-a',
};

const contacts = [
  {
    channels: ['TELEGRAM'],
    customFields: { plan: 'priority' },
    displayName: 'Alice Example',
    eligibilityReason: null,
    eligible: true,
    email: 'alice@example.test',
    firstName: 'Alice',
    id: 'contact-a',
    lastName: 'Example',
    phone: null,
    status: 'ACTIVE',
    username: 'alice',
  },
  {
    channels: ['TELEGRAM'],
    customFields: {},
    displayName: 'Bob Example',
    eligibilityReason: null,
    eligible: true,
    email: 'bob@example.test',
    firstName: 'Bob',
    id: 'contact-b',
    lastName: 'Example',
    phone: null,
    status: 'ACTIVE',
    username: 'bob',
  },
];

async function mockApp(page: Page) {
  const envelope = (data: unknown) => JSON.stringify({ data, meta: {} });
  const segments: Array<Record<string, unknown>> = [
    {
      filter: { contactIds: ['contact-a', 'contact-b'] },
      id: 'segment-priority',
      memberCount: 2,
      name: 'Priority customers',
      status: 'ACTIVE',
      updatedAt: '2026-09-17T08:00:00.000Z',
    },
  ];
  const requests: Array<{ body: Record<string, unknown>; path: string }> = [];
  await page.addInitScript(
    (user) => localStorage.setItem('omnicus-auth', JSON.stringify({ token: 'mock-session', user })),
    identity,
  );
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/auth/me')
      return route.fulfill({ body: envelope(identity), contentType: 'application/json' });
    if (path === '/api/v1/projects/project-a/access')
      return route.fulfill({
        body: envelope({
          permissions: [
            'broadcasts:create',
            'broadcasts:read',
            'channels:read',
            'contacts:read',
            'contacts:update',
            'media:read',
            'templates:read',
          ],
          projectRoleName: 'Project Admin',
        }),
        contentType: 'application/json',
      });
    if (path === '/api/v1/projects/project-a/contacts/audience-options')
      return route.fulfill({
        body: envelope({ contacts, segments, tags: [] }),
        contentType: 'application/json',
      });
    if (path === '/api/v1/projects/project-a/segments' && request.method() === 'GET')
      return route.fulfill({ body: envelope(segments), contentType: 'application/json' });
    if (path === '/api/v1/projects/project-a/segments' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      requests.push({ body, path });
      const created = {
        filter: body.filter,
        id: 'segment-created',
        memberCount: 2,
        name: body.name,
        status: 'ACTIVE',
        updatedAt: '2026-09-17T08:10:00.000Z',
      };
      segments.push(created);
      return route.fulfill({ body: envelope(created), contentType: 'application/json' });
    }
    if (path === '/api/v1/projects/project-a/channels')
      return route.fulfill({
        body: envelope([
          {
            botUsername: 'omnicus_demo_bot',
            id: '11111111-1111-4111-8111-111111111111',
            name: 'Telegram Main',
            status: 'ACTIVE',
            type: 'TELEGRAM',
          },
        ]),
        contentType: 'application/json',
      });
    if (path === '/api/v1/projects/project-a/templates')
      return route.fulfill({ body: envelope([]), contentType: 'application/json' });
    if (path === '/api/v1/projects/project-a/media-assets')
      return route.fulfill({ body: envelope([]), contentType: 'application/json' });
    if (path === '/api/v1/projects/project-a/broadcasts' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      requests.push({ body, path });
      return route.fulfill({
        body: envelope({ id: 'broadcast-created', ...body }),
        contentType: 'application/json',
      });
    }
    return route.fulfill({
      body: JSON.stringify({ error: { code: 'NOT_FOUND', message: `No mock for ${path}` } }),
      contentType: 'application/json',
      status: 404,
    });
  });
  return requests;
}

test('creates a reusable manual group from selected contacts', async ({ page }) => {
  const requests = await mockApp(page);
  const optionsReady = page.waitForResponse((response) =>
    response.url().includes('/contacts/audience-options'),
  );
  await page.goto('/projects/project-a/segments');
  await optionsReady;

  await expect(page.getByRole('heading', { name: 'Contact groups' })).toBeVisible();
  await page.getByRole('button', { name: 'Create group' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Group name' }).fill('Launch cohort');
  const contactsSelect = dialog.getByRole('combobox', { name: 'Contacts' });
  await contactsSelect.fill('Alice Example');
  await contactsSelect.press('Enter');
  await contactsSelect.fill('Bob Example');
  await contactsSelect.press('Enter');
  await dialog.getByRole('button', { name: 'Create group' }).click();

  await expect(page.getByText('Contact group created.')).toBeVisible();
  expect(requests).toContainEqual({
    body: {
      filter: { contactIds: ['contact-a', 'contact-b'] },
      name: 'Launch cohort',
    },
    path: '/api/v1/projects/project-a/segments',
  });
});

test('creates a broadcast for one saved contact group', async ({ page }) => {
  const requests = await mockApp(page);
  const channelsReady = page.waitForResponse((response) =>
    response.url().endsWith('/projects/project-a/channels'),
  );
  await page.goto('/projects/project-a/broadcasts/new');
  await channelsReady;

  await page.getByRole('textbox', { name: 'Name' }).fill('Priority launch');
  const audienceReady = page.waitForResponse((response) =>
    response.url().includes('/contacts/audience-options'),
  );
  const channelSelect = page.getByRole('combobox', { name: 'Channel' });
  await channelSelect.fill('Telegram Main');
  await channelSelect.press('Enter');
  await audienceReady;
  const recipientSelect = page.getByRole('combobox', { name: 'Recipients' });
  await recipientSelect.click();
  await recipientSelect.press('ArrowDown');
  await recipientSelect.press('Enter');
  const groupSelect = page
    .locator('.audience-selector-grid label')
    .filter({ hasText: /^Contact group/ })
    .getByRole('combobox');
  await groupSelect.fill('Priority customers');
  await groupSelect.press('Enter');
  await page.getByRole('textbox', { name: 'Text' }).fill('Hello priority customers');
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  await expect(page).toHaveURL(/\/broadcasts\/broadcast-created$/);
  expect(requests).toContainEqual({
    body: {
      audience: { mode: 'SEGMENT', segmentId: 'segment-priority' },
      connectionId: '11111111-1111-4111-8111-111111111111',
      name: 'Priority launch',
      text: 'Hello priority customers',
    },
    path: '/api/v1/projects/project-a/broadcasts',
  });
});

test('creates a broadcast for one individual contact', async ({ page }) => {
  const requests = await mockApp(page);
  const channelsReady = page.waitForResponse((response) =>
    response.url().endsWith('/projects/project-a/channels'),
  );
  await page.goto('/projects/project-a/broadcasts/new');
  await channelsReady;

  await page.getByRole('textbox', { name: 'Name' }).fill('Alice only');
  const audienceReady = page.waitForResponse((response) =>
    response.url().includes('/contacts/audience-options'),
  );
  const channelSelect = page.getByRole('combobox', { name: 'Channel' });
  await channelSelect.fill('Telegram Main');
  await channelSelect.press('Enter');
  await audienceReady;
  const recipientSelect = page.getByRole('combobox', { name: 'Recipients' });
  await recipientSelect.click();
  await recipientSelect.press('ArrowDown');
  await recipientSelect.press('ArrowDown');
  await recipientSelect.press('Enter');
  const contactSelect = page
    .locator('.audience-selector-grid label')
    .filter({ hasText: /^Individual contacts/ })
    .getByRole('combobox');
  await contactSelect.fill('Alice Example');
  await contactSelect.press('Enter');
  await page.getByRole('textbox', { name: 'Text' }).fill('Hello Alice');
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  await expect(page).toHaveURL(/\/broadcasts\/broadcast-created$/);
  expect(requests).toContainEqual({
    body: {
      audience: { contactIds: ['contact-a'], mode: 'CONTACTS' },
      connectionId: '11111111-1111-4111-8111-111111111111',
      name: 'Alice only',
      text: 'Hello Alice',
    },
    path: '/api/v1/projects/project-a/broadcasts',
  });
});
