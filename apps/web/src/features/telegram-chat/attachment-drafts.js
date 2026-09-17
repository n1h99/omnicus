// Ported from the CRM conversation renderer; Omnicus API and layout are isolated here.
import { inferMediaKind } from './conversation-composer.utils';
export function createAttachmentDrafts(
  files,
  selectedKind,
  dependencies = {
    createId: () => crypto.randomUUID(),
    createObjectUrl: (file) => URL.createObjectURL(file),
  },
) {
  return Array.from(files).map((file) => ({
    id: dependencies.createId(),
    file,
    kind: selectedKind === 'AUTO' ? inferMediaKind(file) : selectedKind,
    clientRequestId: dependencies.createId(),
    ...(file.type.startsWith('image/') || selectedKind === 'STICKER'
      ? { previewUrl: dependencies.createObjectUrl(file) }
      : {}),
    status: 'pending',
  }));
}
export function releaseAttachmentDraft(draft, revokeObjectUrl = URL.revokeObjectURL) {
  if (draft.previewUrl) revokeObjectUrl(draft.previewUrl);
}
export function reorderAttachmentDrafts(drafts, activeId, overId) {
  const from = drafts.findIndex((draft) => draft.id === activeId);
  const to = drafts.findIndex((draft) => draft.id === overId);
  if (from < 0 || to < 0 || from === to) return drafts;
  const next = [...drafts];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
export function planAttachmentOperations(
  drafts,
  text,
  replyToMessageId,
  hasSpoiler = false,
  captionUnsupportedKinds = ['VIDEO_NOTE', 'STICKER'],
) {
  const normalizedText = text.trim();
  const hasCaptionOwner = drafts.some((draft) => draft.operation?.caption);
  const captionTargetId =
    normalizedText && !hasCaptionOwner
      ? drafts.find((draft) => !draft.operation && !captionUnsupportedKinds.includes(draft.kind))
          ?.id
      : undefined;
  const hasExistingReply = drafts.some((draft) => draft.operation?.replyToMessageId);
  const sendTextSeparately = Boolean(normalizedText && !hasCaptionOwner && !captionTargetId);
  const replyForText = sendTextSeparately && !hasExistingReply ? replyToMessageId : undefined;
  let replyAssigned = hasExistingReply || Boolean(replyForText);
  const plannedDrafts = drafts.map((draft) => {
    if (draft.operation) return draft;
    const operation = {};
    if (draft.id === captionTargetId) operation.caption = normalizedText;
    if (!replyAssigned && replyToMessageId) {
      operation.replyToMessageId = replyToMessageId;
      replyAssigned = true;
    }
    if (hasSpoiler && ['PHOTO', 'VIDEO', 'ANIMATION'].includes(draft.kind)) {
      operation.hasSpoiler = true;
    }
    return { ...draft, operation };
  });
  return {
    drafts: plannedDrafts,
    captionTargetId: plannedDrafts.find((draft) => draft.operation?.caption)?.id,
    textOperation: sendTextSeparately
      ? {
          text: normalizedText,
          replyToMessageId: replyForText,
        }
      : undefined,
  };
}
export async function runAttachmentBatch(drafts, send) {
  const succeeded = [];
  const failed = [];
  for (const draft of drafts) {
    try {
      succeeded.push({ draft, result: await send(draft) });
    } catch (error) {
      failed.push({ draft, error });
    }
  }
  return { succeeded, failed };
}
export function createComposerSubmitGuard() {
  let active = false;
  return {
    get active() {
      return active;
    },
    async run(action) {
      if (active) return false;
      active = true;
      try {
        await action();
        return true;
      } finally {
        active = false;
      }
    },
  };
}
export function shouldSubmitComposerKey(input) {
  return input.key === 'Enter' && !input.shiftKey && !input.isComposing;
}
export function hasComposerContent(text, attachmentCount) {
  return Boolean(text.trim() || attachmentCount);
}
