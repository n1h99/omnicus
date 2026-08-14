import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from './api';
import { useAuth } from './auth';

export interface AutomationTag {
  color: string | null;
  id: string;
  name: string;
}

export interface AutomationCustomField {
  id: string;
  key: string;
  name: string;
  options: string[] | null;
  type: 'TEXT' | 'NUMBER' | 'BOOLEAN' | 'DATE' | 'DATETIME' | 'SELECT' | 'MULTI_SELECT' | 'JSON';
}

export interface AutomationSecret {
  createdAt: string;
  id: string;
  name: string;
  updatedAt: string;
}

export interface ExternalHttpTestResult {
  contentType: string | null;
  data: unknown;
  mappingKeys: string[];
  outcome: 'failure' | 'success';
  previewTruncated: boolean;
  sizeBytes: number;
  statusCode: number;
}

export interface LeadCaptureConfiguration {
  bodyExample: Record<string, unknown>;
  endpointUrl: string;
  headers: {
    'Idempotency-Key': string;
    'X-Omnicus-Ingest-Key': string;
  };
  sourceKey: string;
}

export function useLeadCaptureConfiguration(
  projectId: string | undefined,
  sourceKey: string,
  enabled: boolean,
) {
  const { accessToken } = useAuth();
  return useQuery({
    enabled: Boolean(projectId && sourceKey && enabled),
    queryFn: () =>
      apiRequest<LeadCaptureConfiguration>(
        `/api/v1/projects/${projectId}/lead-capture/${encodeURIComponent(sourceKey)}`,
        {},
        accessToken,
      ),
    queryKey: ['lead-capture-configuration', projectId, sourceKey, accessToken],
  });
}

export function useAutomationTags(projectId?: string) {
  const { accessToken } = useAuth();
  return useQuery({
    enabled: Boolean(projectId),
    queryFn: () =>
      apiRequest<AutomationTag[]>(`/api/v1/projects/${projectId}/tags`, {}, accessToken),
    queryKey: ['tags', projectId, accessToken],
  });
}

export function useAutomationCustomFields(projectId?: string) {
  const { accessToken } = useAuth();
  return useQuery({
    enabled: Boolean(projectId),
    queryFn: () =>
      apiRequest<AutomationCustomField[]>(
        `/api/v1/projects/${projectId}/custom-fields?archived=false`,
        {},
        accessToken,
      ),
    queryKey: ['custom-fields', projectId, accessToken, 'active'],
  });
}

export function useAutomationSecrets(projectId?: string) {
  const { accessToken } = useAuth();
  return useQuery({
    enabled: Boolean(projectId),
    queryFn: () =>
      apiRequest<AutomationSecret[]>(
        `/api/v1/projects/${projectId}/automation/secrets`,
        {},
        accessToken,
      ),
    queryKey: ['automation-secrets', projectId, accessToken],
  });
}

export function useAutomationHttpMutations(projectId?: string) {
  const { accessToken } = useAuth();
  const client = useQueryClient();
  const request = <T>(path: string, method: string, body?: unknown) =>
    apiRequest<T>(
      `/api/v1/projects/${projectId}/automation${path}`,
      { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      accessToken,
    );
  return {
    createSecret: useMutation({
      mutationFn: (input: { name: string; value: string }) =>
        request<AutomationSecret>('/secrets', 'POST', input),
      onSuccess: async () =>
        client.invalidateQueries({ queryKey: ['automation-secrets', projectId] }),
    }),
    testRequest: useMutation({
      mutationFn: (input: {
        config: Record<string, unknown>;
        variables?: Record<string, unknown>;
      }) => request<ExternalHttpTestResult>('/http/test', 'POST', input),
    }),
  };
}
