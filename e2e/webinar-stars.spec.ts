import { expect, test, type Page } from '@playwright/test';

const identity = {
  email: 'reviewer@example.test',
  firstName: 'Alex',
  lastName: 'Morgan',
  globalPermissions: [],
  globalRoleNames: [],
  status: 'ACTIVE',
  userId: 'user-a',
};
async function workspace(page: Page, allowed = true) {
  let connection: {
    id: string;
    revision: number;
    verifiedAt: string | null;
    updatedAt: string;
  } | null = null;
  const writes: Array<{ method: string; body: unknown }> = [];
  await page.addInitScript(
    (user) => localStorage.setItem('omnicus-auth', JSON.stringify({ token: 'test-session', user })),
    identity,
  );
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const respond = (data: unknown) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data, meta: {} }) });
    if (path.endsWith('/auth/me')) return respond(identity);
    if (path.endsWith('/access'))
      return respond({
        permissions: allowed ? ['project:read', 'integrations:manage'] : ['project:read'],
        projectRoleName: 'Test role',
      });
    const project = {
      id: 'project-a',
      name: 'Webinar testing',
      slug: 'webinar-testing',
      status: 'ACTIVE',
      timezone: 'Asia/Baku',
      locale: 'en',
      settings: {},
    };
    if (path === '/api/v1/projects') return respond([project]);
    if (path === '/api/v1/projects/project-a') return respond(project);
    if (path.endsWith('/webinar-stars')) {
      if (req.method() === 'PUT') {
        writes.push({ method: 'PUT', body: req.postDataJSON() });
        connection = {
          id: 'connection-a',
          revision: (connection?.revision ?? 0) + 1,
          verifiedAt: null,
          updatedAt: '2026-11-02T10:00:00Z',
        };
      }
      if (req.method() === 'DELETE') {
        writes.push({ method: 'DELETE', body: null });
        connection = null;
        return respond({ disconnected: true });
      }
      return respond(connection);
    }
    if (path.endsWith('/webinar-stars/test')) {
      if (connection) connection.verifiedAt = '2026-11-02T10:01:00Z';
      return respond({ ok: true });
    }
    if (path.endsWith('/webinar-stars/webinars'))
      return respond({ items: [], hasMore: false, offset: 0 });
    if (path.endsWith('/webinar-stars/reports'))
      return respond({
        items: [
          {
            id: '123',
            webinarId: '456',
            name: 'Test webinar',
            startedAtLocal: '2026-11-02 14:00:00',
            endedAtLocal: '2026-11-02 14:10:00',
            visitorsCount: 1,
            visitorsPeak: 1,
          },
        ],
        hasMore: false,
        offset: 0,
      });
    if (path.endsWith('/webinar-stars/reports/123')) {
      const visit = {
        visitorId: '-42',
        name: 'Test viewer',
        email: 'viewer@example.test',
        phone: null,
        joinedAtLocal: '2026-11-02 14:01:00',
        leftAtLocal: '2026-11-02 14:03:00',
        country: null,
        city: null,
        device: 'Desktop',
        utm: 'utm_source=test',
        comments: [{ atLocal: null, text: '<script>window.webinarInjected=true</script>' }],
        actions: [{ type: 'button_1', label: 'Seen', status: 'seen', showNumber: 1 }],
      };
      return respond({
        id: '123',
        name: 'Test webinar',
        startedAtLocal: '2026-11-02 14:00:00',
        endedAtLocal: '2026-11-02 14:10:00',
        visitorsCount: 1,
        participants: [
          { ...visit, rowKey: '0' },
          { ...visit, rowKey: '1' },
        ],
      });
    }
    return respond([]);
  });
  await page.goto('/projects/project-a/webinar-stars');
  return writes;
}

