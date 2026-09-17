import { useCallback, useRef } from 'react';
import { ApiError, apiRequest, getUserErrorMessage } from '../../api';
import { useAuth } from '../../auth';
import type {
  CompanyConversationResponse,
  ConversationMessage,
  ConversationMessagePage,
} from './types';

export { ApiError };
export const getFriendlyErrorMessage = getUserErrorMessage;

/** Keeps the CRM renderer's wire contract, but uses only the current Omnicus JWT/project. */
export function useTelegramChatApi(
  projectId: string,
  contactId: string,
  identityId: string,
  canSend: boolean,
) {
  const { accessToken } = useAuth();
  const uploads = useRef(new Map<string, Promise<string>>());
  const previews = useRef(
    new Map<string, { expires: number; value: Promise<string | undefined> }>(),
  );
  return useCallback(
    async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
      const root = `/api/v1/projects/${projectId}/communications`;
      const endpoint = `${root}/contacts/${contactId}/telegram/${identityId}`;
      const prefix = `/conversations/leads/${contactId}/telegram/company`;
      let resource: string;
      if (path === '/users/directory') resource = 'directory';
      else if (
        path === '/conversations/quick-replies' ||
        path.startsWith('/conversations/quick-replies/')
      )
        resource = path.slice('/conversations/'.length);
      else if (path === prefix || path.startsWith(`${prefix}/`))
        resource = path.slice(prefix.length).replace(/^\//, '');
      else throw new Error('Unsupported conversation resource');
      const method = options.method ?? 'GET';
      if (method !== 'GET' && !canSend)
        throw new ApiError(
          'PERMISSION_REQUIRED',
          'You do not have permission to send messages.',
          403,
        );
      const read = <R>(value: string) =>
        apiRequest<R>(
          `${endpoint}?${new URLSearchParams({ resource: value })}`,
          { signal: options.signal ?? null },
          accessToken,
        );
      const write = <R>(value: string, payload: unknown) =>
        apiRequest<R>(
          endpoint,
          {
            method: 'POST',
            body: JSON.stringify({ resource: value, method, payload }),
            signal: options.signal ?? null,
          },
          accessToken,
        );
      const upload = (file: File, kind: string, key: string) => {
        const cacheKey = `${projectId}:${identityId}:${key}`;
        let result = uploads.current.get(cacheKey);
        if (!result) {
          const body = new FormData();
          body.append('file', file);
          result = apiRequest<{ id: string }>(
            `${root}/media/upload/${kind}?channel=telegram`,
            { method: 'POST', body },
            accessToken,
          )
            .then((asset) => asset.id)
            .catch((error) => {
              uploads.current.delete(cacheKey);
              throw error;
            });
          uploads.current.set(cacheKey, result);
        }
        return result;
      };
      if (options.body instanceof FormData) {
        const form = options.body;
        const clientRequestId = String(form.get('clientRequestId') ?? '');
        if (resource === 'attachments') {
          const file = form.get('file');
          if (!(file instanceof File)) throw new Error('Choose a file');
          const kind = String(form.get('kind'));
          const mediaAssetId = await upload(file, kind, clientRequestId);
          return write<T>('messages', {
            clientRequestId,
            media: {
              kind,
              mediaAssetId,
              ...(form.has('durationSeconds')
                ? { durationSeconds: Number(form.get('durationSeconds')) }
                : {}),
            },
            ...(form.get('caption') ? { text: String(form.get('caption')) } : {}),
            ...(form.get('replyToMessageId')
              ? { replyToMessageId: String(form.get('replyToMessageId')) }
              : {}),
            hasSpoiler: form.get('hasSpoiler') === 'true',
            disableNotification: form.get('disableNotification') === 'true',
          });
        }
        if (resource === 'media-group') {
          const kinds = JSON.parse(String(form.get('kinds'))) as string[];
          const files = form.getAll('files');
          const items = await Promise.all(
            files.map(async (file, index) => {
              if (!(file instanceof File) || !kinds[index]) throw new Error('Invalid album');
              return {
                kind: kinds[index],
                mediaAssetId: await upload(file, kinds[index], `${clientRequestId}:${index}`),
                ...(index === 0 && form.get('caption')
                  ? { caption: String(form.get('caption')) }
                  : {}),
                hasSpoiler: form.get('hasSpoiler') === 'true',
              };
            }),
          );
          return write<T>(resource, {
            clientRequestId,
            items,
            disableNotification: form.get('disableNotification') === 'true',
          });
        }
        throw new Error('Unsupported attachment');
      }
      if (method !== 'GET')
        return write<T>(resource, typeof options.body === 'string' ? JSON.parse(options.body) : {});
      const result = await read<T>(resource);
      if (resource === '' || resource.startsWith('messages?') || resource === 'messages') {
        const page = result as CompanyConversationResponse | ConversationMessagePage;
        // The private signed URL is obtained with JWT; it never exposes a bot token.
        const hydrate = async (item: ConversationMessage) => {
          if (
            !item.attachment ||
            item.attachment.url ||
            !item.omnicusMessageId ||
            !item.attachment.providerAssetId
          )
            return;
          const key = `${projectId}:${identityId}:${item.attachment.providerAssetId}`;
          let cached = previews.current.get(key);
          if (!cached || cached.expires < Date.now()) {
            const value = read<{ url: string; expiresInSeconds: number }>(
              `media/${item.omnicusMessageId}`,
            )
              .then((response) => {
                const current = previews.current.get(key);
                if (current)
                  current.expires = Date.now() + Math.max(1, response.expiresInSeconds - 15) * 1000;
                return response.url;
              })
              .catch(() => undefined);
            cached = { value, expires: Date.now() + 30_000 };
            previews.current.set(key, cached);
          }
          const url = await cached.value;
          if (url)
            item.attachment = {
              ...item.attachment,
              url,
              storageStatus: 'stored',
              availability: 'available',
            };
        };
        const messages = page.messages ?? [];
        for (let index = 0; index < messages.length; index += 4)
          await Promise.all(messages.slice(index, index + 4).map(hydrate));
      }
      return result;
    },
    [accessToken, canSend, contactId, identityId, projectId],
  );
}
