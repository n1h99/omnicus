import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';

export type MediaKind =
  'ANIMATION' | 'AUDIO' | 'DOCUMENT' | 'PHOTO' | 'STICKER' | 'VIDEO' | 'VIDEO_NOTE' | 'VOICE';

export interface MediaStorageConfiguration {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  forcePathStyle?: boolean;
  region: string;
  secretAccessKey: string;
}

export class S3MediaStorage {
  private readonly client: S3Client;

  constructor(private readonly configuration: MediaStorageConfiguration) {
    this.client = new S3Client({
      credentials: {
        accessKeyId: configuration.accessKeyId,
        secretAccessKey: configuration.secretAccessKey,
      },
      endpoint: configuration.endpoint,
      forcePathStyle: configuration.forcePathStyle ?? false,
      region: configuration.region,
    });
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.configuration.bucket, Key: key }),
    );
  }

  async getObject(key: string): Promise<{ bytes: Uint8Array; contentType?: string }> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.configuration.bucket, Key: key }),
    );
    if (!response.Body) throw new Error('media_storage_object_body_missing');
    return {
      bytes: await response.Body.transformToByteArray(),
      ...(response.ContentType ? { contentType: response.ContentType } : {}),
    };
  }

  async putObject(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Body: bytes,
        Bucket: this.configuration.bucket,
        ContentType: contentType,
        Key: key,
        Metadata: metadata,
      }),
    );
  }

  async signedDownloadUrl(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.configuration.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }
}

export interface MediaValidationInput {
  bytes: Uint8Array;
  declaredMimeType?: string;
  filename?: string;
  kind: MediaKind;
  maximumBytes: number;
}

export interface ValidatedMedia {
  extension: string;
  height?: number;
  mimeType: string;
  sizeBytes: number;
  width?: number;
}

export interface PreparedMedia extends ValidatedMedia {
  bytes: Uint8Array;
  transformed: boolean;
}

interface ImageDimensions {
  height: number;
  width: number;
}

const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const TELEGRAM_PHOTO_MAX_DIMENSION_SUM = 10_000;
const TELEGRAM_PHOTO_MAX_ASPECT_RATIO = 20;
const TELEGRAM_STATIC_STICKER_MAX_BYTES = 512 * 1024;
const TELEGRAM_ANIMATED_STICKER_MAX_BYTES = 64 * 1024;
const TELEGRAM_VIDEO_STICKER_MAX_BYTES = 256 * 1024;
const MAXIMUM_IMAGE_INPUT_PIXELS = 100_000_000;
const OPEN_XML_DOCUMENTS = {
  docx: {
    folder: 'word/',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  pptx: {
    folder: 'ppt/',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  xlsx: {
    folder: 'xl/',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
} as const;

function readBigEndian16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 256 + bytes[offset + 1]!;
}

function readLittleEndian16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! + bytes[offset + 1]! * 256;
}

function readLittleEndian24(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! + bytes[offset + 1]! * 256 + bytes[offset + 2]! * 65_536;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (
    bytes.byteLength < 24 ||
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  )
    return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { height: view.getUint32(20), width: view.getUint32(16) };
}

const jpegStartOfFrameMarkers = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset < bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) return undefined;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))
      continue;
    if (offset + 1 >= bytes.byteLength) return undefined;
    const segmentLength = readBigEndian16(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return undefined;
    if (jpegStartOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) return undefined;
      return {
        height: readBigEndian16(bytes, offset + 3),
        width: readBigEndian16(bytes, offset + 5),
      };
    }
    offset += segmentLength;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.byteLength < 30) return undefined;
  const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (chunk === 'VP8X')
    return {
      height: readLittleEndian24(bytes, 27) + 1,
      width: readLittleEndian24(bytes, 24) + 1,
    };
  if (chunk === 'VP8 ') {
    if (bytes.byteLength < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a)
      return undefined;
    return {
      height: readLittleEndian16(bytes, 28) & 0x3fff,
      width: readLittleEndian16(bytes, 26) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    if (bytes.byteLength < 25 || bytes[20] !== 0x2f) return undefined;
    return {
      height: 1 + ((bytes[22]! >> 6) | (bytes[23]! << 2) | ((bytes[24]! & 0x0f) << 10)),
      width: 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8),
    };
  }
  return undefined;
}

