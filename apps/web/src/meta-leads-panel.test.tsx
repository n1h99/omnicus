// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { message } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaLeadsPanel } from './meta-leads-panel';

const request = vi.hoisted(() => vi.fn());
const writeClipboard = vi.fn();
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
vi.mock('./auth', () => ({ useAuth: () => ({ accessToken: 'unit-test' }) }));
vi.mock('./api', () => ({ apiRequest: request, getUserErrorMessage: () => 'Request failed' }));
let root: Root;
let container: HTMLDivElement;
let cache: QueryClient;
const config = {
  pageId: '333',
  formIds: ['222'],
  graphVersion: 'v26.0',
  enabled: true,
  deliveryEnabled: false,
  liveFrom: '2026-10-01T00:00:00Z',
  verifiedAt: '2026-10-01T00:00:00Z',
  webhookPath: '/webhooks/meta-leads/project',
};

beforeEach(() => {
  writeClipboard.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: writeClipboard },
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }));
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  cache.setQueryData(['meta-leads', 'project', 'config'], config);
  cache.setQueryData(['meta-leads', 'project', 'submissions', undefined], {
    items: [
      {
        id: 'row',
        leadId: '111',
        state: 'PREVIEW_MATCH',
        historical: true,
        payload: { name: 'Existing manual lead', email: 'test@example.org' },
        result: { crmLeadId: 'existing-card' },
      },
    ],
    nextCursor: null,
  });
  cache.setQueryData(['meta-leads', 'project', 'polls'], []);
  request.mockReset();
  request.mockImplementation((path: string) =>
    Promise.resolve(
      path.endsWith('/submissions')
        ? { items: [], nextCursor: null }
        : path.endsWith('/polls')
          ? []
          : config,
    ),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  cache.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});
function mount() {
  act(() =>
    root.render(
      <QueryClientProvider client={cache}>
        <MetaLeadsPanel projectId="project" />
      </QueryClientProvider>,
    ),
  );
}
function button(text: string) {
  return Array.from(document.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === text,
  )!;
}
function expandSection(text: string) {
  const header = Array.from(container.querySelectorAll<HTMLElement>('.ant-collapse-header')).find(
    (item) => item.textContent?.includes(text),
  );
  expect(header).toBeDefined();
  act(() => (header!.querySelector<HTMLElement>('[role="button"], button') ?? header!).click());
}

