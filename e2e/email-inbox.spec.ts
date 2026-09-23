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
const assetId = '44444444-4444-4444-8444-444444444444';
function previewPdf() {
  const stream = 'BT /F1 18 Tf 30 120 Td (Attachment preview) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
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
  options: {
    empty?: boolean;
    send?: boolean;
    failSendOnce?: boolean;
    failSaveOnce?: boolean;
    mediaRead?: boolean;
    mediaUpload?: boolean;
    reply?: { htmlBody?: string; textBody?: string };
    outgoing?: { htmlBody?: string; textBody?: string };
  } = {},
) {
  const mutations: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  let drafts: Array<Record<string, unknown>> = [],
    attempts = 0,
    saves = 0;
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
          'communications:read',
          'email:read',
          'email:manage',
          'broadcasts:read',
          ...(options.send === false ? [] : ['email:send']),
          ...(options.mediaRead ? ['media:read'] : []),
          ...(options.mediaUpload ? ['media:manage'] : []),
        ],
        projectRoleName: 'Project Admin',
      });
    if (path === '/api/v1/projects')
      return respond([{ id: 'project-a', name: 'Customer workspace', status: 'ACTIVE' }]);
    if (path === '/api/v1/projects/project-a')
      return respond({ id: 'project-a', name: 'Customer workspace', status: 'ACTIVE' });
    if (path.endsWith('/communications/contacts'))
      return respond({
        items: [
          {
            channels: ['EMAIL'],
            displayName: 'Julia Taylor',
            email: thread.peerEmail,
            id: thread.contactId,
            lastInteractionAt: thread.lastMessageAt,
            phone: null,
            preview: thread.preview,
            status: 'ACTIVE',
          },
        ],
        page: 1,
        pageSize: 40,
        total: 1,
      });
    if (path.endsWith('/communications/contacts/' + thread.contactId))
      return respond({
        automationMode: 'ENABLED',
        connections: [],
        displayName: 'Julia Taylor',
        email: thread.peerEmail,
        firstName: 'Julia',
        id: thread.contactId,
        identities: [],
        lastName: 'Taylor',
        phone: null,
        status: 'ACTIVE',
        templateVariables: {},
        username: null,
        whatsAppConsentStatus: 'UNKNOWN',
      });
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
        saves += 1;
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
        if (options.failSaveOnce && saves === 1) return route.abort('failed');
        return respond(draft);
      }
      if (path.includes('/drafts/') && method === 'DELETE') {
        drafts = [];
        return respond({ deleted: true });
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
            ...options.outgoing,
            attachments: [],
            delivery: {
              status: 'DELIVERED',
              lastError: null,
              attachmentAssetIds: [],
              campaignId: 'campaign-a',
              scenarioExecutionId: null,
            },
          },
          { ...mail, ...options.reply },
        ],
        nextCursor: null,
      });
    if (path.endsWith('/drafts')) return respond(drafts);
    if (path.endsWith('/members'))
      return respond([
        {
          id: identity.userId,
          email: identity.email,
          name: `${identity.firstName} ${identity.lastName}`,
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
                dnsRecords: [
                  {
                    record: 'DKIM',
                    type: 'TXT',
                    name: 'resend._domainkey',
                    value: 'fixture-public-dns-value',
                    status: 'verified',
                  },
                ],
                region: 'eu-west-1',
                lastCheckedAt: '2026-09-15T00:00:00Z',
              },
            ],
      );
    if (path.endsWith('/health'))
      return respond({ counts: { COMPLETED: 5 }, failedReceipts: [], failedAutomations: [] });
    if (path.endsWith('/media-assets'))
      return respond(
        options.mediaRead
          ? [
              {
                id: assetId,
                originalFilename: 'itinerary.pdf',
                status: 'AVAILABLE',
                kind: 'DOCUMENT',
                sizeBytes: '100',
              },
            ]
          : [],
      );
    return respond([]);
  });
  return mutations;
}