function imageDimensions(bytes: Uint8Array, mimeType: string): ImageDimensions | undefined {
  if (mimeType === 'image/png') return pngDimensions(bytes);
  if (mimeType === 'image/jpeg') return jpegDimensions(bytes);
  if (mimeType === 'image/webp') return webpDimensions(bytes);
  return undefined;
}

function validateTelegramPhoto(bytes: Uint8Array, mimeType: string): ImageDimensions {
  if (bytes.byteLength > TELEGRAM_PHOTO_MAX_BYTES)
    throw new MediaValidationError('media_photo_size_exceeded');
  const dimensions = imageDimensions(bytes, mimeType);
  if (!dimensions || dimensions.width === 0 || dimensions.height === 0)
    throw new MediaValidationError('media_photo_dimensions_unreadable');
  const aspectRatio =
    Math.max(dimensions.width, dimensions.height) / Math.min(dimensions.width, dimensions.height);
  if (
    dimensions.width + dimensions.height > TELEGRAM_PHOTO_MAX_DIMENSION_SUM ||
    aspectRatio > TELEGRAM_PHOTO_MAX_ASPECT_RATIO
  )
    throw new MediaValidationError('media_photo_dimensions_rejected');
  return dimensions;
}

const signatures = [
  {
    extension: 'jpg',
    kinds: new Set<MediaKind>(['DOCUMENT', 'PHOTO']),
    mimeType: 'image/jpeg',
    matches: (bytes: Uint8Array) =>
      [0xff, 0xd8, 0xff].every((value, index) => bytes[index] === value),
  },
  {
    extension: 'png',
    kinds: new Set<MediaKind>(['DOCUMENT', 'PHOTO']),
    mimeType: 'image/png',
    matches: (bytes: Uint8Array) =>
      [0x89, 0x50, 0x4e, 0x47].every((value, index) => bytes[index] === value),
  },
  {
    extension: 'webp',
    kinds: new Set<MediaKind>(['DOCUMENT', 'PHOTO', 'STICKER']),
    mimeType: 'image/webp',
    matches: (bytes: Uint8Array) =>
      [0x52, 0x49, 0x46, 0x46].every((value, index) => bytes[index] === value) &&
      [0x57, 0x45, 0x42, 0x50].every((value, index) => bytes[index + 8] === value),
  },
  {
    extension: 'tgs',
    kinds: new Set<MediaKind>(['STICKER']),
    mimeType: 'application/x-tgsticker',
    matches: (bytes: Uint8Array) =>
      bytes.byteLength >= 10 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08,
  },
  {
    extension: 'webm',
    kinds: new Set<MediaKind>(['STICKER']),
    mimeType: 'video/webm',
    matches: (bytes: Uint8Array) =>
      bytes.byteLength >= 4 &&
      [0x1a, 0x45, 0xdf, 0xa3].every((value, index) => bytes[index] === value),
  },
  {
    extension: 'pdf',
    kinds: new Set<MediaKind>(['DOCUMENT']),
    mimeType: 'application/pdf',
    matches: (bytes: Uint8Array) =>
      [0x25, 0x50, 0x44, 0x46].every((value, index) => bytes[index] === value),
  },
  {
    extension: 'zip',
    kinds: new Set<MediaKind>(['DOCUMENT']),
    mimeType: 'application/zip',
    matches: (bytes: Uint8Array) =>
      ([0x03, 0x05] as const).some(
        (recordType) =>
          bytes[0] === 0x50 &&
          bytes[1] === 0x4b &&
          bytes[2] === recordType &&
          bytes[3] === (recordType === 0x03 ? 0x04 : 0x06),
      ),
  },
  {
    extension: 'gif',
    kinds: new Set<MediaKind>(['ANIMATION', 'DOCUMENT']),
    mimeType: 'image/gif',
    matches: (bytes: Uint8Array) =>
      bytes.byteLength >= 6 &&
      ['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.slice(0, 6))),
  },
  {
    extension: 'mp4',
    kinds: new Set<MediaKind>(['ANIMATION', 'DOCUMENT', 'VIDEO', 'VIDEO_NOTE']),
    mimeType: 'video/mp4',
    matches: (bytes: Uint8Array) =>
      bytes.byteLength >= 12 &&
      [0x66, 0x74, 0x79, 0x70].every((value, index) => bytes[index + 4] === value),
  },
  {
    extension: 'm4a',
    kinds: new Set<MediaKind>(['AUDIO', 'DOCUMENT', 'VOICE']),
    mimeType: 'audio/mp4',
    matches: (bytes: Uint8Array) =>
      bytes.byteLength >= 12 &&
      [0x66, 0x74, 0x79, 0x70].every((value, index) => bytes[index + 4] === value),
  },
  {
    extension: 'mp3',
    kinds: new Set<MediaKind>(['AUDIO', 'DOCUMENT', 'VOICE']),
    mimeType: 'audio/mpeg',
    matches: (bytes: Uint8Array) =>
      bytes.byteLength >= 3 &&
      ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
        (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)),
  },
  {
    extension: 'ogg',
    kinds: new Set<MediaKind>(['DOCUMENT', 'VOICE']),
    mimeType: 'audio/ogg',
    matches: (bytes: Uint8Array) =>
      bytes.byteLength >= 4 &&
      [0x4f, 0x67, 0x67, 0x53].every((value, index) => bytes[index] === value),
  },
] as const;

