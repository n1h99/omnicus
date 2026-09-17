import { useQuery } from '@tanstack/react-query';

import { apiRequest } from './api';
import { useAuth } from './auth';

export type AudienceSelection = {
  contactIds?: string[];
  excludeTagIds?: string[];
  includeTagIds?: string[];
  mode: 'ALL_ACTIVE' | 'CONTACTS' | 'SEGMENT';
  segmentId?: string;
};

export type AudienceOptionContact = {
  channels?: string[];
  customFields?: Record<string, unknown>;
  displayName: string;
  eligibilityReason?: string | null;
  eligible?: boolean;
  email?: string | null;
  firstName?: string | null;
  id: string;
  lastName?: string | null;
  phone?: string | null;
  status?: string;
  username?: string | null;
};

export type AudienceOptions = {
  contacts: AudienceOptionContact[];
  segments: Array<{ id: string; memberCount?: number; name: string }>;
  tags: Array<{ color?: string | null; id: string; name: string }>;
};

export function useContactAudienceOptions(
  projectId?: string,
  connectionId?: string,
  enabled = true,
) {
  const { accessToken } = useAuth();
  const search = connectionId ? `?${new URLSearchParams({ connectionId }).toString()}` : '';
  return useQuery({
    enabled: Boolean(projectId && enabled),
    queryFn: () =>
      apiRequest<AudienceOptions>(
        `/api/v1/projects/${projectId}/contacts/audience-options${search}`,
        {},
        accessToken,
      ),
    queryKey: ['contact-audience-options', projectId, connectionId ?? null, accessToken],
  });
}