test('multiple uploaded files can be removed and sent without text; ambiguous retries preserve file IDs', async ({
  page,
}) => {
  const mutations = await mockInbox(page, {
    mediaRead: true,
    mediaUpload: true,
    failSendOnce: true,
  });
  const uploads: string[] = [];
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/media-assets/upload/**', async (route) => {
    const first = uploads.length === 0;
    const name = first ? 'offer.pdf' : 'photo.pdf';
    uploads.push(name);
    if (first) await paused;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: first ? assetId : '55555555-5555-4555-8555-555555555555',
          originalFilename: name,
          sizeBytes: '50',
          status: 'AVAILABLE',
          detectedMimeType: 'application/pdf',
        },
        meta: {},
      }),
    });
  });
  await page.goto('/projects/project-a/email-inbox');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await page.getByLabel('To', { exact: true }).fill('julia@example.com');
  await page.getByLabel('Subject', { exact: true }).fill('Documents');
  await page.locator('input[type=file]').setInputFiles([
    { name: 'offer.pdf', mimeType: 'application/pdf', buffer: previewPdf() },
    { name: 'photo.pdf', mimeType: 'application/pdf', buffer: previewPdf() },
  ]);
  await expect(page.getByRole('button', { name: 'Send email', exact: true })).toBeDisabled();
  await expect(page.getByText('Uploading…').first()).toBeVisible();
  release();
  await expect(page.getByRole('button', { name: 'Send email', exact: true })).toBeEnabled();
  await expect(page.locator('.email-file')).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove photo.pdf' }).click();
  await expect(page.locator('.email-file')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/email-compose-files.png', fullPage: true });
  await page.getByRole('button', { name: 'Send email', exact: true }).click();
  await expect(page.locator('.ant-modal .ant-alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove offer.pdf' })).toBeDisabled();
  await page.getByRole('button', { name: 'Send email', exact: true }).click();
  await expect(page.getByText('Email queued.', { exact: false })).toBeVisible();
  const sends = mutations.filter((item) => item.path.endsWith('/messages'));
  expect(sends).toHaveLength(2);
  expect(sends[0]?.body).toEqual(sends[1]?.body);
  expect(sends[0]?.body.assetIds).toEqual([assetId]);
  expect(sends[0]?.body.text).toBe('');
});

test('PDF preview uses the local worker, download is authenticated and the reader stays compact', async ({
  page,
}) => {
  await mockInbox(page);
  const tokens: string[] = [];
  await page.route('**/email-inbox/attachments/file-1', async (route) => {
    tokens.push(route.request().headers().authorization ?? '');
    await route.fulfill({ contentType: 'application/octet-stream', body: previewPdf() });
  });
  await page.goto('/projects/project-a/email-inbox');
  await page
    .locator('.mail-thread-list')
    .getByRole('button', { name: /julia@example.com/ })
    .click();
  await page.getByRole('button', { name: 'Preview booking-notes.pdf' }).click();
  await expect(page.getByRole('dialog').locator('canvas')).toBeVisible();
  await expect(page.getByText('Page 1 / 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').locator('.ant-spin')).toHaveCount(0);
  expect(
    await page
      .getByRole('dialog')
      .locator('canvas')
      .evaluate((element) => (element as HTMLCanvasElement).width),
  ).toBeGreaterThan(100);
  await expect(page.getByRole('dialog').locator('iframe,object,embed')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/email-file-pdf-preview.png', fullPage: true });
  const downloaded = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Download', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toBe('booking-notes.pdf');
  expect(tokens).toEqual(['Bearer mock-session']);
});

test('failed attachment uploads stay visible and can be removed on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockInbox(page, { mediaRead: true, mediaUpload: true });
  await page.route('**/media-assets/upload/**', (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'media_signature_rejected', message: 'Media file was rejected' },
      }),
    }),
  );
  await page.goto('/projects/project-a/email-inbox');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'file-with-a-long-name-for-the-client.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('invalid'),
  });
  await expect(
    page.getByText('This file format or its contents are not supported. Choose another file.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send email', exact: true })).toBeDisabled();
  expect(
    await page
      .getByRole('dialog')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/email-files-mobile-error.png', fullPage: true });
  await page
    .getByRole('button', { name: 'Remove file-with-a-long-name-for-the-client.pdf' })
    .click();
  await expect(page.locator('.email-file')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send email', exact: true })).toBeEnabled();
});

test('email onboarding and settings are useful before a domain is connected', async ({ page }) => {
  await mockInbox(page, { empty: true });
  await page.goto('/projects/project-a/email-inbox');
  await expect(page.getByText('A home for your email conversations')).toBeVisible();
  await page.getByRole('button', { name: 'Set up email' }).click();
  await expect(page.getByText('Keep existing business email working')).toBeVisible();
  await expect(page.getByText('Provider billing', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add address' })).toBeDisabled();
});

for (const width of [1440, 390]) {
  test(`email settings tables have no empty strip inside their border at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1050 });
    await mockInbox(page);
    await page.goto('/projects/project-a/email-settings');
    await page.locator('.mail-settings .ant-collapse-header').click();
    const tables = page.locator('.mail-settings .ant-table-wrapper');
    await expect(tables).toHaveCount(2);
    for (const table of await tables.all()) {
      await expect(table.locator('thead')).toBeVisible();
      await expect(table.locator('.ant-table')).toHaveCSS('margin-top', '0px');
      await expect(table).toHaveCSS('margin-top', '12px');
      await expect
        .poll(() =>
          table.evaluate((element) => {
            const header = element.querySelector('thead')!;
            return Math.abs(
              header.getBoundingClientRect().top - element.getBoundingClientRect().top,
            );
          }),
        )
        .toBeLessThanOrEqual(2);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/email-settings-${width}.png`, fullPage: true });
  });
}

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