export class MediaValidationError extends Error {
  constructor(readonly code: string) {
    super('Media validation failed');
    this.name = 'MediaValidationError';
  }
}

interface DetectedMedia {
  extension: string;
  mimeType: string;
}

function validateMediaIdentity(input: MediaValidationInput): DetectedMedia {
  if (input.bytes.byteLength === 0) throw new MediaValidationError('media_empty');
  if (input.bytes.byteLength > input.maximumBytes)
    throw new MediaValidationError('media_size_exceeded');
  const signature = signatures.find(
    (candidate) => candidate.kinds.has(input.kind) && candidate.matches(input.bytes),
  );
  if (!signature) throw new MediaValidationError('media_type_rejected');
  const filenameExtension = input.filename?.split('.').pop()?.toLowerCase();
  const openXmlDocument =
    input.kind === 'DOCUMENT' &&
    signature.extension === 'zip' &&
    filenameExtension &&
    Object.hasOwn(OPEN_XML_DOCUMENTS, filenameExtension)
      ? OPEN_XML_DOCUMENTS[filenameExtension as keyof typeof OPEN_XML_DOCUMENTS]
      : undefined;
  if (openXmlDocument) {
    if (
      !containsAscii(input.bytes, '[Content_Types].xml') ||
      !containsAscii(input.bytes, openXmlDocument.folder)
    )
      throw new MediaValidationError('media_openxml_structure_invalid');
    if (
      input.declaredMimeType &&
      ![
        openXmlDocument.mimeType,
        'application/octet-stream',
        'application/zip',
        'application/x-zip-compressed',
      ].includes(input.declaredMimeType)
    )
      throw new MediaValidationError('media_mime_mismatch');
    return {
      extension: filenameExtension ?? signature.extension,
      mimeType: openXmlDocument.mimeType,
    };
  }
  if (input.declaredMimeType && input.declaredMimeType !== signature.mimeType) {
    const isGenericBinary =
      input.kind === 'STICKER' && input.declaredMimeType === 'application/octet-stream';
    const isTelegramStickerGzip =
      signature.mimeType === 'application/x-tgsticker' &&
      ['application/gzip', 'application/x-gzip'].includes(input.declaredMimeType);
    if (!isGenericBinary && !isTelegramStickerGzip)
      throw new MediaValidationError('media_mime_mismatch');
  }
  if (
    filenameExtension &&
    !(
      (signature.extension === 'jpg' && filenameExtension === 'jpeg') ||
      (signature.extension === 'm4a' && filenameExtension === 'mp4')
    ) &&
    filenameExtension !== signature.extension
  )
    throw new MediaValidationError('media_extension_mismatch');
  return signature;
}

function containsSequence(
  bytes: Uint8Array,
  sequence: readonly number[],
  minimumOffset: number,
): boolean {
  for (let offset = bytes.byteLength - sequence.length; offset >= minimumOffset; offset -= 1)
    if (sequence.every((value, index) => bytes[offset + index] === value)) return true;
  return false;
}

