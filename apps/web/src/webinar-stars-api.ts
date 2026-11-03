import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from './api';
import { useAuth } from './auth';

export interface WebinarConnection {
  id: string;
  revision: number;
  verifiedAt: string | null;
  updatedAt: string;
  enabled?: boolean;
  enabledAt?: string | null;
  webhookConfigured?: boolean;
  lastPollError?: string | null;
  nextPollAt?: string;
}
export interface WebinarSummary {
  id: string;
  name: string | null;
  type: string;
  url: string | null;
  scheduledAtLocal: string | null;
  timezoneName: string | null;
  isLiveNow: boolean;
}
export interface WebinarReportSummary {
  id: string;
  webinarId: string;
  name: string | null;
  startedAtLocal: string | null;
  endedAtLocal: string | null;
  visitorsCount: number | null;
  visitorsPeak: number | null;
}
export interface WebinarParticipant {
  rowKey: string;
  visitorId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  joinedAtLocal: string | null;
  leftAtLocal: string | null;
  device: string | null;
  country: string | null;
  city: string | null;
  utm: string | null;
  comments: Array<{ atLocal: string | null; text: string | null }>;
  actions: Array<{
    type: string | null;
    status: string | null;
    label: string | null;
    showNumber: number | null;
  }>;
}
export interface WebinarReport extends WebinarReportSummary {
  participants: WebinarParticipant[];
}
interface ProviderPage<T> {
  items: T[];
  hasMore: boolean;
  offset: number;
}

export function useWebinarStars(
  projectId: string,
  connectionKey: string,
  activeTab: string,
  search: string,
  offset: number,
  reportId: string | null,
) {
  const { accessToken } = useAuth();
  const client = useQueryClient();
  const base = `/api/v1/projects/${projectId}/webinar-stars`;
  const key = ['webinar-stars', projectId];
  const ready = Boolean(connectionKey);
  const params = new URLSearchParams({ search, offset: String(offset), limit: '25' });
  const webinars = useQuery({
    queryKey: [...key, connectionKey, 'webinars', search, offset],
    queryFn: ({ signal }) =>
      apiRequest<ProviderPage<WebinarSummary>>(
        `${base}/webinars?${params}`,
        { signal },
        accessToken,
      ),
    enabled: ready && activeTab === 'webinars',
    retry: false,
    gcTime: 0,
  });
  const reports = useQuery({
    queryKey: [...key, connectionKey, 'reports', search, offset],
    queryFn: ({ signal }) =>
      apiRequest<ProviderPage<WebinarReportSummary>>(
        `${base}/reports?${params}`,
        { signal },
        accessToken,
      ),
    enabled: ready && activeTab === 'reports',
    retry: false,
    gcTime: 0,
  });
  const report = useQuery({
    queryKey: [...key, connectionKey, 'report', reportId],
    queryFn: ({ signal }) =>
      apiRequest<WebinarReport>(`${base}/reports/${reportId}`, { signal }, accessToken),
    enabled: ready && Boolean(reportId),
    retry: false,
    gcTime: 0,
  });
  const clear = async () => {
    await client.cancelQueries({ queryKey: key });
    client.removeQueries({ queryKey: key, predicate: (query) => query.queryKey[2] !== 'config' });
    await client.invalidateQueries({ queryKey: [...key, 'config'] });
  };
  const save = useMutation({
    mutationFn: (token: string) =>
      apiRequest<WebinarConnection>(
        base,
        { method: 'PUT', body: JSON.stringify({ token }) },
        accessToken,
      ),
    onSuccess: clear,
    gcTime: 0,
  });
  const test = useMutation({
    mutationFn: () => apiRequest<{ ok: boolean }>(`${base}/test`, { method: 'POST' }, accessToken),
    onSuccess: () => client.invalidateQueries({ queryKey: [...key, 'config'] }),
  });
  const disconnect = useMutation({
    mutationFn: () => apiRequest(base, { method: 'DELETE' }, accessToken),
    onSuccess: clear,
  });
  return { webinars, reports, report, save, test, disconnect };
}
