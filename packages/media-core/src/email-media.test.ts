import { describe, expect, it } from 'vitest';
import { prepareMediaForEmail } from './index';

describe('email attachment file formats', () => {
  it('recognizes M4A audio without confusing it with MP4 video', async () => {
    const bytes = new Uint8Array(16);
    bytes.set([0x66, 0x74, 0x79, 0x70], 4);
    const result = await prepareMediaForEmail({
      bytes,
      filename: 'recording.m4a',
      declaredMimeType: 'audio/mp4',
      kind: 'DOCUMENT',
      maximumBytes: 100,
    });
    expect(result.mimeType).toBe('audio/mp4');
    expect(result.extension).toBe('m4a');
  });
  it('accepts the Windows ZIP MIME alias but still rejects malformed archives', async () => {
    const bytes = new Uint8Array(22);
    bytes.set([0x50, 0x4b, 0x05, 0x06]);
    await expect(
      prepareMediaForEmail({
        bytes,
        filename: 'documents.zip',
        declaredMimeType: 'application/x-zip-compressed',
        kind: 'DOCUMENT',
        maximumBytes: 100,
      }),
    ).resolves.toMatchObject({ mimeType: 'application/zip' });
    await expect(
      prepareMediaForEmail({
        bytes: bytes.slice(0, 4),
        filename: 'documents.zip',
        declaredMimeType: 'application/x-zip-compressed',
        kind: 'DOCUMENT',
        maximumBytes: 100,
      }),
    ).rejects.toMatchObject({ code: 'media_zip_structure_invalid' });
  });
  it('does not accept a renamed executable as audio or an image', async () => {
    await expect(
      prepareMediaForEmail({
        bytes: new TextEncoder().encode('MZfake'),
        filename: 'file.m4a',
        declaredMimeType: 'audio/mp4',
        kind: 'DOCUMENT',
        maximumBytes: 100,
      }),
    ).rejects.toMatchObject({ code: 'media_type_rejected' });
    const bytes = new Uint8Array(16);
    bytes.set([0x66, 0x74, 0x79, 0x70], 4);
    await expect(
      prepareMediaForEmail({
        bytes,
        filename: 'movie.mp4',
        declaredMimeType: 'video/mp4',
        kind: 'PHOTO',
        maximumBytes: 100,
      }),
    ).rejects.toMatchObject({ code: 'email_image_type_rejected' });
  });
});