test('formatted replies stay compact and can switch to the original plain text', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const textBody = 'Reply test\n\n> Original message';
  await mockInbox(page, {
    reply: {
      textBody,
      htmlBody: '<p>Reply <strong>test</strong></p><blockquote>Original message</blockquote>',
    },
  });
  await page.goto('/projects/project-a/email-inbox');
  await page
    .locator('.mail-thread-list')
    .getByRole('button', { name: /julia@example.com/ })
    .click();
  const card = page.locator('.mail-message-card').last();
  const frame = card.locator('iframe');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('sandbox', 'allow-same-origin');
  await expect(frame).not.toHaveAttribute('sandbox', /allow-scripts/);
  await expect(frame.contentFrame().locator('blockquote')).toHaveText('Original message');
  await expect(frame.contentFrame().locator('blockquote')).toHaveCSS('border-left-width', '3px');
  await expect
    .poll(() => frame.evaluate((element) => element.getBoundingClientRect().height))
    .toBeLessThan(150);
  await expect
    .poll(() => frame.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(24);
  await page.screenshot({ path: 'test-results/email-inbox-formatted.png', fullPage: true });

  await card.getByText('Plain text', { exact: true }).click();
  await expect(frame).toHaveCount(0);
  await expect(card.locator('.mail-plain-text')).toHaveText(textBody);
  await card.locator('.mail-message-summary').click();
  await expect(card.locator('.mail-message-body')).toHaveCount(0);
  await card.locator('.mail-message-summary').click();
  await expect(card.locator('.mail-plain-text')).toHaveText(textBody);
  await card.getByText('Formatted', { exact: true }).click();
  await expect(frame.contentFrame().locator('blockquote')).toBeVisible();

  const earlier = page.locator('.mail-message-card').first();
  await earlier.locator('.mail-message-summary').click();
  await expect(earlier.locator('.mail-plain-text')).toContainText('Hi Julia');
  await expect(earlier.locator('.mail-format-toggle')).toHaveCount(0);
  await expect(frame).toBeVisible();
  expect(errors).toEqual([]);
});

test('long formatted replies resize with the reader without nested vertical scrolling', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1560, height: 1050 });
  await mockInbox(page, {
    reply: {
      htmlBody:
        '<p>' +
        'Long reply with wrapping text. '.repeat(180) +
        '</p><blockquote>Original</blockquote>',
    },
  });
  await page.goto('/projects/project-a/email-inbox');
  await page
    .locator('.mail-thread-list')
    .getByRole('button', { name: /julia@example.com/ })
    .click();
  const frame = page.locator('.mail-html-frame');
  const frameHeight = () => frame.evaluate((element) => element.getBoundingClientRect().height);
  const remainingOverflow = () =>
    frame.evaluate(
      (element: HTMLIFrameElement) =>
        element.contentDocument!.documentElement.scrollHeight - element.clientHeight,
    );
  await expect.poll(frameHeight).toBeGreaterThan(300);
  await expect.poll(remainingOverflow).toBeLessThanOrEqual(1);
  const desktopHeight = await frameHeight();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(frameHeight).toBeGreaterThan(desktopHeight);
  await expect.poll(remainingOverflow).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1560, height: 1050 });
  await expect
    .poll(async () => Math.abs((await frameHeight()) - desktopHeight))
    .toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

