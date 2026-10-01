// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaLeadsPanel } from './meta-leads-panel';

const request = vi.hoisted(() => vi.fn());
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

describe('Meta lead admin panel', () => {
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
