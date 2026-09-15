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
const mailboxId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const messageId = '33333333-3333-4333-8333-333333333333';
const mailbox = {
  id: mailboxId,
  domainId: 'domain-a',
  address: 'sales@mail.example.com',
  displayName: 'Customer team',
  signature: 'Alex\nCustomer team',
  status: 'ACTIVE',
  mode: 'TWO_WAY',
  shared: true,
  isDefault: true,
  memberUserIds: [],
  sendingReady: true,
  receivingReady: true,
};
const thread = {
  id: threadId,
  mailboxId,
  contactId: 'contact-a',
  peerEmail: 'julia@example.com',
  subject: 'Your September booking',
  preview: 'Thanks, Alex. Could you send the updated itinerary?',
  lastMessageAt: '2026-09-15T10:30:00Z',
  messageCount: 2,
  starred: false,
  unread: true,
  archived: false,
  mailbox,
};
const mail = {
  id: messageId,
  direction: 'INBOUND',
  fromAddress: 'julia@example.com',
  toAddress: mailbox.address,
  replyToAddress: null,
  subject: thread.subject,
  source: 'RECEIVED',
  occurredAt: thread.lastMessageAt,
  isAutomatic: false,
  textBody: 'Thanks, Alex. Could you send the updated itinerary?',
  htmlBody:
    '<p>Thanks, Alex.</p><p>Could you send the <strong>updated itinerary</strong>?</p><img src="https://tracking.invalid/pixel" onerror="alert(1)"><script>window.top.__mailXss=true</script><a href="javascript:alert(1)">bad</a><style>body{background:url(https://tracking.invalid/css)}</style>',
  attachments: [
    {
      id: 'file-1',
      filename: 'booking-notes.pdf',
      sizeBytes: 12500,
      status: 'AVAILABLE',
      errorCode: null,
    },
  ],
  delivery: null,
};

async function mockInbox(
  page: Page,
  options: { empty?: boolean; send?: boolean; failSendOnce?: boolean } = {},
) {
  const mutations: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  let drafts: Array<Record<string, unknown>> = [],
    attempts = 0;
  await page.addInitScript(
    (user) => localStorage.setItem('omnicus-auth', JSON.stringify({ token: 'mock-session', user })),
    identity,
  );
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    const respond = (data: unknown) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data, meta: {} }) });
    if (path.endsWith('/auth/me')) return respond(identity);
    if (path.endsWith('/access'))
      return respond({
        permissions: [
          'project:read',
          'email:read',
          'email:manage',
          'broadcasts:read',
          ...(options.send === false ? [] : ['email:send']),
        ],
        projectRoleName: 'Project Admin',
      });
    if (path === '/api/v1/projects')
      return respond([{ id: 'project-a', name: 'Customer workspace', status: 'ACTIVE' }]);
    if (path === '/api/v1/projects/project-a')
      return respond({ id: 'project-a', name: 'Customer workspace', status: 'ACTIVE' });
    if (method !== 'GET') {
      const body = request.postDataJSON() as Record<string, unknown> | null;
      mutations.push({ path, method, body: body ?? {} });
      if (path.endsWith('/messages')) {
        attempts += 1;
        if (options.failSendOnce && attempts === 1) return route.abort('failed');
        drafts = [];
        return respond({ id: 'sent', threadId, deliveryId: 'delivery-1' });
      }
      if (path.includes('/drafts/') && method === 'PUT') {
        const draft = {
          ...body,
          id: path.split('/').at(-1),
          mailboxId,
          toEmail: body?.to,
          textBody: body?.text,
          revision: 1,
          updatedAt: new Date().toISOString(),
        };
        drafts = [draft];
        return respond(draft);
      }
      if (path.endsWith('/state')) return respond({});
      return respond({});
    }
    if (path.endsWith('/mailboxes')) return respond(options.empty ? [] : [mailbox]);
    if (path.endsWith('/threads'))
      return respond({
        items: options.empty ? [] : [thread],
        total: options.empty ? 0 : 1,
        pageSize: 30,
      });
    if (path.endsWith('/threads/' + threadId))
      return respond({
        ...thread,
        messages: [
          {
            ...mail,
            id: 'outgoing-a',
            direction: 'OUTBOUND',
            fromAddress: mailbox.address,
            toAddress: thread.peerEmail,
            source: 'CAMPAIGN',
            occurredAt: '2026-09-15T10:00:00Z',
            textBody: 'Hi Julia, your booking is confirmed. Let us know if you need anything.',
            htmlBody: '',
            attachments: [],
            delivery: {
              status: 'DELIVERED',
              lastError: null,
              attachmentAssetIds: [],
              campaignId: 'campaign-a',
              scenarioExecutionId: null,
            },
          },
          mail,
        ],
        nextCursor: null,
      });
    if (path.endsWith('/drafts')) return respond(drafts);
    if (path.endsWith('/members'))
      return respond([
        {
          id: identity.userId,
          email: identity.email,
          firstName: identity.firstName,
          lastName: identity.lastName,
        },
      ]);
    if (path.endsWith('/available-domains'))
      return respond([{ id: 'domain-a', name: 'mail.example.com' }]);
    if (path.endsWith('/domains'))
      return respond(
        options.empty
          ? []
          : [
              {
                id: 'domain-a',
                name: 'mail.example.com',
                providerDomainId: 'provider-a',
                status: 'verified',
                sendingEnabled: true,
                receivingReady: true,
                dnsRecords: [],
                region: 'eu-west-1',
                lastCheckedAt: '2026-09-15T00:00:00Z',
              },
            ],
      );
    if (path.endsWith('/health'))
      return respond({ counts: { COMPLETED: 5 }, failedReceipts: [], failedAutomations: [] });
    if (path.endsWith('/media-assets')) return respond([]);
    return respond([]);
  });
  return mutations;
}

