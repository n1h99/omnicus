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
        permissions: allowed
          ? ['project:read', 'integrations:manage', 'automation:read', 'automation:manage']
          : ['project:read'],
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

test('shows normalized report results, filters participants and renders comments safely', async ({
  page,
}) => {
  await workspace(page);
  const requests: URL[] = [];
  await page.route('**/webinar-stars/imports', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: [{ id: 'saved-a', externalReportId: '123', event: { title: 'Product webinar' } }],
        meta: {},
      }),
    }),
  );
  await page.route('**/webinar-stars/reporting**', (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const items =
      url.searchParams.get('cta') === 'no'
        ? []
        : [
            {
              id: 'viewer-a',
              contactId: 'contact-a',
              contactName: 'Alex',
              crmLeadId: 'lead-a',
              matchState: 'MATCHED',
              matchReason: 'TRACKING_TOKEN',
              result: {
                name: 'Alex',
                email: 'viewer@example.test',
                phone: '1234567890',
                status: 'COMPLETED',
                watchedSeconds: 145,
                watchedPercentage: 100,
                watchedMinutes: 2.42,
                ctaClicked: true,
                bannerClicked: null,
                isReplay: false,
                commentsCount: 1,
                comments: [
                  {
                    text: '<script>window.reportInjected=true</script>',
                    atLocal: '2026-11-03 10:02:00',
                  },
                ],
                distributorId: 'partner-7',
                utm: { utm_source: 'newsletter', utm_campaign: 'spring' },
              },
            },
          ];
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          report: {
            id: 'saved-a',
            externalReportId: '123',
            state: 'COMPLETED',
            historical: false,
            lastError: null,
            processedAt: '2026-11-03T06:05:00Z',
            summary: { startedAtLocal: '2026-11-03 10:00:00', endedAtLocal: '2026-11-03 10:02:25' },
            event: { title: 'Product webinar', timezone: 'Asia/Baku' },
          },
          summary: {
            registered: 2,
            attended: 1,
            missed: 1,
            completed: 1,
            partial: 0,
            ctaClicked: 1,
            comments: 1,
            unmatched: 0,
            deliveryErrors: 0,
          },
          items,
          total: items.length,
          page: 1,
          pageSize: 20,
        },
        meta: {},
      }),
    });
  });
  await page.getByLabel('API token', { exact: true }).fill('synthetic-provider-token');
  await page.getByRole('button', { name: 'Save connection' }).click();
  await page.getByRole('button', { name: 'Test connection' }).click();
  await page.getByRole('tab', { name: 'Results', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Webinar results' })).toBeVisible();
  await expect(page.getByRole('cell').filter({ hasText: '2m 25s' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'spring', exact: false })).toBeVisible();
  await page.getByLabel('Search report participants').fill('Alex');
  await expect.poll(() => requests.at(-1)?.searchParams.get('search')).toBe('Alex');
  await page.getByLabel('CTA filter').click();
  await page
    .locator('.ant-select-dropdown:visible')
    .getByText('CTA not clicked', { exact: true })
    .click();
  await expect(
    page.locator('.ant-empty-description').filter({ hasText: /^No data$/ }),
  ).toBeVisible();
  await page.getByLabel('CTA filter').click();
  await page
    .locator('.ant-select-dropdown:visible')
    .getByText('CTA clicked', { exact: true })
    .click();
  await page.getByRole('button', { name: 'View result', exact: true }).click();
  await expect(
    page.getByText('<script>window.reportInjected=true</script>', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => 'reportInjected' in window)).toBe(false);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelectorAll('.ant-table-content').forEach((element) => {
        element.scrollLeft = 0;
      });
    });
    await page.screenshot({
      path: `test-results/webinar-results-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
});

test('creates a customer-facing session-scoped scenario draft without publishing it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await workspace(page);
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  let createdGraph: unknown;
  await page.route('**/api/v1/projects/project-a/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    const reply = (data: unknown) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data, meta: {} }) });
    if (path.endsWith('/webinar-stars/events'))
      return reply([
        {
          id: 'session-a',
          title: 'Product webinar',
          cancelledAt: null,
          providerWebinarId: '456',
          roomUrl: 'https://efir.webinar-stars.com/webinar/abc/',
          timezone: 'UTC',
          scheduledAt: '2026-11-03T10:00:00Z',
          endsAt: '2026-11-03T11:00:00Z',
          settings: {},
          _count: { invitations: 0, imports: 0 },
        },
      ]);
    if (path.endsWith('/channels'))
      return reply([{ id: 'bot-a', name: 'Customer bot', type: 'TELEGRAM', status: 'ACTIVE' }]);
    if (path.endsWith('/tags')) return reply([{ id: 'tag-a', name: 'Webinar interest' }]);
    if (path.endsWith('/scenarios') && req.method() === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>;
      writes.push({ path, body });
      createdGraph = body.graph;
      return reply({ id: 'new-draft', status: 'DRAFT' });
    }
    if (path.endsWith('/scenarios/new-draft'))
      return reply({
        id: 'new-draft',
        name: 'Customer follow-up',
        status: 'DRAFT',
        activeVersionId: null,
        draftVersionId: 'version-a',
        activeVersion: null,
        draftVersion: { id: 'version-a', graph: createdGraph },
        versions: [],
        updatedAt: '2026-11-03T10:00:00Z',
      });
    return route.fallback();
  });
  await page.getByLabel('API token', { exact: true }).fill('synthetic-provider-token');
  await page.getByRole('button', { name: 'Save connection' }).click();
  await page.getByRole('button', { name: 'Test connection' }).click();
  await page.getByRole('tab', { name: 'Scenarios', exact: true }).click();
  await page.getByLabel('Webinar session', { exact: true }).click();
  await page
    .locator('.ant-select-dropdown:visible')
    .getByText('Product webinar', { exact: true })
    .click();
  await page.getByLabel('When to send', { exact: true }).click();
  await page
    .locator('.ant-select-dropdown:visible')
    .getByText('Follow up after a CTA click', { exact: true })
    .click();
  await page.getByLabel('Telegram bot', { exact: true }).click();
  await page
    .locator('.ant-select-dropdown:visible')
    .getByText('Customer bot', { exact: true })
    .click();
  await page.getByLabel('Add a contact tag (optional)', { exact: true }).click();
  await page
    .locator('.ant-select-dropdown:visible')
    .getByText('Webinar interest', { exact: true })
    .click();
  await page
    .getByLabel('Message to the participant', { exact: true })
    .fill('Спасибо за интерес к вебинару!');
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `test-results/webinar-scenarios-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
  await page
    .getByRole('button', { name: 'Create draft in Automation Studio', exact: true })
    .click();
  await expect(page).toHaveURL(/\/scenarios\/new-draft$/);
  await expect(page.getByRole('button', { name: 'Publish', exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.body.graph).toMatchObject({
    nodes: expect.arrayContaining([
      expect.objectContaining({
        type: 'INCOMING_MESSAGE',
        config: expect.objectContaining({
          webinarEventId: 'session-a',
          webinarEventType: 'WEBINAR_CTA_CLICKED',
        }),
      }),
      expect.objectContaining({ type: 'ADD_TAG', config: { tagId: 'tag-a' } }),
      expect.objectContaining({
        type: 'SEND_MESSAGE',
        config: expect.objectContaining({
          text: 'Спасибо за интерес к вебинару!',
          telegramConnectionId: 'bot-a',
        }),
      }),
    ]),
  });
});