function validateDocumentStructure(bytes: Uint8Array, mimeType: string): void {
  if (mimeType === 'application/pdf') {
    const searchStart = Math.max(0, bytes.byteLength - 1_024);
    if (!containsSequence(bytes, [0x25, 0x25, 0x45, 0x4f, 0x46], searchStart))
      throw new MediaValidationError('media_pdf_structure_invalid');
    return;
  }
  if (
    mimeType !== 'application/zip' &&
    !Object.values(OPEN_XML_DOCUMENTS).some((document) => document.mimeType === mimeType)
  )
    return;
  const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (
      bytes[offset] !== 0x50 ||
      bytes[offset + 1] !== 0x4b ||
      bytes[offset + 2] !== 0x05 ||
      bytes[offset + 3] !== 0x06
    )
      continue;
    const commentLength = readLittleEndian16(bytes, offset + 20);
    if (offset + 22 + commentLength === bytes.byteLength) return;
  }
  throw new MediaValidationError('media_zip_structure_invalid');
}

export function validateMedia(input: MediaValidationInput): ValidatedMedia {
  const signature = validateMediaIdentity(input);
  if (input.kind === 'DOCUMENT') validateDocumentStructure(input.bytes, signature.mimeType);
  let dimensions: ImageDimensions | undefined;
  if (input.kind === 'PHOTO') dimensions = validateTelegramPhoto(input.bytes, signature.mimeType);
  if (input.kind === 'STICKER') {
    if (
      (signature.mimeType === 'image/webp' &&
        input.bytes.byteLength > TELEGRAM_STATIC_STICKER_MAX_BYTES) ||
      (signature.mimeType === 'application/x-tgsticker' &&
        input.bytes.byteLength > TELEGRAM_ANIMATED_STICKER_MAX_BYTES) ||
      (signature.mimeType === 'video/webm' &&
        input.bytes.byteLength > TELEGRAM_VIDEO_STICKER_MAX_BYTES)
    )
      throw new MediaValidationError('media_sticker_size_exceeded');
    if (signature.mimeType === 'image/webp') {
      dimensions = webpDimensions(input.bytes);
      if (
        !dimensions ||
        Math.max(dimensions.width, dimensions.height) !== 512 ||
        Math.min(dimensions.width, dimensions.height) < 1
      )
        throw new MediaValidationError('media_sticker_dimensions_rejected');
    }
  }
  return {
    extension: signature.extension,
    ...(dimensions ? { height: dimensions.height } : {}),
    mimeType: signature.mimeType,
    sizeBytes: input.bytes.byteLength,
    ...(dimensions ? { width: dimensions.width } : {}),
  };
}

function orientedDimensions(
  width: number,
  height: number,
  orientation: number | undefined,
): ImageDimensions {
  return orientation && orientation >= 5 && orientation <= 8
    ? { height: width, width: height }
    : { height, width };
}

function telegramPhotoCanvas(dimensions: ImageDimensions, scale = 1): ImageDimensions {
  let width = Math.max(1, Math.floor(dimensions.width * scale));
  let height = Math.max(1, Math.floor(dimensions.height * scale));
  if (width + height > TELEGRAM_PHOTO_MAX_DIMENSION_SUM) {
    const dimensionScale = TELEGRAM_PHOTO_MAX_DIMENSION_SUM / (width + height);
    width = Math.max(1, Math.floor(width * dimensionScale));
    height = Math.max(1, Math.floor(height * dimensionScale));
  }
  if (width / height > TELEGRAM_PHOTO_MAX_ASPECT_RATIO)
    height = Math.ceil(width / TELEGRAM_PHOTO_MAX_ASPECT_RATIO);
  if (height / width > TELEGRAM_PHOTO_MAX_ASPECT_RATIO)
    width = Math.ceil(height / TELEGRAM_PHOTO_MAX_ASPECT_RATIO);
  while (width + height > TELEGRAM_PHOTO_MAX_DIMENSION_SUM) {
    if (width >= height) width -= 1;
    else height -= 1;
  }
  return { height, width };
}

