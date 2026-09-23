import { useEffect, useRef, useState } from 'react';

export const EMAIL_FILE_LIMIT = 20 * 1024 * 1024;
export const EMAIL_TOTAL_LIMIT = 25 * 1024 * 1024;
export const EMAIL_FILE_ACCEPT =
  '.pdf,.docx,.xlsx,.pptx,.zip,.jpg,.jpeg,.png,.gif,.webp,.mp4,.m4a,.mp3,.ogg';
export type EmailFile = {
  id: string;
  filename: string;
  sizeBytes: number;
  contentType?: string | null;
  status?: string;
};
type DraftFile = EmailFile & {
  state: 'ready' | 'uploading' | 'error';
  file?: File;
  error?: string;
};
type Uploader = (file: File, requestId: string, signal: AbortSignal) => Promise<EmailFile>;

export function emailFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function emailFileProblem(file: Pick<File, 'name' | 'size'>) {
  if (!file.size) return 'This file is empty.';
  if (file.size > EMAIL_FILE_LIMIT) return 'This file exceeds the 20 MB limit.';
  if (!EMAIL_FILE_ACCEPT.split(',').includes('.' + file.name.split('.').at(-1)?.toLowerCase()))
    return 'Unsupported format. Use PDF, DOCX, XLSX, PPTX, ZIP, JPG, PNG, GIF, WebP, MP4, M4A, MP3 or OGG.';
  return '';
}

export function emailUploadError(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
  if (status === 413 || /TOO_LARGE|SIZE_LIMIT/i.test(code))
    return 'The file exceeds the upload limit.';
  if (
    /MIME|SIGNATURE|FORMAT|EXTENSION|MEDIA_.*INVALID|MEDIA_.*REJECTED|MEDIA_.*UNSUPPORTED/i.test(
      code,
    )
  )
    return 'This file format or its contents are not supported. Choose another file.';
  if (status === 401 || status === 403)
    return 'You no longer have access to upload files. Sign in again or check permissions.';
  return 'Upload failed. Retry or remove this file before sending.';
}

export function useEmailFiles(initial: EmailFile[], upload: Uploader, available?: EmailFile[]) {
  const [items, setItems] = useState<DraftFile[]>(() =>
    initial.map((file) => ({ ...file, state: 'ready' })),
  );
  const [error, setError] = useState('');
  const current = useRef(items);
  const active = useRef(new Map<string, AbortController>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const requests = active.current;
    return () => {
      alive.current = false;
      for (const request of requests.values()) request.abort();
      requests.clear();
    };
  }, []);
  const update = (next: DraftFile[]) => {
    current.current = next;
    if (alive.current) setItems(next);
  };
  const resolve = (rows: DraftFile[]) =>
    rows.map((item) => {
      if (item.status !== 'LOADING' || !available) return item;
      return {
        ...item,
        ...(available.find((entry) => entry.id === item.id) ?? { status: 'UNAVAILABLE' }),
      };
    });
  const read = () => resolve(current.current);
  const run = async (row: DraftFile) => {
    if (!row.file || !alive.current || !read().some((item) => item.id === row.id)) return;
    const request = new AbortController();
    active.current.set(row.id, request);
    update(
      read().map((item) =>
        item.id === row.id ? { ...item, state: 'uploading', error: '' } : item,
      ),
    );
    try {
      const file = await upload(row.file, row.id, request.signal);
      if (!request.signal.aborted && alive.current)
        update(read().map((item) => (item.id === row.id ? { ...file, state: 'ready' } : item)));
    } catch (cause) {
      if (!request.signal.aborted && alive.current)
        update(
          read().map((item) =>
            item.id === row.id ? { ...item, state: 'error', error: emailUploadError(cause) } : item,
          ),
        );
    } finally {
      active.current.delete(row.id);
    }
  };
  const add = (files: File[]) => {
    if (!files.length) return;
    if (files.length + current.current.length > 20) {
      setError('Up to 20 attachments per email.');
      return;
    }
    if (
      files.reduce((sum, file) => sum + file.size, 0) +
        read().reduce((sum, file) => sum + file.sizeBytes, 0) >
      EMAIL_TOTAL_LIMIT
    ) {
      setError('Attachments must total 25 MB or less.');
      return;
    }
    const rows: DraftFile[] = files.map((file) => {
      const problem = emailFileProblem(file);
      return {
        id: crypto.randomUUID(),
        filename: file.name,
        sizeBytes: file.size,
        file,
        state: problem ? 'error' : 'uploading',
        error: problem,
      };
    });
    setError('');
    update([...read(), ...rows]);
    // Reserve the entire batch before starting; rapid selections cannot exceed limits.
    void (async () => {
      for (const row of rows) if (row.state === 'uploading') await run(row);
    })();
  };
  const select = (files: EmailFile[]) => {
    if (
      files.length > 20 ||
      files.reduce((sum, file) => sum + file.sizeBytes, 0) > EMAIL_TOTAL_LIMIT
    ) {
      setError('Up to 20 files and 25 MB total per email.');
      return;
    }
    if (read().some((item) => item.state !== 'ready')) return;
    setError('');
    update(files.map((file) => ({ ...file, state: 'ready' })));
  };
  const remove = (id: string) => {
    active.current.get(id)?.abort();
    update(read().filter((item) => item.id !== id));
    setError('');
  };
  return {
    items: resolve(items),
    error,
    add,
    select,
    remove,
    retry: run,
    reset: () => {
      for (const request of active.current.values()) request.abort();
      active.current.clear();
      update([]);
      setError('');
    },
    blocked: resolve(items).some(
      (item) => item.state !== 'ready' || (item.status && item.status !== 'AVAILABLE'),
    ),
    isBlocked: () =>
      read().some((item) => item.state !== 'ready' || (item.status && item.status !== 'AVAILABLE')),
    assetIds: items.filter((item) => item.state === 'ready').map((item) => item.id),
  };
}

export async function readEmailFileResponse(response: Response) {
  if (!response.ok) throw new Error('This attachment is unavailable or you no longer have access.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The attachment could not be downloaded.');
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > EMAIL_TOTAL_LIMIT) throw new Error('This attachment exceeds the download limit.');
      chunks.push(new Uint8Array(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return new Blob(chunks, { type: 'application/octet-stream' });
}

export async function emailPreviewType(blob: Blob) {
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const text = String.fromCharCode(...bytes);
  if (text.startsWith('%PDF-')) return 'application/pdf';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte))
    return 'image/png';
  if (text.startsWith('GIF87a') || text.startsWith('GIF89a')) return 'image/gif';
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'image/webp';
  throw new Error('Preview is unavailable for this file. You can still download it.');
}
