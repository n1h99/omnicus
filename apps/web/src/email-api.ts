import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EmailDocument } from '@omnicus/email-core';

import { apiRequest } from './api';
import { useAuth } from './auth';

export type EmailAudience = {
  contactIds?: string[];
  excludeTagIds?: string[];
  includeTagIds?: string[];
  mode: 'ALL_ACTIVE' | 'CONTACTS' | 'SEGMENT';
  segmentId?: string;
};

export type EmailCampaignStatus =
  | 'DRAFT'
  | 'SCHEDULED'
  | 'PREPARING'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED';

export type EmailCampaign = {
  audience: EmailAudience;
  completedAt: string | null;
  createdAt: string;
  design: EmailDocument;
  errorCode: string | null;
  id: string;
  metrics: Record<string, number>;
  name: string;
  preheader: string | null;
  projectId: string;
  scheduledAt: string | null;
  sourceTemplateVersionId: string | null;
  startedAt: string | null;
  status: EmailCampaignStatus;
  subject: string;
  totalRecipients: number;
  updatedAt: string;
};

export type EmailTemplateVersion = {
  createdAt: string;
  design: EmailDocument;
  id: string;
  preheader: string | null;
  status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
  subject: string;
  version: number;
};

export type EmailTemplate = {
  activeVersion: EmailTemplateVersion | null;
  activeVersionId: string | null;
  createdAt: string;
  description: string | null;
  draftVersion: EmailTemplateVersion | null;
  draftVersionId: string | null;
  id: string;
  name: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  updatedAt: string;
  versions: EmailTemplateVersion[];
};

export type EmailAudienceOptions = {
  contacts: Array<{
    displayName: string;
    email: string | null;
    emailConsentStatus: string;
    id: string;
    normalizedEmail: string | null;
  }>;
  segments: Array<{ id: string; name: string }>;
  suppressions: string[];
  tags: Array<{ color: string | null; id: string; name: string }>;
};

export type EmailSuppression = {
  createdAt: string;
  id: string;
  normalizedEmail: string;
  note: string | null;
  reason: string;
  source: string;
};

export type EmailDelivery = {
  attempts: number;
  contact: { displayName: string } | null;
  createdAt: string;
  id: string;
  lastError: string | null;
  providerEmailId: string | null;
  status: string;
  subject: string;
  toEmail: string;
};

export type EmailCampaignInput = {
  audience: EmailAudience;
  design: EmailDocument;
  name: string;
  preheader?: string | null;
  scheduledAt?: string | null;
  sourceTemplateVersionId?: string | null;
  subject: string;
};

const base = (projectId?: string) => `/api/v1/projects/${projectId}/email`;

export function useEmailCampaigns(projectId?: string) {
  const { accessToken } = useAuth();
  return useQuery({
    enabled: Boolean(projectId),
    queryFn: () => apiRequest<EmailCampaign[]>(`${base(projectId)}/campaigns`, {}, accessToken),
    queryKey: ['email-campaigns', projectId],
    refetchInterval: 5_000,
  });
}

export function useEmailCampaignDeliveries(projectId?: string, campaignId?: string) {
  const { accessToken } = useAuth();
  return useQuery({
    enabled: Boolean(projectId && campaignId),
    queryFn: () =>
      apiRequest<EmailDelivery[]>(
        `${base(projectId)}/campaigns/${campaignId}/deliveries`,
        {},
        accessToken,
      ),
    queryKey: ['email-deliveries', projectId, campaignId],
    refetchInterval: 5_000,
  });
}

export function useEmailTemplates(projectId?: string) {
  const { accessToken } = useAuth();
  return useQuery({
    enabled: Boolean(projectId),
    queryFn: () => apiRequest<EmailTemplate[]>(`${base(projectId)}/templates`, {}, accessToken),
    queryKey: ['email-templates', projectId],
  });
}

export function useEmailAudienceOptions(projectId?: string) {
  const { accessToken } = useAuth();
  return useQuery({
    enabled: Boolean(projectId),
    queryFn: () =>
      apiRequest<EmailAudienceOptions>(`${base(projectId)}/audience-options`, {}, accessToken),
    queryKey: ['email-audience-options', projectId],
  });
}

export function useEmailSuppressions(projectId?: string) {
  const { accessToken } = useAuth();
  return useQuery({
    enabled: Boolean(projectId),
    queryFn: () =>
      apiRequest<EmailSuppression[]>(`${base(projectId)}/suppressions`, {}, accessToken),
    queryKey: ['email-suppressions', projectId],
  });
}

