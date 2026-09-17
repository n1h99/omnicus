// Ported from the CRM conversation renderer; Omnicus API and layout are isolated here.
export function buildInlineKeyboard(buttons) {
  const rows = buttons
    .slice(0, 8)
    .filter((button) => button.text.trim() && button.value.trim())
    .map((button) => [
      {
        text: button.text.trim(),
        ...(button.action === 'callback'
          ? { callbackData: button.value.trim() }
          : { url: button.value.trim() }),
      },
    ]);
  return rows.length ? rows : undefined;
}
export function inferMediaKind(file) {
  const mime = file.type.toLowerCase().split(';')[0];
  const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
  if (mime === 'image/gif' || extension === '.gif') return 'ANIMATION';
  if (mime.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.webp'].includes(extension)) {
    return 'PHOTO';
  }
  if (
    mime.startsWith('video/') ||
    ['.mp4', '.mov', '.webm', '.mkv', '.3gp', '.3gpp'].includes(extension)
  ) {
    return 'VIDEO';
  }
  if (
    mime.startsWith('audio/') ||
    ['.mp3', '.m4a', '.aac', '.amr', '.ogg', '.opus', '.wav'].includes(extension)
  ) {
    return 'AUDIO';
  }
  return 'DOCUMENT';
}
export function mediaPresentationForKind(kind) {
  switch (kind) {
    case 'VOICE':
      return 'voice';
    case 'VIDEO_NOTE':
      return 'video_note';
    case 'ANIMATION':
      return 'animation';
    case 'STICKER':
      return 'sticker';
    case 'AUDIO':
      return 'audio';
    case 'PHOTO':
      return 'photo';
    case 'VIDEO':
      return 'video';
    default:
      return 'document';
  }
}
export function stickerMetadataLabel(metadata) {
  return [metadata.emoji, metadata.setName].filter((value) => Boolean(value)).join(' · ');
}
export function hasStoredAttachmentPreview(message) {
  return Boolean(message.attachment?.url && message.attachment.storageStatus === 'stored');
}
export function deliveryStatusLabel(status) {
  return status.toUpperCase();
}
export function isDeliveredStatus(status) {
  return ['sent', 'delivered', 'read'].includes(status);
}
