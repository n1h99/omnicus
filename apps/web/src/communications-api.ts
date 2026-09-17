import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from './api';
import { useAuth } from './auth';
import type { MediaAsset, MediaKind, MediaValidationChannel } from './media-api';
import type {
  WhatsAppMessageTemplate,
  WhatsAppTemplateComponentInput,
} from './whatsapp-templates-api';

export type CommunicationChannel = 'EMAIL' | 'TELEGRAM' | 'WHATSAPP';

export interface CommunicationContactRow {
  channels: CommunicationChannel[];
  displayName: string;
  email: string | null;
  id: string;
  lastInteractionAt: string | null;
  phone: string | null;
  preview: string | null;
  status: string;
}

export interface CommunicationContactsPage {
  items: CommunicationContactRow[];
  page: number;
  pageSize: number;
  total: number;
}

export interface CommunicationConnection {
  botUsername: string | null;
  id: string;
  name: string;
  status: string;
  type: 'TELEGRAM' | 'WHATSAPP';
}

export interface CommunicationIdentity {
  channel: 'TELEGRAM' | 'WHATSAPP';
  connection: CommunicationConnection;
  connectionId: string;
  conversation: null | {
    automationState: 'AUTO' | 'MANUAL' | 'PAUSED';
    id: string;
    lastInboundAt: string | null;
    lastMessageAt: string | null;
    serviceWindowExpiresAt: string | null;
    status: string;
  };
  displayName: string | null;
  externalUserId: string;
  id: string;
  status: string;
  username: string | null;
  whatsAppReachability: string | null;
}

export interface CommunicationContact {
  automationMode: 'ENABLED' | 'DISABLED';
  connections: CommunicationConnection[];
  displayName: string;
  email: string | null;
  id: string;
  identities: CommunicationIdentity[];
  phone: string | null;
  status: string;
  username: string | null;
  whatsAppConsentStatus: 'UNKNOWN' | 'GRANTED' | 'REVOKED';
}

export interface CommunicationMessage {
  content: Record<string, unknown>;
  createdAt: string;
  direction: 'INBOUND' | 'OUTBOUND';
  externalMessageId: string | null;
  failedAt: string | null;
  id: string;
  mediaAsset: null | {
    declaredMimeType: string | null;
    detectedMimeType: string | null;
    id: string;
    kind: string;
    originalFilename: string | null;
    sizeBytes: number;
    status: string;
  };
  metadata: Record<string, unknown> | null;
  sentAt: string | null;
  status: string;
  type: string;
  updatedAt: string;
}

export interface CommunicationMessagePage {
  conversation: null | {
    automationState: 'AUTO' | 'MANUAL' | 'PAUSED';
    id: string;
    lastInboundAt: string | null;
    serviceWindowExpiresAt: string | null;
    status: string;
  };
  items: CommunicationMessage[];
  nextCursor: string | null;
}

export type CommunicationTemplate = WhatsAppMessageTemplate & {
  disabledReason: string | null;
  sendable: boolean;
};

export type SendCommunicationInput = {
  channel: 'TELEGRAM' | 'WHATSAPP';
  clientRequestId: string;
  connectionId?: string;
  disableNotification?: boolean;
  hasSpoiler?: boolean;
  identityId?: string;
  inlineKeyboard?: unknown[][];
  interactive?: Record<string, unknown>;
  linkPreviewOptions?: Record<string, unknown>;
  media?: { kind: MediaKind; mediaAssetId: string };
  protectContent?: boolean;
  replyToMessageId?: string;
  replyMarkup?: Record<string, unknown>;
  richMessage?: Record<string, unknown>;
  structured?: Record<string, unknown>;
  template?: {
    components?: WhatsAppTemplateComponentInput[];
    languageCode: string;
    name: string;
  };
  text?: string;
};