async function encodeTelegramPhoto(
  bytes: Uint8Array,
  source: ImageDimensions,
  target: ImageDimensions,
  quality: number,
): Promise<Uint8Array> {
  const resizedWidth = Math.min(source.width, target.width);
  const resizedHeight = Math.min(source.height, target.height);
  const resizedAspect = source.width / source.height;
  let contentWidth = resizedWidth;
  let contentHeight = Math.max(1, Math.round(contentWidth / resizedAspect));
  if (contentHeight > resizedHeight) {
    contentHeight = resizedHeight;
    contentWidth = Math.max(1, Math.round(contentHeight * resizedAspect));
  }
  const left = Math.floor((target.width - contentWidth) / 2);
  const right = target.width - contentWidth - left;
  const top = Math.floor((target.height - contentHeight) / 2);
  const bottom = target.height - contentHeight - top;
  return sharp(Buffer.from(bytes), {
    failOn: 'error',
    limitInputPixels: MAXIMUM_IMAGE_INPUT_PIXELS,
  })
    .rotate()
    .resize(contentWidth, contentHeight, { fit: 'fill' })
    .extend({
      background: { alpha: 1, b: 255, g: 255, r: 255 },
      bottom,
      left,
      right,
      top,
    })
    .flatten({ background: { b: 255, g: 255, r: 255 } })
    .jpeg({ chromaSubsampling: '4:4:4', mozjpeg: true, quality })
    .toBuffer();
}

async function prepareTelegramStaticSticker(input: MediaValidationInput): Promise<PreparedMedia> {
  try {
    const existing = validateMedia(input);
    return { ...existing, bytes: input.bytes, transformed: false };
  } catch (error) {
    if (
      !(error instanceof MediaValidationError) ||
      !['media_sticker_dimensions_rejected', 'media_sticker_size_exceeded'].includes(error.code)
    )
      throw error;
  }

  let metadata;
  try {
    metadata = await sharp(Buffer.from(input.bytes), {
      failOn: 'error',
      limitInputPixels: MAXIMUM_IMAGE_INPUT_PIXELS,
    }).metadata();
  } catch {
    throw new MediaValidationError('media_sticker_decode_failed');
  }
  if (!metadata.width || !metadata.height)
    throw new MediaValidationError('media_sticker_dimensions_unreadable');

  for (const quality of [100, 90, 80, 70, 60, 50, 40] as const) {
    let bytes: Uint8Array;
    try {
      bytes = await sharp(Buffer.from(input.bytes), {
        failOn: 'error',
        limitInputPixels: MAXIMUM_IMAGE_INPUT_PIXELS,
      })
        .rotate()
        .resize(512, 512, { fit: 'inside', withoutEnlargement: false })
        .webp({ effort: 6, quality, smartSubsample: true })
        .toBuffer();
    } catch {
      throw new MediaValidationError('media_sticker_transform_failed');
    }
    if (bytes.byteLength > TELEGRAM_STATIC_STICKER_MAX_BYTES) continue;
    const validated = validateMedia({
      bytes,
      declaredMimeType: 'image/webp',
      filename: 'telegram-sticker.webp',
      kind: 'STICKER',
      maximumBytes: TELEGRAM_STATIC_STICKER_MAX_BYTES,
    });
    return { ...validated, bytes, transformed: true };
  }

  throw new MediaValidationError('media_sticker_size_exceeded');
}