for (const sample of [
  {
    name: 'text-only',
    htmlBody: ' \n ',
    textBody: 'Plain reply\n\n> Original',
    expected: 'Plain reply\n\n> Original',
  },
  {
    name: 'HTML-only',
    htmlBody: '<p>Formatted only</p>',
    textBody: '',
    expected: 'No plain-text content.',
  },
  { name: 'empty', htmlBody: '', textBody: '', expected: 'No plain-text content.' },
]) {
  test(`the reader handles ${sample.name} messages`, async ({ page }) => {
    await mockInbox(page, { reply: { htmlBody: sample.htmlBody, textBody: sample.textBody } });
    await page.goto('/projects/project-a/email-inbox');
    await page
      .locator('.mail-thread-list')
      .getByRole('button', { name: /julia@example.com/ })
      .click();
    const card = page.locator('.mail-message-card').last();
    if (sample.name === 'HTML-only') {
      await expect(card.locator('iframe').contentFrame().getByText('Formatted only')).toBeVisible();
      await card.getByText('Plain text', { exact: true }).click();
    } else {
      await expect(card.locator('.mail-format-toggle')).toHaveCount(0);
    }
    await expect(card.locator('iframe')).toHaveCount(0);
    await expect(card.locator('.mail-plain-text')).toHaveText(sample.expected);
  });
}

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
  await expect(page.locator('.mail-list-caption strong')).toHaveText('Drafts');
  await page.getByLabel('Search email').fill('not present');
  await page.getByLabel('Search email').press('Enter');
  await expect(page.getByText('No matching conversations')).toBeVisible();
  await expect(page.getByText('0 conversations', { exact: true })).toBeVisible();
  await page.getByLabel('Search email').fill('');
  await page.getByLabel('Search email').press('Enter');
  await page.getByRole('button', { name: /client@example.com A saved draft/ }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Not sent yet');
  expect(mutations.some((item) => item.path.endsWith('/messages'))).toBe(false);
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.getByRole('button', { name: 'Delete draft', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete draft', exact: true }).click();
  await expect(page.getByText('No saved drafts')).toBeVisible();
  expect(mutations.find((item) => item.method === 'DELETE')?.body).toEqual({ revision: 1 });
});

test('a lost draft-save response can be retried with the same draft and revision', async ({
  page,
}) => {
  const mutations = await mockInbox(page, { failSaveOnce: true });
  await page.goto('/projects/project-a/email-inbox');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await page.getByLabel('Subject', { exact: true }).fill('Keep my draft');
  await page.getByLabel('Message', { exact: true }).fill('Saved despite a lost response');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('The server is not reachable', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved.', { exact: false })).toBeVisible();
  const saves = mutations.filter((item) => item.method === 'PUT');
  expect(saves).toHaveLength(2);
  expect(saves[0]).toEqual(saves[1]);
});

test('an operator with media read access can attach an existing file without upload permission', async ({
  page,
}) => {
  const mutations = await mockInbox(page, { mediaRead: true });
  await page.goto('/projects/project-a/email-inbox');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Upload file' })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Choose files from Content library' }).click();
  await page.getByText('itinerary.pdf', { exact: true }).click();
  await page.getByLabel('To', { exact: true }).fill('client@example.com');
  await page.getByLabel('Subject', { exact: true }).fill('Your itinerary');
  await page.getByRole('button', { name: 'Send email', exact: true }).click();
  await expect(page.getByText('Email queued.', { exact: false })).toBeVisible();
  expect(mutations.find((item) => item.path.endsWith('/messages'))?.body).toMatchObject({
    text: '',
    assetIds: [assetId],
  });
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

const communicationsUrl = '/projects/project-a/communications?contact=contact-a&channel=email';
const communicationCards = '.communications-email-message-list article';

test('Conversations formats email safely and preserves the reply context', async ({ page }) => {
  await page.setViewportSize({ width: 1560, height: 1050 });
  const mutations = await mockInbox(page);
  const trackers: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('tracking.invalid')) trackers.push(request.url());
  });
  await page.goto(communicationsUrl);
  await expect(page.getByRole('heading', { name: 'Communications', exact: true })).toBeVisible();
  const card = page.locator(communicationCards).last();
  const frame = card.locator('iframe');
  await expect(frame.contentFrame().locator('strong')).toHaveText('updated itinerary');
  await expect(frame).toHaveAttribute('sandbox', 'allow-same-origin');
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(frame.contentFrame().locator('script,img,style:not(head style),a,form')).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(() => (window as unknown as Record<string, unknown>).__mailXss),
  ).toBeUndefined();
  expect(trackers).toEqual([]);
  await expect(card.getByRole('button', { name: 'Download booking-notes.pdf' })).toBeVisible();
  await expect(page.locator(communicationCards).first().locator('iframe')).toHaveCount(0);
  await expect(page.locator(communicationCards).first()).toContainText('Hi Julia');
  await page.screenshot({ path: 'test-results/communications-email-desktop.png', fullPage: true });

  await card.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.getByLabel('To', { exact: true })).toHaveValue(thread.peerEmail);
  await expect(page.getByLabel('To', { exact: true })).toBeDisabled();
  await page.getByLabel('Message', { exact: true }).fill('Here is the updated plan.');
  await page.getByRole('button', { name: 'Send email', exact: true }).click();
  await expect(page.getByText('Email queued.', { exact: false })).toBeVisible();
  expect(mutations.find((item) => item.path.endsWith('/messages'))?.body).toMatchObject({
    mailboxId,
    threadId,
    replyToMessageId: messageId,
    to: thread.peerEmail,
  });
});

