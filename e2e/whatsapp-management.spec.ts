import { expect, test, type Page } from '@playwright/test';

const identity = {
  email: 'admin@example.test',
  firstName: 'Admin',
  lastName: 'User',
  globalPermissions: [],
  globalRoleNames: [],
  status: 'ACTIVE',
  userId: 'user-a',
};
const channel = {
  id: 'channel-wa',
  type: 'WHATSAPP',
  name: 'WhatsApp Demo',
  projectId: 'project-a',
  status: 'ACTIVE',
  configured: true,
  businessAccountId: 'waba-demo',
  phoneNumberId: 'phone-demo',
  displayPhoneNumber: '+351934000000',
  verifiedName: 'Demo',
  setupReady: true,
  missingConfiguration: [],
  graphApiVersion: 'v25.0',
  setupMode: 'MANUAL',
  webhookStatus: 'CONNECTED',
  webhookUrl: 'https://api.example.test/webhooks/whatsapp',
  createdAt: '2026-09-10T00:00:00Z',
  updatedAt: '2026-09-10T00:00:00Z',
  lastWebhookAt: null,
  lastErrorAt: null,
  maskedToken: '***',
};
const managerUrl = 'https://business.facebook.com/wa/manage/home/?waba_id=waba-demo';
const rateCard = {
  source: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing',
  verifiedAt: '2026-09-10',
  effectiveFrom: '2026-07-01',
  effectiveUntil: '2026-10-01',
  currencies: ['USD', 'EUR'],
};
const initialTemplate = {
  id: 'template-a',
  name: 'booking_update',
  languageCode: 'en_US',
  status: 'APPROVED',
  category: 'UTILITY',
  quality: 'GREEN',
  rejectionReasonCode: null,
  lastSyncedAt: '2026-09-10T00:00:00Z',
  components: [
    {
      type: 'BODY',
      text: 'Hi {{1}}, your booking is confirmed.',
      example: { body_text: [['Alex']] },
    },
    {
      type: 'BUTTONS',
      buttons: [{ type: 'URL', text: 'Booking', url: 'https://example.test/booking' }],
    },
  ],
};

