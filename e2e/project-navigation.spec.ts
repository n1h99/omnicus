import { expect, test, type Page } from '@playwright/test';

const identity = {
  email: 'reviewer@example.test',
  firstName: 'Alex',
  lastName: 'Morgan',
  globalPermissions: [],
  globalRoleNames: ['super-admin'],
  status: 'ACTIVE',
  userId: 'user-a',
};
const project = {
  id: 'project-a',
  name: 'Customer workspace',
  slug: 'customer-workspace',
  description: 'Customer conversations and automation, in one workspace.',
  status: 'ACTIVE',
  locale: 'en',
  timezone: 'Asia/Baku',
  settings: {},
  createdAt: '2026-09-01T10:00:00Z',
  updatedAt: '2026-09-23T10:00:00Z',
};
const fullAccess = [
  'project:read',
  'project:manage',
  'members:manage',
  'contacts:read',
  'contacts:update',
  'communications:read',
  'tags:read',
  'automation:read',
  'automation:manage',
  'channels:read',
  'channels:manage',
  'integrations:manage',
  'broadcasts:read',
  'templates:read',
  'media:read',
  'email:read',
  'email:manage',
  'email:send',
];
const errorsByPage = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  errorsByPage.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});
test.afterEach(({ page }) => expect(errorsByPage.get(page)).toEqual([]));

async function mockProject(page: Page, permissions = fullAccess) {
  const requests: string[] = [];
  await page.addInitScript((user) => {
    localStorage.setItem('omnicus-auth', JSON.stringify({ token: 'navigation-test', user }));
  }, identity);
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    const respond = (data: unknown) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data, meta: {} }) });
    if (path.endsWith('/auth/me')) return respond(identity);
    if (path.endsWith('/access')) return respond({ permissions, projectRoleName: 'Test role' });
    if (path === '/api/v1/projects') return respond([project]);
    if (path === '/api/v1/projects/project-a') return respond(project);
    if (
      path.endsWith('/communications/contacts') ||
      path.endsWith('/contacts') ||
      path.endsWith('/threads') ||
      path.endsWith('/operations') ||
      path.endsWith('/crm-operations') ||
      path.endsWith('/audit')
    ) {
      return respond({ items: [], total: 0, page: 1, pageSize: 30 });
    }
    if (path.endsWith('/automation-activity'))
      return respond({
        items: [],
        total: 0,
        page: 1,
        pageSize: 25,
        periodDays: 30,
        breakdown: { reasons: [], scenarios: [], statuses: [] },
        summary: { active: 0, completed: 0, problems: 0, total: 0, waiting: 0 },
        trend: [],
        trendSampled: false,
      });
    if (path.endsWith('/audience-options'))
      return respond({ contacts: [], segments: [], tags: [], suppressions: [] });
    if (path.endsWith('/crm-config')) return respond(null);
    if (path.endsWith('/operations/summary'))
      return respond({ inbox: [], outbox: [], executions: [] });
    if (path.endsWith('/email-inbox/health'))
      return respond({ counts: {}, failedReceipts: [], failedAutomations: [] });
    return respond([]);
  });
  return requests;
}

const menu = (page: Page) => page.getByRole('menu', { name: 'Project navigation' });
const tabs = (page: Page, group: string) =>
  page.getByRole('navigation', { name: `${group} sections` });

test('project overview has five workspaces and two administration cards', async ({ page }) => {
  await page.setViewportSize({ width: 1560, height: 1050 });
  await mockProject(page);
  await page.goto('/projects/project-a');
  await expect(page.locator('.project-navigation-card')).toHaveCount(7);
  await expect(page.locator('.project-navigation-card strong')).toHaveText([
    'Conversations',
    'Contacts',
    'Broadcasts',
    'Automation',
    'Content',
    'Connections',
    'Settings',
  ]);
  await expect(page.locator('.project-administration .project-navigation-card')).toHaveCount(2);
  for (const name of [
    'Conversations',
    'Contacts',
    'Broadcasts',
    'Automation',
    'Content',
    'Connections',
    'Settings',
  ]) {
    await expect(menu(page).getByRole('link', { name, exact: true })).toBeVisible();
  }
  await page.screenshot({
    path: 'test-results/project-navigation-overview.png',
    fullPage: true,
    animations: 'disabled',
  });
  await menu(page).getByText('System administration', { exact: true }).click();
  await expect(menu(page).getByRole('link', { name: 'Users', exact: true })).toBeVisible();
});

