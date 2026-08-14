import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from './api';
import { useAuth } from './auth';

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  source: 'TELEGRAM' | 'USER_UPLOAD' | 'WHATSAPP';
  status: string;
  originalFilename: string | null;
  detectedMimeType: string | null;
  sizeBytes: string | null;
  validationChannel?: 'email' | 'telegram' | 'whatsapp';
  createdAt: string;
}

export type MediaKind =
  'ANIMATION' | 'AUDIO' | 'DOCUMENT' | 'PHOTO' | 'STICKER' | 'VIDEO' | 'VIDEO_NOTE' | 'VOICE';

export type MediaValidationChannel = 'EMAIL' | 'TELEGRAM' | 'WHATSAPP';

export function useMediaAssets(projectId?: string, enabled = true) {
  const { accessToken } = useAuth();
  return useQuery({
    enabled: Boolean(projectId && enabled),
    queryFn: () =>
      apiRequest<MediaAsset[]>(`/api/v1/projects/${projectId}/media-assets`, {}, accessToken),
    queryKey: ['media-assets', projectId],
  });
}

export function useMediaMutations(projectId?: string) {
  const { accessToken } = useAuth();
  const client = useQueryClient();
  const invalidate = () => client.invalidateQueries({ queryKey: ['media-assets', projectId] });
  return {
    materialize: useMutation({
      mutationFn: (assetId: string) =>
        apiRequest<MediaAsset>(
          `/api/v1/projects/${projectId}/media-assets/${assetId}/materialize`,
          { method: 'POST' },
          accessToken,
        ),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (assetId: string) =>
        apiRequest<{ deleted: boolean }>(
          `/api/v1/projects/${projectId}/media-assets/${assetId}`,
          { method: 'DELETE' },
          accessToken,
        ),
      onSuccess: invalidate,
    }),
    signedUrl: useMutation({
      mutationFn: (assetId: string) =>
        apiRequest<{ expiresInSeconds: number; url: string }>(
          `/api/v1/projects/${projectId}/media-assets/${assetId}/url`,
          {},
          accessToken,
        ),
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
        body.set('channel', channel.toLowerCase());
        return apiRequest<MediaAsset>(
          `/api/v1/projects/${projectId}/media-assets/upload/${kind}?channel=${channel.toLowerCase()}`,
          { body, method: 'POST' },
          accessToken,
        );
      },
      onSuccess: invalidate,
    }),
  };
}