test('email onboarding and settings are useful before a domain is connected', async ({ page }) => {
  await mockInbox(page, { empty: true });
  await page.goto('/projects/project-a/email-inbox');
  await expect(page.getByText('A home for your email conversations')).toBeVisible();
  await page.getByRole('button', { name: 'Set up email' }).click();
  await expect(page.getByText('Keep existing business email working')).toBeVisible();
  await expect(page.getByText('Provider billing', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add address' })).toBeDisabled();
});

test('desktop inbox groups campaign and reply, isolates HTML and preserves sender on reply', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1560, height: 1050 });
  const mutations = await mockInbox(page);
  const trackers: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('tracking.invalid')) trackers.push(request.url());
  });
  await page.goto('/projects/project-a/email-inbox');
  await page
    .locator('.mail-thread-list')
    .getByRole('button', { name: /julia@example.com/ })
    .click();
  await expect(page.getByRole('heading', { name: thread.subject })).toBeVisible();
  await expect(
    page.frameLocator('iframe').getByText('updated itinerary', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as Record<string, unknown>).__mailXss),
  ).toBeUndefined();
  expect(trackers).toEqual([]);
  await expect(
    page.frameLocator('iframe').locator('script,img,style:not(head style),a,form'),
  ).toHaveCount(0);
  await page.screenshot({ path: 'test-results/email-inbox-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Reply to julia@example.com' }).click();
  await expect(page.getByLabel('To', { exact: true })).toHaveValue('julia@example.com');
  await expect(page.getByLabel('To', { exact: true })).toBeDisabled();
  await page
    .getByLabel('Message', { exact: true })
    .fill('Of course, Julia. Here is the updated plan.');
  await page.getByRole('button', { name: 'Send email', exact: true }).click();
  await expect(page.getByText('Email queued.', { exact: false })).toBeVisible();
  expect(mutations.find((item) => item.path.endsWith('/messages'))?.body).toMatchObject({
    mailboxId,
    threadId,
    replyToMessageId: messageId,
    to: 'julia@example.com',
  });
});

test('private drafts can be saved and reopened without sending', async ({ page }) => {
  const mutations = await mockInbox(page);
  await page.goto('/projects/project-a/email-inbox');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await page.getByLabel('To', { exact: true }).fill('client@example.com');
  await page.getByLabel('Subject', { exact: true }).fill('A saved draft');
  await page.getByLabel('Message', { exact: true }).fill('Not sent yet');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.getByRole('button', { name: 'Drafts', exact: true }).click();
  await page.getByRole('button', { name: /client@example.com A saved draft/ }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Not sent yet');
  expect(mutations.some((item) => item.path.endsWith('/messages'))).toBe(false);
});

test('uncertain manual send retries the same request key', async ({ page }) => {
  const mutations = await mockInbox(page, { failSendOnce: true });
  await page.goto('/projects/project-a/email-inbox');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await page.getByLabel('To', { exact: true }).fill('client@example.com');
  await page.getByLabel('Subject', { exact: true }).fill('Network test');
  await page.getByLabel('Message', { exact: true }).fill('One delivery only');
  await page.getByRole('button', { name: 'Send email', exact: true }).click();
  await expect(page.getByText('The server is not reachable', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Send email', exact: true }).click();
  await expect(page.getByText('Email queued.', { exact: false })).toBeVisible();
  const sends = mutations.filter((item) => item.path.endsWith('/messages'));
  expect(sends).toHaveLength(2);
  expect(sends[0]?.body).toEqual(sends[1]?.body);
});

test('mobile uses a single reading pane and read-only access has no send action', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockInbox(page, { send: false });
  await page.goto('/projects/project-a/email-inbox');
  await expect(page.getByRole('button', { name: 'Compose', exact: true })).toBeDisabled();
  await page
    .locator('.mail-thread-list')
    .getByRole('button', { name: /julia@example.com/ })
    .click();
  await expect(page.getByRole('heading', { name: thread.subject })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reply to julia@example.com' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/email-inbox-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Back to conversations' }).click();
  await expect(
    page.locator('.mail-thread-list').getByRole('button', { name: /julia@example.com/ }),
  ).toBeVisible();
});