async function mockApp(
  page: Page,
  options: { manager?: boolean; analyticsFailure?: boolean } = {},
) {
  let templates = [initialTemplate];
  const mutations: { method: string; body: Record<string, unknown> | null }[] = [];
  let billingRequests = 0;
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
          'projects:read',
          'channels:read',
          'templates:read',
          'broadcasts:read',
          ...(options.manager === false ? [] : ['channels:manage', 'templates:manage']),
        ],
        projectRoleName: 'Admin',
      });
    if (path === '/api/v1/projects')
      return respond([{ id: 'project-a', name: 'Demo', status: 'ACTIVE' }]);
    if (path === '/api/v1/projects/project-a')
      return respond({ id: 'project-a', name: 'Demo', status: 'ACTIVE' });
    if (path.endsWith('/whatsapp/templates/sync')) return respond(templates);
    if (path.includes('/whatsapp/templates')) {
      if (method !== 'GET') {
        const body = method === 'DELETE' ? null : request.postDataJSON();
        mutations.push({ method, body });
        if (method === 'DELETE') templates = templates.filter((t) => !path.endsWith(t.id));
        else if (method === 'POST')
          templates.push({
            ...initialTemplate,
            id: 'new-template',
            name: body.template.name,
            status: 'PENDING',
            components: [{ type: 'BODY', text: body.template.body }],
          });
        else
          templates = templates.map((t) => (path.endsWith(t.id) ? { ...t, status: 'PENDING' } : t));
      }
      return respond(templates);
    }
    if (path.endsWith('/whatsapp/health'))
      return respond({
        checkedAt: '2026-09-10T12:00:00Z',
        localStatus: 'ACTIVE',
        providerStatus: 'AVAILABLE',
        phone: { number: '+351934000000', verifiedName: 'Demo', quality: 'GREEN' },
        messagingLimit: '2000',
        accountReview: 'APPROVED',
        businessVerification: 'VERIFIED',
        token: { valid: true, expiresAt: null, missingPermissions: [] },
        webhook: { subscribed: true, lastReceivedAt: null },
        templates: { APPROVED: 1 },
        lastInboundAt: null,
        lastSuccessfulOutboundAt: null,
        lastError: null,
        entities: [],
        unavailable: {},
        managerUrl,
      });
    if (path.endsWith('/whatsapp/billing')) {
      billingRequests++;
      return respond({
        mode: 'META_DIRECT',
        paymentMethodStatus: 'CHECK_IN_META',
        managerUrl,
        checkedAt: '2026-09-10T12:00:00Z',
        start: '2026-08-10T12:00:00Z',
        end: '2026-09-10T12:00:00Z',
        rateCard,
        currency: 'USD',
        reportedCost: options.analyticsFailure ? null : 0.1184,
        volume: options.analyticsFailure ? null : 2,
        breakdown: [],
        unavailable: options.analyticsFailure
          ? { analytics: { reason: 'Meta has not granted access to this information.', code: 200 } }
          : {},
      });
    }
    if (path.endsWith('/channels/channel-wa')) return respond(channel);
    if (path.endsWith('/channels')) return respond([channel]);
    if (/\/(inbound-events|outbound-events)$/.test(path))
      return respond({ items: [], page: 1, pageSize: 20, total: 0 });
    if (path.endsWith('/broadcasts/broadcast-a/estimate'))
      return respond({
        eligibleRecipients: 2,
        cost: {
          category: 'MARKETING',
          currency: new URL(request.url()).searchParams.get('currency'),
          estimatedAt: '2026-09-10T12:00:00Z',
          sendAt: '2026-09-10T12:00:00Z',
          eligibleRecipients: 2,
          free: 0,
          paid: 2,
          unknown: 0,
          estimatedCost: 0.1184,
          knownSubtotal: 0.1184,
          unavailableReason: null,
          rateCard,
          breakdown: [
            {
              market: 'Rest of Western Europe',
              recipients: 2,
              free: 0,
              paid: 2,
              unknown: 0,
              unitPrice: 0.0592,
              subtotal: 0.1184,
            },
          ],
        },
      });
    if (path.endsWith('/broadcasts/broadcast-a/recipients'))
      return respond({ items: [], total: 0, page: 1, pageSize: 20 });
    if (path.endsWith('/broadcasts/broadcast-a'))
      return respond({
        id: 'broadcast-a',
        name: 'September offers',
        connectionId: channel.id,
        channelType: 'WHATSAPP',
        status: 'DRAFT',
        audience: { mode: 'ALL_ACTIVE' },
        whatsAppTemplate: { name: 'booking_update', languageCode: 'en_US' },
        recipientCount: 0,
        updatedAt: '2026-09-10T00:00:00Z',
      });
    return respond([]);
  });
  return { mutations, billingRequests: () => billingRequests };
}

