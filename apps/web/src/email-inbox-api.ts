import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, ApiError } from './api';
import { useAuth } from './auth';
import { readApiBaseUrl } from './env';
import { readEmailFileResponse } from './email-file-utils';

export type Mailbox = {
  id: string;
  domainId: string;
  address: string;
  displayName: string;
  signature: string;
  status: 'ACTIVE' | 'DISABLED';
  mode: 'TWO_WAY' | 'SEND_ONLY';
  shared: boolean;
  isDefault: boolean;
  memberUserIds: string[];
  sendingReady: boolean;
  receivingReady: boolean;
};
export type MailDomain = {
  id: string;
  name: string;
  providerDomainId: string;
  status: string;
  region: string | null;
  sendingEnabled: boolean;
  receivingEnabled: boolean;
  receivingReady: boolean;
  lastCheckedAt: string | null;
  dnsRecords: Array<{
    record: string;
    name: string;
    type: string;
    value: string;
    status: string;
    priority?: number;
  }>;
};
export type MailAttachment = {
  id: string;
  filename: string;
  sizeBytes: number;
  status: string;
  errorCode: string | null;
  contentType?: string | null;
};
export type MailMessage = {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  fromAddress: string;
  toAddress: string;
  replyToAddress: string | null;
  subject: string;
  textBody: string;
  htmlBody: string;
  source: string;
  occurredAt: string;
  isAutomatic: boolean;
  attachments: MailAttachment[];
  outgoingAttachments?: Omit<MailAttachment, 'errorCode'>[];
  delivery: null | {
    status: string;
    lastError: string | null;
    attachmentAssetIds: string[];
    campaignId: string | null;
    scenarioExecutionId: string | null;
  };
};
export type MailThread = {
  id: string;
  mailboxId: string;
  contactId: string | null;
  peerEmail: string;
  subject: string;
  preview: string;
  lastMessageAt: string;
  messageCount: number;
  starred: boolean;
  unread: boolean;
  archived: boolean;
  mailbox: { address: string; displayName: string };
};
export type MailThreadDetail = MailThread & { messages: MailMessage[]; nextCursor: string | null };
export type MailDraft = {
  id: string;
  mailboxId: string;
  threadId: string | null;
  toEmail: string;
  subject: string;
  textBody: string;
  assetIds: string[];
  revision: number;
  updatedAt: string;
};

export function useInboxQuery<T>(
  projectId: string | undefined,
  path: string,
  enabled = true,
  poll = false,
) {
  const { accessToken, identity } = useAuth();
  return useQuery({
    queryKey: ['email-inbox', identity?.userId, projectId, path],
    queryFn: () =>
      apiRequest<T>(`/api/v1/projects/${projectId}/email-inbox/${path}`, {}, accessToken),
    enabled: Boolean(projectId && accessToken && enabled),
    refetchInterval: poll ? 15_000 : false,
  });
}
export function useMailboxes(projectId?: string, enabled = true) {
  return useInboxQuery<Mailbox[]>(projectId, 'mailboxes', enabled);
}
export function useInboxActions(projectId: string | undefined) {
  const { accessToken, identity } = useAuth();
  const client = useQueryClient();
  const refresh = () =>
    client.invalidateQueries({ queryKey: ['email-inbox', identity?.userId, projectId] });
  return {
    refresh,
    async attachment(path: string, signal: AbortSignal) {
      if (!accessToken) throw new Error('Sign in to download attachments.');
      return readEmailFileResponse(
        await fetch(`${readApiBaseUrl()}/api/v1/projects/${projectId}/email-inbox/${path}`, {
          headers: { Authorization: 'Bearer ' + accessToken },
          credentials: 'omit',
          signal,
        }),
      );
    },
    async request<T>(path: string, method: string, input?: unknown) {
      const result = await apiRequest<T>(
        `/api/v1/projects/${projectId}/email-inbox/${path}`,
        { method, ...(input === undefined ? {} : { body: JSON.stringify(input) }) },
        accessToken,
      );
      await refresh();
      return result;
    },
    async download(path: string, filename: string) {
      if (!accessToken) throw new Error('Sign in to download attachments.');
      const response = await fetch(
        `${readApiBaseUrl()}/api/v1/projects/${projectId}/email-inbox/${path}`,
        { headers: { Authorization: 'Bearer ' + accessToken }, credentials: 'omit' },
      );
      if (!response.ok)
        throw new ApiError(
          'EMAIL_ATTACHMENT_UNAVAILABLE',
          'Attachment could not be downloaded',
          response.status,
        );
      const url = URL.createObjectURL(await response.blob());
      const encodedName = response.headers
        .get('content-disposition')
        ?.match(/filename\*=UTF-8''(.+)$/i)?.[1];
      const link = document.createElement('a');
      link.href = url;
      link.download = encodedName ? decodeURIComponent(encodedName) : filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    },
  };
}