export async function prepareMediaForTelegram(input: MediaValidationInput): Promise<PreparedMedia> {
  const identity = validateMediaIdentity(input);
  if (input.kind === 'STICKER' && identity.mimeType === 'image/webp')
    return prepareTelegramStaticSticker(input);
  if (input.kind !== 'PHOTO') {
    const validated = validateMedia(input);
    return { ...validated, bytes: input.bytes, transformed: false };
  }
  let metadata;
  try {
    metadata = await sharp(Buffer.from(input.bytes), {
      failOn: 'error',
      limitInputPixels: MAXIMUM_IMAGE_INPUT_PIXELS,
    }).metadata();
  } catch {
    throw new MediaValidationError('media_photo_decode_failed');
  }
  if (!metadata.width || !metadata.height)
    throw new MediaValidationError('media_photo_dimensions_unreadable');
  const source = orientedDimensions(metadata.width, metadata.height, metadata.orientation);
  let scale = 1;
  const qualities = [90, 82, 74, 66, 58] as const;
  for (const quality of qualities) {
    const target = telegramPhotoCanvas(source, scale);
    let bytes: Uint8Array;
    try {
      bytes = await encodeTelegramPhoto(input.bytes, source, target, quality);
    } catch {
      throw new MediaValidationError('media_photo_transform_failed');
    }
    if (bytes.byteLength <= TELEGRAM_PHOTO_MAX_BYTES) {
      const validated = validateMedia({
        bytes,
        declaredMimeType: 'image/jpeg',
        filename: 'telegram-photo.jpg',
        kind: 'PHOTO',
        maximumBytes: TELEGRAM_PHOTO_MAX_BYTES,
      });
      return { ...validated, bytes, transformed: true };
    }
    scale *= Math.min(0.85, Math.sqrt((TELEGRAM_PHOTO_MAX_BYTES * 0.95) / bytes.byteLength));
  }
  throw new MediaValidationError('media_photo_size_exceeded');
}

/**
 * Email keeps the strict signature and document-structure checks while avoiding
 * messenger-specific image dimensions and transcoding.
 */
export async function prepareMediaForEmail(input: MediaValidationInput): Promise<PreparedMedia> {
  if (input.kind !== 'DOCUMENT' && input.kind !== 'PHOTO')
    throw new MediaValidationError('email_media_kind_unsupported');
  const validationInput = input.kind === 'PHOTO' ? { ...input, kind: 'DOCUMENT' as const } : input;
  const validated = validateMedia(validationInput);
  if (input.kind === 'PHOTO' && !validated.mimeType.startsWith('image/'))
    throw new MediaValidationError('email_image_type_rejected');
  return { ...validated, bytes: input.bytes, transformed: false };
}