test('creates, duplicates, edits and deletes WhatsApp templates without losing URLs', async ({
  page,
}, testInfo) => {
  const mock = await mockApp(page);
  await page.goto('/projects/project-a/templates?provider=WHATSAPP');
  await expect(page.getByRole('cell', { name: 'booking_update', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /New template$/ }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Template name', { exact: true }).fill('september_offer');
  await modal
    .getByLabel('Message', { exact: true })
    .fill('Hi {{1}}, our September offers are ready.');
  await modal.getByLabel('Example {{1}}', { exact: true }).fill('Alex');
  await expect(modal.locator('.wa-preview-bubble')).toContainText(
    'Hi Alex, our September offers are ready.',
  );
  await modal.locator('.ant-modal-body').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: testInfo.outputPath('template-editor.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await modal.getByRole('button', { name: 'Submit to Meta', exact: true }).click();
  await expect(modal).not.toBeVisible();
  expect(mock.mutations[0]).toMatchObject({
    method: 'POST',
    body: { template: { name: 'september_offer', bodyExamples: ['Alex'] } },
  });
  await expect(page.getByRole('row').filter({ hasText: 'september_offer' })).toContainText(
    'Pending',
  );
  const original = page.getByRole('row').filter({ hasText: 'booking_update' });
  await original.getByRole('button', { name: /Duplicate$/ }).click();
  await expect(modal.getByLabel('Template name', { exact: true })).toHaveValue(
    'booking_update_copy',
  );
  await expect(modal.getByLabel('Website URL', { exact: true })).toHaveValue(
    'https://example.test/booking',
  );
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  await original.getByRole('button', { name: /Edit$/ }).click();
  await expect(modal.getByLabel('Template name', { exact: true })).toBeDisabled();
  await modal.getByLabel('Message', { exact: true }).fill('Hi {{1}}, your booking has changed.');
  await modal.getByRole('button', { name: 'Submit changes to Meta' }).click();
  await expect(modal).not.toBeVisible();
  expect(mock.mutations[1]).toMatchObject({
    method: 'PATCH',
    body: { template: { buttons: [{ url: 'https://example.test/booking' }] } },
  });
  await original.getByRole('button', { name: /Delete$/ }).click();
  await expect(modal).toContainText('every number in this WhatsApp Business Account');
  await modal.getByRole('button', { name: /Delete/ }).click();
  await expect(original).toHaveCount(0);
  expect(mock.mutations[2]?.method).toBe('DELETE');
});

test('shows channel health, direct Meta payments and unavailable expenses distinctly', async ({
  page,
}, testInfo) => {
  const mock = await mockApp(page, { analyticsFailure: true });
  await page.goto('/projects/project-a/channels/channel-wa');
  await expect(page.getByText('WhatsApp channel center', { exact: true })).toBeVisible();
  await expect(page.getByText('Token is valid', { exact: true })).toBeVisible();
  expect(mock.billingRequests()).toBe(0);
  await page.getByRole('tab', { name: 'Meta payments & costs' }).click();
  await expect(page.getByRole('link', { name: 'Set up payments in Meta' })).toHaveAttribute(
    'href',
    managerUrl,
  );
  await expect(page.getByText('Payment method: check in Meta', { exact: true })).toBeVisible();
  await expect(page.getByText('Meta has not granted access to this information.')).toBeVisible();
  await expect(
    page.locator('.wa-health-tile').filter({ hasText: 'Meta-reported message cost' }),
  ).toContainText('Unavailable');
  await page.screenshot({
    path: testInfo.outputPath('channel-payments.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('tab', { name: 'Status & quality' }).click();
  await page.getByRole('link', { name: 'Manage templates' }).click();
  await expect(page.getByRole('button', { name: /New template$/ })).toBeVisible();
});

test('read-only members cannot edit templates or request financial reports', async ({ page }) => {
  const mock = await mockApp(page, { manager: false });
  await page.goto('/projects/project-a/templates?provider=WHATSAPP');
  await expect(page.getByRole('cell', { name: 'booking_update', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /New template$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Delete$/ })).toHaveCount(0);
  await page.goto('/projects/project-a/channels/channel-wa');
  await expect(page.getByText('Token is valid', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Meta payments & costs' })).toHaveCount(0);
  expect(mock.billingRequests()).toBe(0);
});

test('shows a pre-send list-rate estimate and supports currency selection', async ({ page }) => {
  await mockApp(page);
  await page.goto('/projects/project-a/broadcasts/broadcast-a');
  await expect(page.getByText('Estimated Meta message cost', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'Rest of Western Europe', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.wa-cost-estimate')).toContainText('0.1184');
  await page.getByRole('combobox', { name: 'Estimate currency' }).click();
  await page.locator('.ant-select-item-option-content').filter({ hasText: /^EUR$/ }).click();
  await expect(page.locator('.wa-cost-estimate')).toContainText('Planning estimate in EUR');
});

test('keeps the template editor usable on a narrow screen', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApp(page);
  await page.goto('/projects/project-a/templates?provider=WHATSAPP');
  await page.getByRole('button', { name: /New template$/ }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByLabel('Template name', { exact: true })).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Submit to Meta', exact: true })).toBeInViewport();
  const bounds = await modal.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
  await page.screenshot({
    path: testInfo.outputPath('template-editor-mobile.png'),
    animations: 'disabled',
  });
});