describe('Meta lead admin panel', () => {
  it.each([
    {
      mode: 'live',
      enabled: true,
      deliveryEnabled: true,
      label: 'LIVE DELIVERY',
      description: 'Automatic delivery is enabled for new leads.',
    },
    {
      mode: 'preview',
      enabled: true,
      deliveryEnabled: false,
      label: 'PREVIEW ONLY',
      description: 'Compare incoming leads without automatic CRM creation.',
    },
    {
      mode: 'disabled',
      enabled: false,
      deliveryEnabled: false,
      label: 'DISABLED',
      description: 'Automatic intake is off. Saved submissions are kept.',
    },
  ])('shows the $mode summary and preserves action availability', (state) => {
    const currentConfig = {
      ...config,
      enabled: state.enabled,
      deliveryEnabled: state.deliveryEnabled,
    };
    cache.setQueryData(['meta-leads', 'project', 'config'], currentConfig);
    request.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith('/submissions')
          ? { items: [], nextCursor: null }
          : path.endsWith('/polls')
            ? []
            : currentConfig,
      ),
    );
    mount();
    const controls = container.querySelector('section[aria-label="Meta lead delivery controls"]');
    expect(controls).not.toBeNull();
    expect(controls!.querySelector('[role="status"]')?.textContent).toBe(state.label);
    expect(controls!.querySelector(`.meta-leads-mode-badge--${state.mode}`)).not.toBeNull();
    expect(controls!.textContent).toContain(state.description);
    expect(controls!.querySelector('time')?.dateTime).toBe(config.liveFrom);
    expect(controls!.querySelector('time')?.textContent).toBe(
      new Date(config.liveFrom).toLocaleString(),
    );
    expect(controls!.textContent).toContain('Browser local time');
    expect(button('Test access').disabled).toBe(state.enabled);
    expect(button('Start preview').disabled).toBe(false);
    expect(button('Enable live delivery').disabled).toBe(state.deliveryEnabled);
    expect(button('Stop').disabled).toBe(!state.enabled);
    expect(request.mock.calls.every((call) => !call[1]?.method)).toBe(true);
  });
  it('does not show a cutover or enable start actions before configuration', () => {
    cache.setQueryData(['meta-leads', 'project', 'config'], null);
    request.mockResolvedValue(null);
    mount();
    expect(container.querySelector('.meta-leads-cutover')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('DISABLED');
    for (const label of ['Test access', 'Start preview', 'Enable live delivery', 'Stop']) {
      expect(button(label).disabled).toBe(true);
    }
  });
  it('keeps Stop behind explicit confirmation in the restyled controls', async () => {
    mount();
    act(() => button('Stop').click());
    expect(document.body.textContent).toContain('Stop Meta intake?');
    expect(request.mock.calls.some((call) => String(call[0]).endsWith('/stop'))).toBe(false);
    await act(async () => button('OK').click());
    expect(request).toHaveBeenCalledWith(
      '/api/v1/projects/project/meta-leads/stop',
      expect.objectContaining({ method: 'POST', body: '{}' }),
      'unit-test',
    );
  });
  it('copies only the webhook path without changing the saved connection', async () => {
    const success = vi.spyOn(message, 'success').mockImplementation(() => undefined as never);
    mount();
    expandSection('Connection settings');
    const webhook = container.querySelector('section[aria-label="Webhook path"]');
    expect(webhook?.querySelector('code')?.textContent).toBe(config.webhookPath);
    expect(webhook?.textContent).toContain('Omnicus API domain, not the website address');
    await act(async () => button('Copy path').click());
    expect(writeClipboard).toHaveBeenCalledWith(config.webhookPath);
    expect(success).toHaveBeenCalledWith('Webhook path copied.');
    expect(request.mock.calls.every((call) => !call[1]?.method)).toBe(true);
  });
  it('keeps the path readable and reports a clipboard failure', async () => {
    writeClipboard.mockRejectedValue(new Error('Clipboard unavailable'));
    const error = vi.spyOn(message, 'error').mockImplementation(() => undefined as never);
    mount();
    expandSection('Connection settings');
    await act(async () => button('Copy path').click());
    expect(error).toHaveBeenCalledWith('Could not copy. Select and copy the path manually.');
    expect(container.querySelector('.meta-leads-webhook-endpoint code')?.textContent).toBe(
      config.webhookPath,
    );
  });
  it('uses a scoped compact calendar with hours and minutes, without seconds', async () => {
    mount();
    expandSection('Compare historical leads');
    const input = container.querySelector<HTMLInputElement>('.meta-leads-history-range input');
    expect(input).not.toBeNull();
    await act(async () => {
      input!.focus();
      input!.click();
    });
    const popup = document.querySelector('.meta-leads-history-picker');
    expect(popup).not.toBeNull();
    expect(popup!.querySelectorAll('.ant-picker-time-panel-column')).toHaveLength(2);
    expect(button('Run comparison').disabled).toBe(true);
    expect(request.mock.calls.every((call) => !call[1]?.method)).toBe(true);
  });
  it('shows preview results and never activates live delivery during rendering', () => {
    mount();
    expect(container.textContent).toContain('PREVIEW ONLY');
    expect(container.textContent).toContain('Existing CRM card');
    expect(container.textContent).toContain('Existing manual lead');
    expect(request.mock.calls.every((call) => !call[1]?.method || call[1].method === 'GET')).toBe(
      true,
    );
  });
  it('requires confirmation before enabling live delivery', async () => {
    mount();
    act(() => button('Enable live delivery').click());
    expect(document.body.textContent).toContain('Enable live lead delivery?');
    expect(request.mock.calls.some((call) => String(call[0]).endsWith('/start'))).toBe(false);
    await act(async () => {
      button('OK').click();
    });
    expect(request).toHaveBeenCalledWith(
      '/api/v1/projects/project/meta-leads/start',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ liveFrom: config.liveFrom, deliveryEnabled: true }),
      }),
      'unit-test',
    );
  });
  it('asks before linking a historical manual card and requests a silent approval', async () => {
    mount();
    act(() => button('Link').click());
    expect(document.body.textContent).toContain('does not send a NEW LEAD notification');
    expect(request.mock.calls.some((call) => String(call[0]).endsWith('/approve'))).toBe(false);
    await act(async () => {
      button('OK').click();
    });
    expect(request).toHaveBeenCalledWith(
      '/api/v1/projects/project/meta-leads/submissions/row/approve',
      expect.objectContaining({ body: JSON.stringify({ confirmHistoricalImport: true }) }),
      'unit-test',
    );
  });
});