const WHATSAPP_MEDIA_RULES = {
  AUDIO: {
    maximumBytes: 16 * 1024 * 1024,
    mimeTypes: ['audio/aac', 'audio/amr', 'audio/mp4', 'audio/mpeg', 'audio/ogg'],
  },
  DOCUMENT: {
    maximumBytes: 100 * 1024 * 1024,
    mimeTypes: [
      'application/msword',
      'application/pdf',
      'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ],
  },
  PHOTO: { maximumBytes: 5 * 1024 * 1024, mimeTypes: ['image/jpeg', 'image/png'] },
  STICKER: { maximumBytes: 100 * 1024, mimeTypes: ['image/webp'] },
  VIDEO: { maximumBytes: 16 * 1024 * 1024, mimeTypes: ['video/3gpp', 'video/mp4'] },
  VOICE: { maximumBytes: 16 * 1024 * 1024, mimeTypes: ['audio/ogg'] },
} as const;

type WhatsAppMediaKind = keyof typeof WHATSAPP_MEDIA_RULES;

const WHATSAPP_MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  'application/msword': ['doc'],
  'application/pdf': ['pdf'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.ms-powerpoint': ['ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'audio/aac': ['aac'],
  'audio/amr': ['amr'],
  'audio/mp4': ['m4a', 'mp4'],
  'audio/mpeg': ['mp3'],
  'audio/ogg': ['oga', 'ogg', 'opus'],
  'image/jpeg': ['jpeg', 'jpg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'text/plain': ['csv', 'log', 'text', 'txt'],
  'video/3gpp': ['3gp', '3gpp'],
  'video/mp4': ['mp4'],
};

function beginsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function containsAscii(bytes: Uint8Array, value: string): boolean {
  return Buffer.from(bytes).includes(Buffer.from(value, 'ascii'));
}

function isIsoBaseMedia(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 12 && beginsWith(bytes.slice(4), [0x66, 0x74, 0x79, 0x70]);
}

function validateWhatsAppFileIdentity(bytes: Uint8Array, mimeType: string): void {
  if (mimeType === 'image/jpeg' && !beginsWith(bytes, [0xff, 0xd8, 0xff]))
    throw new MediaValidationError('whatsapp_media_signature_mismatch');
  if (mimeType === 'image/png' && !beginsWith(bytes, [0x89, 0x50, 0x4e, 0x47]))
    throw new MediaValidationError('whatsapp_media_signature_mismatch');
  if (
    mimeType === 'image/webp' &&
    !(
      beginsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      beginsWith(bytes.slice(8), [0x57, 0x45, 0x42, 0x50])
    )
  )
    throw new MediaValidationError('whatsapp_media_signature_mismatch');
  if (mimeType === 'application/pdf') {
    if (!beginsWith(bytes, [0x25, 0x50, 0x44, 0x46]))
      throw new MediaValidationError('whatsapp_media_signature_mismatch');
    validateDocumentStructure(bytes, mimeType);
  }
  if (['audio/mp4', 'video/mp4', 'video/3gpp'].includes(mimeType) && !isIsoBaseMedia(bytes))
    throw new MediaValidationError('whatsapp_media_signature_mismatch');
  if (
    mimeType === 'audio/mpeg' &&
    !(
      beginsWith(bytes, [0x49, 0x44, 0x33]) ||
      (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xe0) === 0xe0)
    )
  )
    throw new MediaValidationError('whatsapp_media_signature_mismatch');
  if (
    mimeType === 'audio/aac' &&
    !(bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xf6) === 0xf0)
  )
    throw new MediaValidationError('whatsapp_media_signature_mismatch');
  if (mimeType === 'audio/amr' && !containsAscii(bytes.slice(0, 10), '#!AMR'))
    throw new MediaValidationError('whatsapp_media_signature_mismatch');
  if (mimeType === 'audio/ogg') {
    if (!beginsWith(bytes, [0x4f, 0x67, 0x67, 0x53]) || !containsAscii(bytes, 'OpusHead'))
      throw new MediaValidationError('whatsapp_ogg_opus_required');
  }
  const legacyOffice = [
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
  ];
  if (
    legacyOffice.includes(mimeType) &&
    !beginsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  )
    throw new MediaValidationError('whatsapp_media_signature_mismatch');
  const openXmlFolder: Readonly<Record<string, string>> = Object.fromEntries(
    Object.values(OPEN_XML_DOCUMENTS).map((document) => [document.mimeType, document.folder]),
  );
  const folder = openXmlFolder[mimeType];
  if (
    folder &&
    !(
      beginsWith(bytes, [0x50, 0x4b]) &&
      containsAscii(bytes, '[Content_Types].xml') &&
      containsAscii(bytes, folder)
    )
  )
    throw new MediaValidationError('whatsapp_media_signature_mismatch');
  if (mimeType === 'text/plain') {
    if (bytes.includes(0)) throw new MediaValidationError('whatsapp_text_document_invalid');
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new MediaValidationError('whatsapp_text_document_invalid');
    }
  }
}

/**
 * Validates a file against the official WhatsApp Cloud API media subset used by
 * Omnicus. Static stickers are normalized to Meta's square WebP contract.
 */