export function useEmailMutations(projectId?: string) {
  const { accessToken } = useAuth();
  const client = useQueryClient();
  const request = <T>(path: string, method: string, body?: unknown) =>
    apiRequest<T>(
      `${base(projectId)}${path}`,
      { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      accessToken,
    );
  const invalidateCampaigns = () =>
    client.invalidateQueries({ queryKey: ['email-campaigns', projectId] });
  const invalidateTemplates = () =>
    client.invalidateQueries({ queryKey: ['email-templates', projectId] });
  const invalidateSuppressions = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['email-suppressions', projectId] }),
      client.invalidateQueries({ queryKey: ['email-audience-options', projectId] }),
    ]);
  return {
    addSuppression: useMutation({
      mutationFn: (input: { email: string; note?: string; reason?: string }) =>
        request<EmailSuppression>('/suppressions', 'POST', input),
      onSuccess: invalidateSuppressions,
    }),
    archiveTemplate: useMutation({
      mutationFn: (id: string) => request<{ archived: boolean }>(`/templates/${id}`, 'DELETE'),
      onSuccess: invalidateTemplates,
    }),
    cancelCampaign: useMutation({
      mutationFn: (id: string) => request<EmailCampaign>(`/campaigns/${id}/cancel`, 'POST'),
      onSuccess: invalidateCampaigns,
    }),
    createCampaign: useMutation({
      mutationFn: (input: EmailCampaignInput) =>
        request<EmailCampaign>('/campaigns', 'POST', input),
      onSuccess: invalidateCampaigns,
    }),
    createTemplate: useMutation({
      mutationFn: (input: {
        description?: string;
        design: EmailDocument;
        name: string;
        preheader?: string | null;
        subject: string;
      }) => request<EmailTemplate>('/templates', 'POST', input),
      onSuccess: invalidateTemplates,
    }),
    duplicateTemplate: useMutation({
      mutationFn: (id: string) => request<EmailTemplate>(`/templates/${id}/duplicate`, 'POST'),
      onSuccess: invalidateTemplates,
    }),
    estimateCampaign: useMutation({
      mutationFn: (id: string) =>
        request<{
          duplicateAddresses: number;
          eligibleRecipients: number;
          excludedNoConsent: number;
          excludedSuppressed: number;
          totalMatched: number;
        }>(`/campaigns/${id}/estimate`, 'POST'),
    }),
    launchCampaign: useMutation({
      mutationFn: (id: string) => request<EmailCampaign>(`/campaigns/${id}/launch`, 'POST'),
      onSuccess: invalidateCampaigns,
    }),
    pauseCampaign: useMutation({
      mutationFn: (id: string) => request<EmailCampaign>(`/campaigns/${id}/pause`, 'POST'),
      onSuccess: invalidateCampaigns,
    }),
    publishTemplate: useMutation({
      mutationFn: (id: string) => request<EmailTemplate>(`/templates/${id}/publish`, 'POST'),
      onSuccess: invalidateTemplates,
    }),
    removeSuppression: useMutation({
      mutationFn: (id: string) => request<{ removed: boolean }>(`/suppressions/${id}`, 'DELETE'),
      onSuccess: invalidateSuppressions,
    }),
    resumeCampaign: useMutation({
      mutationFn: (id: string) => request<EmailCampaign>(`/campaigns/${id}/resume`, 'POST'),
      onSuccess: invalidateCampaigns,
    }),
    retryCampaign: useMutation({
      mutationFn: (id: string) => request<EmailCampaign>(`/campaigns/${id}/retry-failed`, 'POST'),
      onSuccess: invalidateCampaigns,
    }),
    testSend: useMutation({
      mutationFn: (input: {
        design: EmailDocument;
        preheader?: string | null;
        subject: string;
        to: string;
      }) => request<EmailDelivery>('/test-send', 'POST', input),
    }),
    updateCampaign: useMutation({
      mutationFn: ({ id, ...input }: { id: string } & Partial<EmailCampaignInput>) =>
        request<EmailCampaign>(`/campaigns/${id}`, 'PATCH', input),
      onSuccess: invalidateCampaigns,
    }),
    updateTemplateDraft: useMutation({
      mutationFn: ({
        id,
        ...input
      }: {
        design: EmailDocument;
        id: string;
        preheader?: string | null;
        subject: string;
      }) => request<EmailTemplate>(`/templates/${id}/draft`, 'PATCH', input),
      onSuccess: invalidateTemplates,
    }),
  };
}