test('contact tools share tabs while legacy addresses and browser history keep working', async ({
  page,
}) => {
  await mockProject(page);
  await page.goto('/projects/project-a/tags');
  await expect(
    tabs(page, 'Contacts').getByRole('link', { name: 'Tags', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await tabs(page, 'Contacts').getByRole('link', { name: 'Contact groups', exact: true }).click();
  await expect(page).toHaveURL(/\/segments$/);
  await expect(page.getByRole('heading', { name: 'Contact groups', exact: true })).toBeVisible();
  await tabs(page, 'Contacts').getByRole('link', { name: 'Custom fields', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Custom fields', exact: true })).toBeVisible();
  await page.goBack();
  await expect(
    tabs(page, 'Contacts').getByRole('link', { name: 'Contact groups', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await tabs(page, 'Contacts').getByRole('link', { name: 'All contacts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Contacts', exact: true })).toBeVisible();
  await expect(page.locator('.ant-spin-spinning')).toHaveCount(0);
  await page.screenshot({
    path: 'test-results/project-navigation-contacts.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('automation, content and broadcasts expose their existing tools within each group', async ({
  page,
}) => {
  await mockProject(page);
  await page.goto('/projects/project-a/scenarios');
  await tabs(page, 'Automation').getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Automation activity', exact: true }),
  ).toBeVisible();
  await menu(page).getByRole('link', { name: 'Content', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Message templates', exact: true })).toBeVisible();
  await tabs(page, 'Content').getByRole('link', { name: 'Files', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Content library', exact: true })).toBeVisible();
  await menu(page).getByRole('link', { name: 'Broadcasts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Broadcasts', exact: true })).toBeVisible();
  await tabs(page, 'Broadcasts').getByRole('link', { name: 'Email', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Email broadcasts', exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: /SMS.*Coming soon/ })).toBeDisabled();
});

test('connections groups channels, CRM and email setup; settings groups team and diagnostics', async ({
  page,
}) => {
  await mockProject(page);
  await page.goto('/projects/project-a/channels');
  await tabs(page, 'Connections')
    .getByRole('link', { name: 'CRM integration', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'CRM integration', exact: true })).toBeVisible();
  await tabs(page, 'Connections').getByRole('link', { name: 'Email setup', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Email setup', exact: true })).toBeVisible();
  await expect(page.getByText('Keep existing business email working')).toBeVisible();
  await menu(page).getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Project settings', exact: true })).toBeVisible();
  await tabs(page, 'Settings').getByRole('link', { name: 'Members', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Project members', exact: true })).toBeVisible();
  await tabs(page, 'Settings').getByRole('link', { name: 'Roles', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Project roles', exact: true })).toBeVisible();
  await tabs(page, 'Settings')
    .getByRole('link', { name: 'Diagnostics & audit', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Operations & audit', exact: true }),
  ).toBeVisible();
});

test('legacy diagnostics links retain filters when their active tab or group is clicked', async ({
  page,
}) => {
  await mockProject(page);
  const url = '/projects/project-a/operations?source=OUTBOX&status=FAILED&connectionId=channel-a';
  await page.goto(url);
  await tabs(page, 'Settings')
    .getByRole('link', { name: 'Diagnostics & audit', exact: true })
    .click();
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(url);
  await menu(page).getByRole('link', { name: 'Settings', exact: true }).click();
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(url);
  await page.reload();
  await expect(
    tabs(page, 'Settings').getByRole('link', { name: 'Diagnostics & audit', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
});

test('creation routes keep the correct group and its tab returns to the list', async ({ page }) => {
  await mockProject(page);
  await page.goto('/projects/project-a/channels/new?type=telegram');
  await expect(page.getByRole('heading', { name: 'Connect a channel', exact: true })).toBeVisible();
  const channelTab = tabs(page, 'Connections').getByRole('link', {
    name: 'Messaging channels',
    exact: true,
  });
  await expect(channelTab).toHaveAttribute('aria-current', 'page');
  await channelTab.click();
  await expect(page).toHaveURL(/\/channels$/);
  await expect(page.getByRole('heading', { name: 'Channels', exact: true })).toBeVisible();
});

test('conversations switches between the contact workspace and full email inbox', async ({
  page,
}) => {
  await mockProject(page);
  await page.goto('/projects/project-a/communications?channel=email');
  await expect(page.getByRole('heading', { name: 'Communications', exact: true })).toBeVisible();
  await tabs(page, 'Conversations').getByRole('link', { name: 'By contact', exact: true }).click();
  await expect(page).toHaveURL(/communications\?channel=email$/);
  await tabs(page, 'Conversations').getByRole('link', { name: 'Email inbox', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Email Inbox', exact: true })).toBeVisible();
  await tabs(page, 'Conversations').getByRole('link', { name: 'By contact', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Communications', exact: true })).toBeVisible();
});

test('email-only access opens the inbox and cannot open email setup or contact conversations', async ({
  page,
}) => {
  const requests = await mockProject(page, ['email:read']);
  await page.goto('/projects/project-a');
  await expect(page.locator('.project-navigation-card')).toHaveCount(1);
  await page.locator('.project-navigation-card').click();
  await expect(page).toHaveURL(/\/email-inbox$/);
  await expect(tabs(page, 'Conversations').getByRole('link')).toHaveCount(1);
  await expect(menu(page).getByRole('link', { name: 'Connections', exact: true })).toHaveCount(0);
  await page.goto('/projects/project-a/email-settings');
  await expect(page.getByText('Access denied', { exact: true })).toBeVisible();
  expect(requests.some((path) => path.endsWith('/email-inbox/domains'))).toBe(false);
  await page.goto('/projects/project-a/communications');
  await expect(page.getByText('Access denied', { exact: true })).toBeVisible();
});

test('email setup remains accessible without project manage and old setup links retain inbox context', async ({
  page,
}) => {
  await mockProject(page, ['email:read', 'email:manage']);
  await page.goto(
    '/projects/project-a/email-inbox?view=settings&folder=sent&mailbox=box-a&contactId=contact-a',
  );
  await expect(page).toHaveURL(/\/email-settings\?/);
  expect(new URL(page.url()).searchParams.get('view')).toBeNull();
  await expect(tabs(page, 'Connections').getByRole('link')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Email setup', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Back to inbox/ }).click();
  await expect(page).toHaveURL(/\/email-inbox\?/);
  const params = new URL(page.url()).searchParams;
  expect(Object.fromEntries(params)).toEqual({
    folder: 'sent',
    mailbox: 'box-a',
    contactId: 'contact-a',
  });
});

test('read-only project members keep diagnostics and roles without general settings', async ({
  page,
}) => {
  await mockProject(page, ['project:read']);
  await page.goto('/projects/project-a');
  await page.locator('.project-navigation-card').click();
  await expect(page).toHaveURL(/\/members$/);
  await expect(
    tabs(page, 'Settings').getByRole('link', { name: 'General', exact: true }),
  ).toHaveCount(0);
  await tabs(page, 'Settings').getByRole('link', { name: 'Roles', exact: true }).click();
  await expect(page.getByRole('button', { name: /Create role/ })).toHaveCount(0);
  await tabs(page, 'Settings')
    .getByRole('link', { name: 'Diagnostics & audit', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Operations & audit', exact: true }),
  ).toBeVisible();
  await page.goto('/projects/project-a/settings');
  await expect(page.getByText('Access denied', { exact: true })).toBeVisible();
});

test('CRM-only access has its own connection entry without requiring channels access', async ({
  page,
}) => {
  await mockProject(page, ['integrations:manage']);
  await page.goto('/projects/project-a');
  await page.locator('.project-navigation-card').click();
  await expect(page).toHaveURL(/\/crm-config$/);
  await expect(tabs(page, 'Connections').getByRole('link')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'CRM integration', exact: true })).toBeVisible();
});

test('mobile project menu and horizontally scrollable section tabs remain usable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockProject(page);
  await page.goto('/projects/project-a');
  await expect(page.locator('.project-navigation-card')).toHaveCount(7);
  await page.screenshot({
    path: 'test-results/project-navigation-mobile-overview.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await expect(menu(page).getByRole('link', { name: 'Connections', exact: true })).toBeVisible();
  await page.screenshot({
    path: 'test-results/project-navigation-mobile-menu.png',
    fullPage: true,
    animations: 'disabled',
  });
  await menu(page).getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Project settings', exact: true })).toBeVisible();
  await tabs(page, 'Settings').getByRole('link', { name: 'Roles', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Project roles', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: 'test-results/project-navigation-mobile-tabs.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('collapsed desktop navigation still exposes project groups', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await mockProject(page);
  await page.goto('/projects/project-a');
  await page.getByRole('button', { name: 'Collapse navigation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Expand navigation', exact: true })).toBeVisible();
  const contacts = menu(page)
    .getByRole('menuitem')
    .filter({
      has: page.getByRole('link', { name: 'Contacts', exact: true }),
    });
  await contacts.focus();
  await contacts.press('Enter');
  await expect(page.getByRole('heading', { name: 'Contacts', exact: true })).toBeVisible();
  await page.screenshot({
    path: 'test-results/project-navigation-collapsed.png',
    fullPage: true,
    animations: 'disabled',
  });
});