test('connects, tests, reads repeat visits safely and disconnects', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const writes = await workspace(page);
  await expect(page.getByRole('heading', { name: 'Webinar Stars', exact: true })).toBeVisible();
  await page.getByLabel('API token', { exact: true }).fill('synthetic-provider-token');
  await page.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByLabel('Replace API token')).toHaveValue('');
  await expect(page.getByText('Test required', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('No webinars found')).toBeVisible();
  await page.getByRole('tab', { name: 'Reports', exact: true }).click();
  await page.getByRole('button', { name: 'View participants' }).click();
  await expect(page.getByRole('cell', { name: 'Test viewer', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Expand row' }).first().click();
  await expect(
    page.getByText('<script>window.webinarInjected=true</script>', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => 'webinarInjected' in window)).toBe(false);
  await expect(page.getByText('Webinar Stars connection verified.', { exact: true })).toHaveCount(
    0,
  );
  await page.screenshot({ path: 'test-results/webinar-stars-report.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByText('Not connected', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Reports', exact: true })).toHaveCount(0);
  expect(writes).toEqual([
    { method: 'PUT', body: { token: 'synthetic-provider-token' } },
    { method: 'DELETE', body: null },
  ]);
  expect(errors).toEqual([]);
});

test('does not expose the workspace without integration permission', async ({ page }) => {
  await workspace(page, false);
  await expect(page.getByText('Access denied', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save connection' })).toHaveCount(0);
  await expect(page.getByLabel('API token', { exact: true })).toHaveCount(0);
});

test('connection and empty lists fit a mobile workspace', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await workspace(page);
  await page.getByLabel('API token', { exact: true }).fill('synthetic-provider-token');
  await page.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByLabel('Replace API token')).toHaveValue('');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('No webinars found')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(page.getByText('Webinar Stars connection verified.', { exact: true })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: 'test-results/webinar-stars-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('imports safely, resolves unknown participants and reconciles delivery', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await workspace(page);
  await page.getByLabel('API token', { exact: true }).fill('synthetic-provider-token');
  await page.getByRole('button', { name: 'Save connection' }).click();
  const writes: Array<{ path: string; body: unknown }> = [];
  let imported = false,
    matched = false;
  await page.route('**/api/v1/projects/project-a/webinar-stars/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.split('/webinar-stars/')[1]!;
    const reply = (data: unknown) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data, meta: {} }) });
    if (path === 'test' || path === 'webinars' || path === 'reports') return route.fallback();
    if (req.method() !== 'GET') {
      writes.push({ path, body: req.postData() ? req.postDataJSON() : null });
      if (path === 'imports') imported = true;
      if (path === 'participants/participant/contact') matched = true;
      return reply({ queued: true });
    }
    if (path === 'imports')
      return reply(
        imported
          ? [
              {
                id: 'import',
                externalReportId: '123',
                state: 'COMPLETED',
                historical: true,
                lastError: null,
                _count: { attendances: 1 },
              },
            ]
          : [],
      );
    if (path === 'participants')
      return reply([
        {
          id: 'participant',
          matchState: matched ? 'MANUAL' : 'UNMATCHED',
          matchReason: 'EMAIL_NOT_FOUND',
          contact: matched ? { id: 'contact', displayName: 'New viewer' } : null,
          result: {
            name: 'New viewer',
            email: 'new@example.test',
            watchedMinutes: 4,
            ctaClicked: null,
          },
          report: { externalReportId: '123', historical: true },
        },
      ]);
    if (path === 'actions')
      return reply([
        {
          id: 'action',
          kind: 'CRM',
          eventType: 'WEBINAR_ACTIVITY',
          state: 'UNKNOWN',
          dueAt: '2026-11-03T10:00:00Z',
          lastError: 'crm_timeout',
          attempts: 1,
        },
      ]);
    return reply([]);
  });
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('Webinar workflow', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Saved reports', exact: true }).click();
  await page.getByLabel('Report ID', { exact: true }).fill('123');
  await expect(
    page.getByLabel('Run configured automations and CRM delivery (live session only)'),
  ).not.toBeChecked();
  await page.getByRole('button', { name: 'Queue report import' }).click();
  await expect(page.getByText('Historical / no messages', { exact: true })).toBeVisible();
  expect(writes[0]).toEqual({ path: 'imports', body: { reportId: '123', historical: true } });
  await page.getByRole('tab', { name: 'Matching', exact: true }).click();
  await page.getByRole('button', { name: 'Create contact', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create and match contact' });
  await expect(dialog.getByLabel('Email', { exact: true })).toHaveValue('new@example.test');
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create contact', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Delivery log', exact: true }).click();
  await page.getByRole('button', { name: 'Reconcile', exact: true }).click();
  expect(writes).toContainEqual({ path: 'actions/action/retry', body: null });
  await page.screenshot({ path: 'test-results/webinar-workflow.png', animations: 'disabled' });
  expect(errors).toEqual([]);
});