test('Conversations keeps short replies compact and display modes independent', async ({
  page,
}) => {
  const textBody = 'Reply test\n\n> Original message';
  await mockInbox(page, {
    outgoing: { htmlBody: '<p>Earlier <em>formatted</em> email</p>' },
    reply: {
      textBody,
      htmlBody: '<p>Reply <strong>test</strong></p><blockquote>Original message</blockquote>',
    },
  });
  await page.goto(communicationsUrl);
  const card = page.locator(communicationCards).last();
  const earlier = page.locator(communicationCards).first();
  const frame = card.locator('iframe');
  await expect(frame.contentFrame().locator('blockquote')).toHaveText('Original message');
  await expect(frame.contentFrame().locator('blockquote')).toHaveCSS('border-left-width', '3px');
  await expect
    .poll(() => frame.evaluate((element) => element.getBoundingClientRect().height))
    .toBeLessThan(150);
  await expect
    .poll(() => frame.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(24);
  await card.getByText('Plain text', { exact: true }).click();
  await expect(frame).toHaveCount(0);
  await expect(card.locator('.communications-email-plain-text')).toHaveText(textBody);
  await expect(earlier.locator('iframe').contentFrame().locator('em')).toHaveText('formatted');
  await card.getByText('Formatted', { exact: true }).click();
  await expect(frame.contentFrame().locator('blockquote')).toBeVisible();
});

for (const sample of [
  { name: 'text-only', htmlBody: ' \n ', textBody: '<b>Plain</b>\n\n> Original' },
  { name: 'HTML-only', htmlBody: '<p>Formatted only</p>', textBody: '' },
  { name: 'empty', htmlBody: '', textBody: '' },
]) {
  test(`Conversations handles ${sample.name} email`, async ({ page }) => {
    await mockInbox(page, { reply: sample });
    await page.goto(communicationsUrl);
    const card = page.locator(communicationCards).last();
    if (sample.name === 'HTML-only') {
      await expect(card.locator('iframe').contentFrame().getByText('Formatted only')).toBeVisible();
      await card.getByText('Plain text', { exact: true }).click();
    } else {
      await expect(card.locator('.communications-email-format-toggle')).toHaveCount(0);
    }
    await expect(card.locator('iframe')).toHaveCount(0);
    await expect(card.locator('.communications-email-plain-text')).toHaveText(
      sample.textBody || 'No plain-text content.',
    );
    await expect(card.locator('.communications-email-plain-text b')).toHaveCount(0);
  });
}

test('Conversations resizes long email without inner vertical scrollbars', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1560, height: 1050 });
  await mockInbox(page, {
    reply: {
      htmlBody: '<p>' + 'Long reply with wrapping text. '.repeat(180) + '</p>',
    },
  });
  await page.goto(communicationsUrl);
  const frame = page.locator(communicationCards).last().locator('iframe');
  const frameHeight = () => frame.evaluate((element) => element.getBoundingClientRect().height);
  const remainingOverflow = () =>
    frame.evaluate(
      (element: HTMLIFrameElement) =>
        element.contentDocument!.documentElement.scrollHeight - element.clientHeight,
    );
  await expect.poll(frameHeight).toBeGreaterThan(300);
  await expect.poll(remainingOverflow).toBeLessThanOrEqual(1);
  const desktopHeight = await frameHeight();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(frameHeight).toBeGreaterThan(desktopHeight);
  await expect.poll(remainingOverflow).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1560, height: 1050 });
  await expect
    .poll(async () => Math.abs((await frameHeight()) - desktopHeight))
    .toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('Conversations formats mobile email with read-only access', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockInbox(page, { send: false });
  await page.goto(communicationsUrl);
  const frame = page.locator(communicationCards).last().locator('iframe');
  await expect(frame.contentFrame().locator('strong')).toHaveText('updated itinerary');
  await expect(page.getByRole('button', { name: /New email$/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Reply/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/communications-email-mobile.png', fullPage: true });
});