export function useCommunicationContacts(projectId?: string, search = '', page = 1) {
  const { accessToken } = useAuth();
  const query = new URLSearchParams({ page: String(page), pageSize: '40' });
  if (search.trim()) query.set('search', search.trim());
  return useQuery({
    enabled: Boolean(projectId),
    placeholderData: (previous) => previous,
    queryFn: () =>
      apiRequest<CommunicationContactsPage>(
        `/api/v1/projects/${projectId}/communications/contacts?${query.toString()}`,
        {},
        accessToken,
      ),
    queryKey: ['communications', projectId, 'contacts', search, page],
    refetchInterval: 10_000,
  });
}

export function useCommunicationContact(projectId?: string, contactId?: string) {
  const { accessToken } = useAuth();
  return useQuery({
    enabled: Boolean(projectId && contactId),
    queryFn: () =>
      apiRequest<CommunicationContact>(
        `/api/v1/projects/${projectId}/communications/contacts/${contactId}`,
        {},
        accessToken,
      ),
    queryKey: ['communications', projectId, 'contact', contactId],
  });
}

export function useCommunicationMessages(
  projectId?: string,
  contactId?: string,
  identityId?: string,
) {
  const { accessToken } = useAuth();
  return useQuery({
    enabled: Boolean(projectId && contactId && identityId),
    queryFn: () =>
      apiRequest<CommunicationMessagePage>(
        `/api/v1/projects/${projectId}/communications/contacts/${contactId}/messages?identityId=${identityId}`,
        {},
        accessToken,
      ),
    queryKey: ['communications', projectId, 'messages', contactId, identityId],
    refetchInterval: 3_000,
  });
}

export function useCommunicationTemplates(
  projectId?: string,
  contactId?: string,
  connectionId?: string,
  enabled = true,
) {
  const { accessToken } = useAuth();
  return useQuery({
    enabled: Boolean(projectId && contactId && connectionId && enabled),
    queryFn: () =>
      apiRequest<CommunicationTemplate[]>(
        `/api/v1/projects/${projectId}/communications/contacts/${contactId}/whatsapp-templates?connectionId=${connectionId}`,
        {},
        accessToken,
      ),
    queryKey: ['communications', projectId, 'whatsapp-templates', contactId, connectionId],
  });
}

export function useCommunicationMedia(projectId?: string, enabled = true) {
  const { accessToken } = useAuth();
  return useQuery({
    enabled: Boolean(projectId && enabled),
    queryFn: () =>
      apiRequest<MediaAsset[]>(
        `/api/v1/projects/${projectId}/communications/media`,
        {},
        accessToken,
      ),
    queryKey: ['communications', projectId, 'media'],
  });
}

export function useCommunicationActions(projectId?: string, contactId?: string) {
  const { accessToken } = useAuth();
  const client = useQueryClient();
  const updated = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['communications', projectId, 'messages', contactId] }),
      client.invalidateQueries({ queryKey: ['communications', projectId, 'contact', contactId] }),
      client.invalidateQueries({ queryKey: ['communications', projectId, 'contacts'] }),
    ]);
  };
  return {
    send: useMutation({
      mutationFn: (input: SendCommunicationInput) =>
        apiRequest<{ messageId: string; operationId: string; status: 'QUEUED' }>(
          `/api/v1/projects/${projectId}/communications/contacts/${contactId}/messages`,
          { body: JSON.stringify(input), method: 'POST' },
          accessToken,
        ),
      onSuccess: updated,
    }),
    upload: useMutation({
      mutationFn: ({
        channel,
        file,
        kind,
      }: {
        channel: MediaValidationChannel;
        file: File;
        kind: MediaKind;
      }) => {
        const body = new FormData();
        body.set('file', file);
        return apiRequest<MediaAsset>(
          `/api/v1/projects/${projectId}/communications/media/upload/${kind}?channel=${channel.toLowerCase()}`,
          { body, method: 'POST' },
          accessToken,
        );
      },
      onSuccess: async () => {
        await client.invalidateQueries({ queryKey: ['communications', projectId, 'media'] });
      },
    }),
  };
}
