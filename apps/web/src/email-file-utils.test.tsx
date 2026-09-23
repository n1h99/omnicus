// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMAIL_TOTAL_LIMIT,
  emailFileProblem,
  emailPreviewType,
  readEmailFileResponse,
  useEmailFiles,
  type EmailFile,
} from './email-file-utils';

let root: Root;
let container: HTMLDivElement;
let files: ReturnType<typeof useEmailFiles>;
let upload: ReturnType<
  typeof vi.fn<(file: File, requestId: string, signal: AbortSignal) => Promise<EmailFile>>
>;
function Harness() {
  const state = useEmailFiles([], upload);
  useLayoutEffect(() => {
    files = state;
  });
  return null;
}
const file = (name = 'offer.pdf') =>
  new File(['%PDF-1.4\n%%EOF'], name, { type: 'application/pdf' });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  root = createRoot(container);
  upload = vi.fn(async (file, requestId) => ({
    id: requestId,
    filename: file.name,
    sizeBytes: file.size,
    status: 'AVAILABLE',
  }));
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('email attachment drafts', () => {
  it('uploads all selected files and keeps only successful IDs in the send payload', async () => {
    await act(async () => files.add([file(), file('photo.pdf')]));
    expect(upload).toHaveBeenCalledTimes(2);
    expect(files.items.map((item) => item.filename)).toEqual(['offer.pdf', 'photo.pdf']);
    expect(files.assetIds).toHaveLength(2);
    expect(files.blocked).toBe(false);
    act(() => files.remove(files.items[0]!.id));
    expect(files.assetIds).toHaveLength(1);
  });
  it('reserves the whole batch before a rapid second selection and blocks send while pending', async () => {
    upload.mockImplementation(() => new Promise(() => undefined));
    act(() => {
      files.add(Array.from({ length: 20 }, () => file()));
      files.add([file()]);
    });
    expect(files.items).toHaveLength(20);
    expect(files.error).toContain('20 attachments');
    expect(files.isBlocked()).toBe(true);
    expect(files.assetIds).toEqual([]);
  });
  it('keeps failed uploads visible and retries using the same request ID', async () => {
    upload.mockRejectedValueOnce(new Error('network'));
    await act(async () => files.add([file()]));
    expect(files.blocked).toBe(true);
    expect(files.items[0]?.state).toBe('error');
    const requestId = files.items[0]!.id;
    await act(async () => files.retry(files.items[0]!));
    expect(upload.mock.calls.map((call) => call[1])).toEqual([requestId, requestId]);
    expect(files.blocked).toBe(false);
  });
  it('aborts removed uploads and ignores late responses', async () => {
    let finish!: (file: EmailFile) => void;
    upload.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => files.add([file()]));
    const id = files.items[0]!.id;
    act(() => files.remove(id));
    expect(upload.mock.calls[0]?.[2].aborted).toBe(true);
    await act(async () =>
      finish({ id: 'late', filename: 'offer.pdf', sizeBytes: 10, status: 'AVAILABLE' }),
    );
    expect(files.items).toEqual([]);
  });
  it('does not attach uploads from a discarded compose to the next message', async () => {
    let finish!: (file: EmailFile) => void;
    upload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => files.add([file()]));
    act(() => files.reset());
    await act(async () => files.add([file('new.pdf')]));
    await act(async () => finish({ id: 'old', filename: 'offer.pdf', sizeBytes: 10 }));
    expect(files.items.map((row) => row.filename)).toEqual(['new.pdf']);
  });
  it('shows invalid files without uploading and keeps send blocked until removal', async () => {
    await act(async () => files.add([file('script.html'), new File([], 'empty.pdf')]));
    expect(upload).not.toHaveBeenCalled();
    expect(files.items[0]?.error).toContain('Unsupported');
    expect(files.items[1]?.error).toContain('empty');
    expect(files.blocked).toBe(true);
    act(() => files.reset());
    expect(files.blocked).toBe(false);
  });
  it('enforces file and aggregate limits, including library files', () => {
    expect(emailFileProblem({ name: 'large.pdf', size: 20 * 1024 * 1024 + 1 })).toContain('20 MB');
    act(() =>
      files.select([{ id: 'large', filename: 'large.pdf', sizeBytes: EMAIL_TOTAL_LIMIT + 1 }]),
    );
    expect(files.items).toEqual([]);
    expect(files.error).toContain('25 MB');
  });
});

describe('safe attachment reading', () => {
  it('checks content signatures instead of trusting filename or MIME type', async () => {
    await expect(emailPreviewType(new NodeBlob(['%PDF-1.4\n']) as Blob)).resolves.toBe(
      'application/pdf',
    );
    await expect(
      emailPreviewType(new NodeBlob(['<svg onload="alert(1)">'], { type: 'image/png' }) as Blob),
    ).rejects.toThrow('Preview is unavailable');
  });
  it('rejects an unauthorized download and bounds the streamed response', async () => {
    await expect(readEmailFileResponse(new Response('no', { status: 403 }))).rejects.toThrow(
      'no longer have access',
    );
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(EMAIL_TOTAL_LIMIT + 1));
      },
      cancel,
    });
    await expect(readEmailFileResponse(new Response(stream))).rejects.toThrow('download limit');
    expect(cancel).toHaveBeenCalled();
  });
});