export async function prepareMediaForWhatsApp(input: MediaValidationInput): Promise<PreparedMedia> {
  if (!Object.hasOwn(WHATSAPP_MEDIA_RULES, input.kind))
    throw new MediaValidationError('whatsapp_media_kind_unsupported');
  if (input.bytes.byteLength === 0) throw new MediaValidationError('media_empty');
  const rule = WHATSAPP_MEDIA_RULES[input.kind as WhatsAppMediaKind];
  const maximumBytes = Math.min(input.maximumBytes, rule.maximumBytes);
  const maximumInputBytes = input.kind === 'STICKER' ? input.maximumBytes : maximumBytes;
  if (input.bytes.byteLength > maximumInputBytes)
    throw new MediaValidationError('whatsapp_media_size_exceeded');
  const mimeType = input.declaredMimeType?.split(';', 1)[0]?.trim().toLowerCase();
  if (!mimeType || !rule.mimeTypes.includes(mimeType as never))
    throw new MediaValidationError('whatsapp_media_type_unsupported');
  validateWhatsAppFileIdentity(input.bytes, mimeType);
  const allowedExtensions = WHATSAPP_MIME_EXTENSIONS[mimeType];
  const extension = input.filename?.split('.').pop()?.toLowerCase();
  if (extension && allowedExtensions && !allowedExtensions.includes(extension))
    throw new MediaValidationError('media_extension_mismatch');
  let dimensions: ImageDimensions | undefined;
  if (input.kind === 'PHOTO') {
    dimensions = imageDimensions(input.bytes, mimeType);
    if (!dimensions?.width || !dimensions.height)
      throw new MediaValidationError('media_photo_dimensions_unreadable');
  }
  if (input.kind === 'STICKER') {
    dimensions = webpDimensions(input.bytes);
    const extendedWebpAnimated =
      input.bytes.byteLength > 21 &&
      String.fromCharCode(...input.bytes.slice(12, 16)) === 'VP8X' &&
      (input.bytes[20]! & 0x02) !== 0;
    if (
      !dimensions ||
      extendedWebpAnimated ||
      containsAscii(input.bytes, 'ANIM') ||
      containsAscii(input.bytes, 'ANMF')
    )
      throw new MediaValidationError('whatsapp_sticker_dimensions_rejected');
    if (
      dimensions.width !== 512 ||
      dimensions.height !== 512 ||
      input.bytes.byteLength > maximumBytes
    ) {
      for (const quality of [90, 80, 70, 60, 50, 40, 30, 20] as const) {
        let bytes: Uint8Array;
        try {
          bytes = await sharp(Buffer.from(input.bytes), {
            failOn: 'error',
            limitInputPixels: MAXIMUM_IMAGE_INPUT_PIXELS,
          })
            .rotate()
            .resize(512, 512, {
              background: { alpha: 0, b: 0, g: 0, r: 0 },
              fit: 'contain',
              withoutEnlargement: false,
            })
            .webp({ alphaQuality: quality, effort: 6, quality, smartSubsample: true })
            .toBuffer();
        } catch {
          throw new MediaValidationError('whatsapp_sticker_transform_failed');
        }
        if (bytes.byteLength > maximumBytes) continue;
        validateWhatsAppFileIdentity(bytes, 'image/webp');
        const preparedDimensions = webpDimensions(bytes);
        if (preparedDimensions?.width !== 512 || preparedDimensions.height !== 512)
          throw new MediaValidationError('whatsapp_sticker_dimensions_rejected');
        return {
          bytes,
          extension: 'webp',
          height: 512,
          mimeType: 'image/webp',
          sizeBytes: bytes.byteLength,
          transformed: true,
          width: 512,
        };
      }
      throw new MediaValidationError('whatsapp_media_size_exceeded');
    }
  }
  return {
    bytes: input.bytes,
    extension: extension ?? allowedExtensions?.[0] ?? 'bin',
    ...(dimensions ? { height: dimensions.height, width: dimensions.width } : {}),
    mimeType,
    sizeBytes: input.bytes.byteLength,
    transformed: false,
  };
}

const templateExpression = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export function templateVariables(template: string): string[] {
  return [...template.matchAll(templateExpression)]
    .map((match) => match[1]!)
    .filter((value, index, values) => values.indexOf(value) === index);
}

export function renderTemplate(
  template: string,
  variables: Readonly<Record<string, unknown>>,
  maximumOutputLength = 4_096,
): { missing: string[]; output: string } {
  const missing = new Set<string>();
  const output = template.replace(templateExpression, (_match, path: string) => {
    const value = path.split('.').reduce<unknown>((current, part) => {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
      return (current as Record<string, unknown>)[part];
    }, variables);
    if (value === undefined || value === null) {
      missing.add(path);
      return '';
    }
    if (typeof value === 'object') throw new Error('template_variable_must_be_scalar');
    return String(value);
  });
  if (output.length > maximumOutputLength) throw new Error('template_output_too_large');
  return { missing: [...missing], output };
}

export function renderMessageTemplateContent(
  content: unknown,
  variables: Readonly<Record<string, unknown>>,
): { content: Record<string, unknown>; missing: string[] } {
  if (!content || typeof content !== 'object' || Array.isArray(content))
    throw new Error('template_content_invalid');
  const source = content as Record<string, unknown>;
  const field = source.kind === 'TEXT' ? 'text' : 'caption';
  const template = source[field];
  if (typeof template !== 'string') throw new Error('template_content_invalid');
  const rendered = renderTemplate(template, variables, field === 'caption' ? 1_024 : 4_096);
  return {
    content: { ...source, [field]: rendered.output },
    missing: rendered.missing,
  };
}
