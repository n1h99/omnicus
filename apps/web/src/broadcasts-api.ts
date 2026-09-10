import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from './api';
import { useAuth } from './auth';
import type { ChannelType } from './channels-api';
import type { WhatsAppTemplateComponentInput } from './whatsapp-templates-api';

export type BroadcastStatus =
  | 'DRAFT'
  | 'SCHEDULED'
  | 'PREPARING'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED'
  | 'ARCHIVED';
export type BroadcastAudience = {
  mode: 'ALL_ACTIVE' | 'SEGMENT' | 'CONTACTS';
  segmentId?: string;
  contactIds?: string[];
  includeTagIds?: string[];
  excludeTagIds?: string[];
};
export type Broadcast = {
  id: string;
  projectId: string;
  connectionId: string;
  channelType?: ChannelType;
  name: string;
  status: BroadcastStatus;
  audience: BroadcastAudience;
  text: string;
  whatsAppTemplate?: {
    templateId: string;
    name?: string;
    languageCode?: string;
    components?: WhatsAppTemplateComponentInput[];
  };
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
  recipientCount: number;
  recipientsByStatus?: Record<string, number>;
  createdAt: string;
  updatedAt: string;
};
export type BroadcastRecipient = {
  id: string;
  status: string;
  lastError: string | null;
  contact: { displayName: string };
  channelIdentity: { username: string | null; externalUserId: string };
  pricing?: { billable: boolean; category: string; type: string; pricingModel: string };
};
type Input = {
  name: string;
  connectionId: string;
  audience: BroadcastAudience;
  templateVersionId?: string;
  text?: string;
  whatsAppTemplate?: {
    templateId: string;
    components?: WhatsAppTemplateComponentInput[];
  };
};

export function useBroadcasts(projectId?: string, archived = false) {
  const { accessToken } = useAuth();
  return useQuery({
    enabled: Boolean(projectId),
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === projectId ? previousData : undefined,
    queryKey: ['broadcasts', projectId, archived],
    queryFn: () =>
      apiRequest<Broadcast[]>(
        `/api/v1/projects/${projectId}/broadcasts?archived=${archived}`,
        {},
        accessToken,
      ),
  });
}

export function useBroadcast(projectId?: string, broadcastId?: string) {
  const { accessToken } = useAuth();
  return useQuery({
    enabled: Boolean(projectId && broadcastId),
    queryKey: ['broadcast', projectId, broadcastId],
    refetchInterval: 5_000,
    queryFn: () =>
      apiRequest<Broadcast>(
        `/api/v1/projects/${projectId}/broadcasts/${broadcastId}`,
        {},
        accessToken,
      ),
  });
}

export function useBroadcastRecipients(projectId?: string, broadcastId?: string) {
  const { accessToken } = useAuth();
  return useQuery({
    enabled: Boolean(projectId && broadcastId),
    queryKey: ['broadcast-recipients', projectId, broadcastId],
    refetchInterval: 5_000,
    queryFn: () =>
      apiRequest<{ items: BroadcastRecipient[]; total: number }>(
        `/api/v1/projects/${projectId}/broadcasts/${broadcastId}/recipients`,
        {},
        accessToken,
      ),
  });
}

export function useBroadcastMutations(projectId?: string) {
  const { accessToken } = useAuth();
  const client = useQueryClient();
  const invalidate = async () => {
    await client.invalidateQueries({ queryKey: ['broadcasts', projectId] });
    await client.invalidateQueries({ queryKey: ['broadcast'] });
    await client.invalidateQueries({ queryKey: ['broadcast-recipients'] });
  };
  const request = <T>(path: string, method: string, body?: unknown) =>
    apiRequest<T>(
      `/api/v1/projects/${projectId}/broadcasts${path}`,
      { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      accessToken,
    );
  return {
    create: useMutation({
      mutationFn: (input: Input) => request<Broadcast>('', 'POST', input),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ id, ...input }: { id: string } & Partial<Input>) =>
        request<Broadcast>(`/${id}`, 'PATCH', input),
      onSuccess: invalidate,
    }),
    estimate: useMutation({
      mutationFn: (id: string) =>
        request<{ eligibleRecipients: number }>(`/${id}/estimate`, 'POST'),
    }),
    launch: useMutation({
      mutationFn: (id: string) => request<Broadcast>(`/${id}/launch`, 'POST'),
      onSuccess: invalidate,
    }),
    pause: useMutation({
      mutationFn: (id: string) => request<Broadcast>(`/${id}/pause`, 'POST'),
      onSuccess: invalidate,
    }),
    resume: useMutation({
      mutationFn: (id: string) => request<Broadcast>(`/${id}/resume`, 'POST'),
      onSuccess: invalidate,
    }),
    cancel: useMutation({
      mutationFn: (id: string) => request<Broadcast>(`/${id}/cancel`, 'POST'),
      onSuccess: invalidate,
    }),
    retryFailed: useMutation({
      mutationFn: (id: string) => request<Broadcast>(`/${id}/retry-failed`, 'POST'),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => request<Broadcast>(`/${id}`, 'DELETE'),
      onSuccess: invalidate,
    }),
    restore: useMutation({
      mutationFn: (id: string) => request<Broadcast>(`/${id}/restore`, 'POST'),
      onSuccess: invalidate,
    }),
    runAgain: useMutation({
      mutationFn: (id: string) => request<Broadcast>(`/${id}/run-again`, 'POST'),
      onSuccess: invalidate,
    }),
  };
}
