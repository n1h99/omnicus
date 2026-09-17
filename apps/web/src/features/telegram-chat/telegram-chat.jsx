// Ported from the CRM conversation renderer; Omnicus API and layout are isolated here.
import {
  AppstoreAddOutlined,
  AudioOutlined,
  BellOutlined,
  BoldOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  CalendarOutlined,
  CodeOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  FileOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  HolderOutlined,
  InfoCircleOutlined,
  ItalicOutlined,
  HeartOutlined,
  LinkOutlined,
  LoadingOutlined,
  NotificationOutlined,
  PauseOutlined,
  PaperClipOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  PushpinOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  RobotOutlined,
  RollbackOutlined,
  SearchOutlined,
  SendOutlined,
  SettingOutlined,
  SmileOutlined,
  StopOutlined,
  StarFilled,
  StarOutlined,
  StrikethroughOutlined,
  ThunderboltOutlined,
  UpOutlined,
  DownOutlined,
  UnderlineOutlined,
  UserOutlined,
  VideoCameraOutlined,
  WhatsAppOutlined,
  WechatOutlined,
} from '@ant-design/icons';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import EmojiPicker, { EmojiStyle, Theme } from 'emoji-picker-react';
import {
  Alert,
  App,
  Avatar,
  Badge,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Input,
  Mentions,
  Modal,
  Popover,
  Segmented,
  Select,
  Spin,
  Switch,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, getFriendlyErrorMessage } from './api';
import { useAuth } from '../../auth';
import { useTelegramChatApi } from './api';
import './telegram-chat.css';
import {
  createAttachmentDrafts,
  createComposerSubmitGuard,
  hasComposerContent,
  planAttachmentOperations,
  reorderAttachmentDrafts,
  releaseAttachmentDraft,
  runAttachmentBatch,
  shouldSubmitComposerKey,
} from './attachment-drafts';
import { resolveWhatsAppTemplateMessage } from './whatsapp-template-message';
import {
  buildInlineKeyboard,
  deliveryStatusLabel,
  hasStoredAttachmentPreview,
  inferMediaKind,
  mediaPresentationForKind,
  stickerMetadataLabel,
} from './conversation-composer.utils';
import {
  buildConversationTimeline,
  conversationHistoryDateRange,
  extractConversationLinks,
  filterConversationMessages,
  interpolateQuickReply,
  messageTimestamp,
  mergeConversationMessages,
  noteMatchesHistorySearch,
  parseTelegramMessageEffects,
} from './telegram-chat-v3.utils';
import {
  canRetryProviderOperation,
  getStableRetryClientRequestId,
  isProviderOperationPending,
  isTelegramCapabilitySupported,
  latestMessageOperation,
  toggleComposerEntity,
} from './telegram-v3-capabilities';
import { RichMessageComposer } from './rich-message-composer';
const messageReactionOptions = [
  '👍',
  '👎',
  '❤️',
  '🔥',
  '🥰',
  '👏',
  '😁',
  '🤔',
  '🤯',
  '😱',
  '😢',
  '🎉',
  '🤩',
  '🙏',
  '👌',
  '💯',
  '🤣',
  '⚡',
  '🏆',
  '😍',
  '😭',
  '😎',
  '🤝',
  '👀',
];
const mediaKindLabels = {
  AUTO: 'Auto',
  PHOTO: 'Photo',
  DOCUMENT: 'Document',
  VIDEO: 'Video',
  AUDIO: 'Audio',
  VOICE: 'Voice message',
  VIDEO_NOTE: 'Video note',
  ANIMATION: 'Animation',
  STICKER: 'Sticker',
};
const telegramMediaKindDescriptions = {
  AUTO: 'Detect the correct Telegram type',
  PHOTO: 'JPEG, PNG or WEBP image',
  DOCUMENT: 'Keep any file in its original form',
  VIDEO: 'MP4 video',
  AUDIO: 'MP3 or M4A music file',
  VOICE: 'Audio converted to a voice message',
  VIDEO_NOTE: 'Video cropped into a round note',
  ANIMATION: 'GIF or H.264 MP4 animation',
  STICKER: 'WEBP, TGS or WEBM sticker',
};
const whatsAppMediaKindDescriptions = {
  AUTO: 'Detect the correct WhatsApp type',
  PHOTO: 'JPEG or PNG, up to 5 MB',
  DOCUMENT: 'TXT, PDF or Office document, up to 20 MB',
  VIDEO: 'MP4 or 3GP, up to 16 MB',
  AUDIO: 'AAC, AMR, MP3, M4A or OGG, up to 16 MB',
  VOICE: 'Supported audio converted to an OGG voice message',
  VIDEO_NOTE: 'Not available in WhatsApp',
  ANIMATION: 'Not available in WhatsApp',
  STICKER: 'WEBP sticker, up to 100 KB',
};
const whatsAppDocumentMimeTypes = new Set([
  'text/plain',
  'application/pdf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const telegramMediaAccept = {
  PHOTO: '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp',
  DOCUMENT: undefined,
  VIDEO: '.mp4,video/mp4',
  AUDIO: '.mp3,.m4a,audio/mpeg,audio/mp4',
  VOICE: '.ogg,.opus,.mp3,.m4a,.aac,.wav,.webm,audio/*',
  VIDEO_NOTE: '.mp4,.mov,.webm,.mkv,video/*',
  ANIMATION: '.gif,.mp4,image/gif,video/mp4',
  STICKER: '.webp,.tgs,.webm,image/webp,application/x-tgsticker,video/webm',
};
const whatsAppMediaAccept = {
  PHOTO: '.jpg,.jpeg,.png,image/jpeg,image/png',
  DOCUMENT: '.txt,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx',
  VIDEO: '.mp4,.3gp,.3gpp,video/mp4,video/3gpp',
  AUDIO: '.aac,.amr,.mp3,.m4a,.ogg,audio/*',
  VOICE: '.aac,.amr,.mp3,.m4a,.ogg,audio/*',
  VIDEO_NOTE: undefined,
  ANIMATION: undefined,
  STICKER: '.webp,image/webp',
};
function mediaInputAccept(channel, kind) {
  if (kind === 'AUTO') return undefined;
  return channel === 'whatsapp' ? whatsAppMediaAccept[kind] : telegramMediaAccept[kind];
}
function fileExtension(file) {
  return file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
}
function fileMatches(file, mimeTypes, extensions) {
  const mime = file.type.toLowerCase().split(';')[0];
  return mimeTypes.includes(mime) || extensions.includes(fileExtension(file));
}
function telegramMediaError(file, selectedKind) {
  const kind = selectedKind === 'AUTO' ? inferMediaKind(file) : selectedKind;
  if (file.size > 20 * 1024 * 1024) return 'The Telegram upload limit is 20 MB.';
  if (kind === 'DOCUMENT') return null;
  const rules = {
    PHOTO: {
      extensions: ['.jpg', '.jpeg', '.png', '.webp'],
      mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      message: 'Telegram photos must be JPEG, PNG or WEBP images.',
    },
    VIDEO: {
      extensions: ['.mp4'],
      mimeTypes: ['video/mp4'],
      message: 'Telegram videos must be MP4 files.',
    },
    AUDIO: {
      extensions: ['.mp3', '.m4a'],
      mimeTypes: ['audio/mpeg', 'audio/mp4'],
      message: 'Telegram audio files must be MP3 or M4A.',
    },
    VOICE: {
      extensions: ['.ogg', '.opus', '.mp3', '.m4a', '.aac', '.wav', '.webm'],
      mimeTypes: [
        'audio/ogg',
        'audio/opus',
        'audio/mpeg',
        'audio/mp4',
        'audio/aac',
        'audio/wav',
        'audio/webm',
      ],
      message: 'Telegram voice messages require an audio file.',
    },
    VIDEO_NOTE: {
      extensions: ['.mp4', '.mov', '.webm', '.mkv'],
      mimeTypes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'],
      message: 'Telegram video notes require a video file.',
    },
    ANIMATION: {
      extensions: ['.gif', '.mp4'],
      mimeTypes: ['image/gif', 'video/mp4'],
      message: 'Telegram animations must be GIF or MP4 files.',
    },
    STICKER: {
      extensions: ['.webp', '.tgs', '.webm'],
      mimeTypes: ['image/webp', 'application/x-tgsticker', 'video/webm'],
      message: 'Telegram stickers must be WEBP, TGS or WEBM files.',
    },
  };
  const rule = rules[kind];
  return rule && !fileMatches(file, rule.mimeTypes, rule.extensions) ? rule.message : null;
}
function whatsAppTemplateFields(template) {
  if (!template) return [];
  return template.components.flatMap((component, componentIndex) => {
    if (component.type === 'BUTTONS') {
      return (component.buttons ?? []).flatMap((button, buttonIndex) => {
        if (button.type === 'URL' && button.dynamic) {
          return [
            {
              key: `${componentIndex}:button:${buttonIndex}`,
              componentType: 'button',
              componentIndex,
              buttonIndex,
              buttonSubType: 'url',
              kind: 'url_suffix',
              label: `Website button value for “${button.text}”`,
              placeholder: 'Enter the dynamic part added to the website link',
            },
          ];
        }
        if (button.type === 'QUICK_REPLY') {
          return [
            {
              key: `${componentIndex}:button:${buttonIndex}`,
              componentType: 'button',
              componentIndex,
              buttonIndex,
              buttonSubType: 'quick_reply',
              kind: 'quick_reply',
              label: `Reply value for “${button.text}”`,
              placeholder: 'Value returned when the customer taps this reply',
            },
          ];
        }
        return [];
      });
    }
    if (!component.text || (component.type !== 'HEADER' && component.type !== 'BODY')) {
      return [];
    }
    const indexes = [
      ...new Set(
        [...component.text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((match) => Number(match[1])),
      ),
    ].sort((left, right) => left - right);
    return indexes.map((variableIndex) => ({
      key: `${componentIndex}:${variableIndex}`,
      componentType: component.type === 'HEADER' ? 'header' : 'body',
      componentIndex,
      variableIndex,
      kind: 'text',
      label: `${component.type === 'HEADER' ? 'Header' : 'Message'} field ${variableIndex}`,
      placeholder: `Value for {{${variableIndex}}}`,
    }));
  });
}
function whatsAppTemplateUnsupportedReason(template) {
  if (!template.sendable) {
    switch (template.disabledReason) {
      case 'WHATSAPP_AUTHENTICATION_TEMPLATE_UNSUPPORTED':
        return 'Authentication templates need a dedicated verification-code form.';
      case 'WHATSAPP_TEMPLATE_NOT_APPROVED':
        return 'This template is not approved.';
      case 'WHATSAPP_TEMPLATE_LOCATION_HEADER_UNSUPPORTED':
        return 'Location headers are not available in CRM yet.';
      case 'WHATSAPP_TEMPLATE_NAMED_VARIABLES_UNSUPPORTED':
      case 'WHATSAPP_TEMPLATE_PARAMETER_STYLE_UNSUPPORTED':
        return 'This template uses fields that CRM cannot fill safely yet.';
      default:
        return 'This template format is not available in CRM yet.';
    }
  }
  if (template.status !== 'APPROVED') return 'This template is not approved.';
  if (template.category === 'AUTHENTICATION') {
    return 'Authentication templates need a dedicated verification-code form.';
  }
  if (
    template.components.some(
      (component) =>
        component.format === 'LOCATION' ||
        (component.text &&
          [...component.text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].some(
            (match) => !/^\d+$/.test((match[1] ?? '').trim()),
          )),
    )
  ) {
    return 'This template contains a parameter type that CRM cannot fill safely.';
  }
  return null;
}
function buildWhatsAppTemplateSend(template, values, media) {
  const fields = whatsAppTemplateFields(template);
  if (fields.some((field) => !values[field.key]?.trim())) return null;
  const components = [];
  template.components.forEach((_component, componentIndex) => {
    const componentFields = fields.filter((field) => field.componentIndex === componentIndex);
    if (media?.componentIndex === componentIndex) {
      components.push({
        type: 'header',
        parameters: [
          {
            type: media.type,
            mediaAssetId: media.mediaAssetId,
          },
        ],
      });
      return;
    }
    if (!componentFields.length) return;
    const buttonFields = componentFields.filter((field) => field.componentType === 'button');
    buttonFields.forEach((field) => {
      if (field.buttonIndex === undefined || !field.buttonSubType) return;
      components.push({
        type: 'button',
        subType: field.buttonSubType,
        index: field.buttonIndex,
        parameters: [
          field.kind === 'quick_reply'
            ? { type: 'payload', payload: values[field.key].trim() }
            : { type: 'text', text: values[field.key].trim() },
        ],
      });
    });
    const textFields = componentFields.filter((field) => field.componentType !== 'button');
    if (!textFields.length) return;
    components.push({
      type: textFields[0].componentType,
      parameters: textFields.map((field) => ({
        type: 'text',
        text: values[field.key].trim(),
      })),
    });
  });
  return {
    name: template.name,
    languageCode: template.languageCode,
    components: components.length ? components : undefined,
  };
}
function whatsAppTemplatePreview(text, componentIndex, values) {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (_match, index) => {
    return values[`${componentIndex}:${Number(index)}`]?.trim() || `{{${index}}}`;
  });
}
function whatsAppMediaError(file, selectedKind) {
  const kind = selectedKind === 'AUTO' ? inferMediaKind(file) : selectedKind;
  const megabyte = 1024 * 1024;
  if (kind === 'VIDEO_NOTE' || kind === 'ANIMATION') {
    return 'Video notes and Telegram animations are not available in WhatsApp.';
  }
  if (
    kind === 'PHOTO' &&
    (!fileMatches(file, ['image/jpeg', 'image/png'], ['.jpg', '.jpeg', '.png']) ||
      file.size > 5 * megabyte)
  ) {
    return 'WhatsApp images must be JPEG or PNG and no larger than 5 MB.';
  }
  if (
    kind === 'VIDEO' &&
    (!fileMatches(file, ['video/mp4', 'video/3gpp'], ['.mp4', '.3gp', '.3gpp']) ||
      file.size > 16 * megabyte)
  ) {
    return 'WhatsApp videos must be MP4 or 3GP and no larger than 16 MB.';
  }
  if (
    (kind === 'AUDIO' || kind === 'VOICE') &&
    (!fileMatches(
      file,
      ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'],
      ['.aac', '.amr', '.mp3', '.m4a', '.ogg'],
    ) ||
      file.size > 16 * megabyte)
  ) {
    return 'WhatsApp audio must be AAC, AMR, MP3, M4A or OGG and no larger than 16 MB.';
  }
  if (
    kind === 'STICKER' &&
    (!fileMatches(file, ['image/webp'], ['.webp']) || file.size > 100 * 1024)
  ) {
    return 'WhatsApp stickers must be WEBP and no larger than 100 KB.';
  }
  if (
    kind === 'DOCUMENT' &&
    (![...whatsAppDocumentMimeTypes].some((mime) =>
      fileMatches(
        file,
        [mime],
        ['.txt', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'],
      ),
    ) ||
      file.size > 20 * megabyte)
  ) {
    return 'WhatsApp documents must be TXT, PDF, DOC, DOCX, XLS, XLSX, PPT or PPTX and no larger than 20 MB.';
  }
  return null;
}
function SortableAttachmentDraft({ id, disabled, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      className={`chat-attachment-draft-sortable${isDragging ? ' is-dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        className="chat-attachment-drag-handle"
        aria-label="Reorder attachment"
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        <HolderOutlined />
      </button>
      {children}
    </div>
  );
}
function formatStructuredCarOfferText(text) {
  return text;
}
function contactInitials(value) {
  return (
    value
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || 'C'
  );
}
function messageTime(item) {
  const timestamp = messageTimestamp(item);
  if (!timestamp) return '';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}
function recordingTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
const MAX_VOICE_RECORDING_SECONDS = 30 * 60;
const VOICE_RECORDING_BITS_PER_SECOND = 48_000;
function repairAudioDuration(audio) {
  if (Number.isFinite(audio.duration) && audio.duration > 0) return;
  try {
    const resetPosition = () => {
      audio.currentTime = 0;
    };
    audio.addEventListener('timeupdate', resetPosition, { once: true });
    audio.currentTime = Number.MAX_SAFE_INTEGER;
  } catch {
    // The persisted recording duration remains available as a UI fallback.
  }
}
function scheduleInputValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function disableDatesBefore(current, minimumValue) {
  const minimum = dayjs(minimumValue);
  return current.endOf('day').isBefore(minimum);
}
function disableTimesBefore(current, minimumValue) {
  if (!current) return {};
  const minimum = dayjs(minimumValue);
  if (!current.isSame(minimum, 'day')) return {};
  return {
    disabledHours: () => Array.from({ length: minimum.hour() }, (_, hour) => hour),
    disabledMinutes: (selectedHour) =>
      selectedHour === minimum.hour()
        ? Array.from({ length: minimum.minute() }, (_, minute) => minute)
        : [],
  };
}
function nextFiveMinuteStep(value) {
  const date = dayjs(value).second(0).millisecond(0);
  const remainder = date.minute() % 5;
  return remainder ? date.add(5 - remainder, 'minute') : date;
}
function renderFormattedMessage(text, entities) {
  if (!entities?.length) return text;
  const sorted = [...entities]
    .filter(
      (entity) =>
        entity.offset >= 0 && entity.length > 0 && entity.offset + entity.length <= text.length,
    )
    .sort((left, right) => left.offset - right.offset);
  const parts = [];
  let cursor = 0;
  for (const entity of sorted) {
    if (entity.offset < cursor) continue;
    if (entity.offset > cursor) parts.push(text.slice(cursor, entity.offset));
    const content = text.slice(entity.offset, entity.offset + entity.length);
    const key = `${entity.type}-${entity.offset}-${entity.length}`;
    const formatted =
      entity.type === 'bold' ? (
        <strong key={key}>{content}</strong>
      ) : entity.type === 'italic' ? (
        <em key={key}>{content}</em>
      ) : entity.type === 'underline' ? (
        <u key={key}>{content}</u>
      ) : entity.type === 'strikethrough' ? (
        <s key={key}>{content}</s>
      ) : entity.type === 'code' || entity.type === 'pre' ? (
        <code key={key}>{content}</code>
      ) : entity.type === 'spoiler' ? (
        <span className="chat-text-spoiler" key={key}>
          {content}
        </span>
      ) : (
        <span key={key}>{content}</span>
      );
    parts.push(formatted);
    cursor = entity.offset + entity.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}
function messageSourceLabel(item) {
  if (item.direction !== 'outbound') return item.senderName ?? 'Client';
  if (item.sourceContext?.displayName) return item.sourceContext.displayName;
  switch (item.source) {
    case 'AUTOMATION':
      return 'Automation';
    case 'BROADCAST':
      return 'Broadcast';
    case 'SYSTEM':
      return 'System';
    default:
      return item.senderName ?? 'Manager';
  }
}
function MessageSourceIcon({ item }) {
  if (item.direction !== 'outbound') return null;
  const label = messageSourceLabel(item);
  const icon =
    item.source === 'AUTOMATION' ? (
      <RobotOutlined />
    ) : item.source === 'BROADCAST' ? (
      <NotificationOutlined />
    ) : item.source === 'SYSTEM' ? (
      <SettingOutlined />
    ) : (
      <UserOutlined />
    );
  return (
    <span className="chat-message-source" aria-label={label}>
      {icon}
    </span>
  );
}
function DeliveryStatusIcon({ item }) {
  if (item.direction !== 'outbound') return null;
  const label = deliveryStatusLabel(item.status);
  const icon =
    item.status === 'queued' ? (
      <ClockCircleOutlined />
    ) : item.status === 'processing' ? (
      <LoadingOutlined spin />
    ) : item.status === 'failed' ? (
      <CloseCircleOutlined />
    ) : item.status === 'unknown' ? (
      <QuestionCircleOutlined />
    ) : ['sent', 'delivered', 'read'].includes(item.status) ? (
      <span className="chat-double-checks" aria-hidden="true">
        <CheckOutlined />
        <CheckOutlined />
      </span>
    ) : (
      <CheckOutlined />
    );
  return (
    <span className={`chat-delivery-status chat-delivery-status-${item.status}`} aria-label={label}>
      {icon}
    </span>
  );
}
function MessageAttachment({ item, spoilerRevealed, onRevealSpoiler }) {
  const attachment = item.attachment;
  if (!attachment) return null;
  const stickerMetadata = attachment.kind === 'STICKER' ? stickerMetadataLabel(attachment) : '';
  if (item.direction === 'inbound' && attachment.hasSpoiler && !spoilerRevealed) {
    return (
      <button type="button" className="chat-media-spoiler" onClick={onRevealSpoiler}>
        <EyeInvisibleOutlined />
        <span>
          <strong>Hidden media</strong>
          <small>Reveal</small>
        </span>
      </button>
    );
  }
  if (!attachment.url || (attachment.storageStatus && !hasStoredAttachmentPreview(item))) {
    return (
      <div className="chat-attachment-file">
        <FileOutlined />
        <span>
          <strong>{attachment.fileName}</strong>
          <small>
            {attachment.kind ? `${attachment.kind} · ` : ''}
            {stickerMetadata ? `${stickerMetadata} · ` : ''}
            {attachment.storageStatus === 'download_failed'
              ? 'Media download expired or failed'
              : attachment.availability === 'unavailable'
                ? 'WhatsApp could not make this file available'
                : 'Media metadata received; file is not available'}
          </small>
        </span>
      </div>
    );
  }
  const presentation = mediaPresentationForKind(attachment.kind);
  if (presentation === 'sticker') {
    const isVideoSticker =
      attachment.mimeType === 'video/webm' || attachment.fileName.toLowerCase().endsWith('.webm');
    const isStaticSticker =
      attachment.mimeType === 'image/webp' || attachment.fileName.toLowerCase().endsWith('.webp');
    if (isVideoSticker) {
      return (
        <div className="chat-sticker-media">
          <video
            className="chat-sticker-preview"
            src={attachment.url}
            autoPlay
            loop
            muted
            playsInline
          />
          {stickerMetadata ? (
            <small className="chat-sticker-metadata">{stickerMetadata}</small>
          ) : null}
        </div>
      );
    }
    if (isStaticSticker) {
      return (
        <div className="chat-sticker-media">
          <img
            className="chat-sticker-preview"
            src={attachment.url}
            alt={attachment.emoji ? `${attachment.emoji} sticker` : 'Sticker'}
          />
          {stickerMetadata ? (
            <small className="chat-sticker-metadata">{stickerMetadata}</small>
          ) : null}
        </div>
      );
    }
    return (
      <a
        href={attachment.url}
        target="_blank"
        rel="noreferrer"
        className="chat-attachment-file chat-sticker-fallback"
      >
        <PictureOutlined />
        <span>
          <strong>Animated sticker</strong>
          <small>
            {stickerMetadata ? `${stickerMetadata} · ${attachment.fileName}` : attachment.fileName}
          </small>
        </span>
      </a>
    );
  }
  if (presentation === 'photo') {
    return (
      <a href={attachment.url} target="_blank" rel="noreferrer" className="chat-attachment-preview">
        <img src={attachment.url} alt={attachment.fileName} />
      </a>
    );
  }
  if (presentation === 'animation') {
    return attachment.mimeType === 'image/gif' ? (
      <img className="chat-attachment-animation" src={attachment.url} alt={attachment.fileName} />
    ) : (
      <video className="chat-attachment-video" src={attachment.url} autoPlay loop muted controls />
    );
  }
  if (presentation === 'video' || presentation === 'video_note') {
    return (
      <video
        className={
          presentation === 'video_note'
            ? 'chat-attachment-video chat-attachment-video-note'
            : 'chat-attachment-video'
        }
        src={attachment.url}
        controls
        preload="metadata"
      />
    );
  }
  if (presentation === 'audio' || presentation === 'voice') {
    return (
      <div className={`chat-audio-message chat-audio-message-${presentation}`}>
        <small>
          {presentation === 'voice' ? 'Voice message' : 'Audio'}
          {attachment.durationSeconds ? ` · ${recordingTime(attachment.durationSeconds)}` : ''}
        </small>
        <audio
          className="chat-attachment-audio"
          src={attachment.url}
          controls
          preload="metadata"
          onLoadedMetadata={(event) => repairAudioDuration(event.currentTarget)}
        />
      </div>
    );
  }
  return (
    <a href={attachment.url} target="_blank" rel="noreferrer" className="chat-attachment-file">
      <FileOutlined />
      <span>
        <strong>{attachment.fileName}</strong>
        <small>
          {attachment.kind ?? 'DOCUMENT'} · {(attachment.size / 1024 / 1024).toFixed(2)} MB
        </small>
      </span>
    </a>
  );
}
export function TelegramChat({
  projectId,
  identityId,
  canSend,
  canManage,
  open,
  leadId,
  clientName,
  initialChannel,
  initialNoteId,
  pendingExpertMediaFiles = [],
  onPendingExpertMediaClear,
  onClose,
}) {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const { identity: user } = useAuth();
  const currentUser = { id: user?.userId, role: canManage ? 'ADMIN' : 'USER' };
  const apiRequest = useTelegramChatApi(projectId, leadId, identityId, canSend);
  const draftCloseRef = useRef(() => undefined);
  const [channel, setChannel] = useState('telegram');
  const [draft, setDraft] = useState('');
  const [draftEntities, setDraftEntities] = useState([]);
  const [draftSelection, setDraftSelection] = useState({ start: 0, end: 0 });
  const [protectContent, setProtectContent] = useState(false);
  const [disableNotification, setDisableNotification] = useState(false);
  const [messageEffectId, setMessageEffectId] = useState('');
  const [quoteText, setQuoteText] = useState('');
  const [linkPreviewOptions, setLinkPreviewOptions] = useState({});
  const [editingMessage, setEditingMessage] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const [editEntities, setEditEntities] = useState([]);
  const [mediaKind, setMediaKind] = useState('AUTO');
  const [hasSpoiler, setHasSpoiler] = useState(false);
  const [sendAsMediaGroup, setSendAsMediaGroup] = useState(false);
  const [revealedSpoilers, setRevealedSpoilers] = useState(() => new Set());
  const [replyTarget, setReplyTarget] = useState(null);
  const [keyboardButtons, setKeyboardButtons] = useState([]);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [isComposerSending, setIsComposerSending] = useState(false);
  const [automationResumeAt, setAutomationResumeAt] = useState('');
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [isKeyboardEditorOpen, setIsKeyboardEditorOpen] = useState(false);
  const [isReplyMarkupEditorOpen, setIsReplyMarkupEditorOpen] = useState(false);
  const [replyMarkupMode, setReplyMarkupMode] = useState('keyboard');
  const [replyKeyboardDraft, setReplyKeyboardDraft] = useState('');
  const [replyKeyboardPersistent, setReplyKeyboardPersistent] = useState(false);
  const [replyKeyboardOneTime, setReplyKeyboardOneTime] = useState(false);
  const [replyInputPlaceholder, setReplyInputPlaceholder] = useState('');
  const [replyMarkup, setReplyMarkup] = useState();
  const [isRichMessageOpen, setIsRichMessageOpen] = useState(false);
  const [richMessageDraft, setRichMessageDraft] = useState('');
  const [isStructuredMessageOpen, setIsStructuredMessageOpen] = useState(false);
  const [isWhatsAppTemplateOpen, setIsWhatsAppTemplateOpen] = useState(false);
  const [selectedWhatsAppTemplateId, setSelectedWhatsAppTemplateId] = useState('');
  const [whatsAppTemplateValues, setWhatsAppTemplateValues] = useState({});
  const [whatsAppTemplateMedia, setWhatsAppTemplateMedia] = useState(null);
  const [isSendingWhatsAppTemplate, setIsSendingWhatsAppTemplate] = useState(false);
  const [isWhatsAppInteractiveOpen, setIsWhatsAppInteractiveOpen] = useState(false);
  const [isSendingWhatsAppInteractive, setIsSendingWhatsAppInteractive] = useState(false);
  const [whatsAppInteractiveMedia, setWhatsAppInteractiveMedia] = useState(null);
  const [whatsAppInteractiveDraft, setWhatsAppInteractiveDraft] = useState({
    type: 'button',
    headerType: 'text',
    header: '',
    body: '',
    footer: '',
    actionLabel: 'Choose',
    sectionTitle: 'Options',
    options: '',
  });
  const [isScheduleOpen, setIsScheduleOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState(null);
  const [scheduleActionId, setScheduleActionId] = useState(null);
  const [scheduledAt, setScheduledAt] = useState('');
  const [scheduleMode, setScheduleMode] = useState('once');
  const [scheduleInterval, setScheduleInterval] = useState(1);
  const [scheduleCount, setScheduleCount] = useState(2);
  const [minimumScheduleTime] = useState(() =>
    scheduleInputValue(new Date(Date.now() + 60_000).toISOString()),
  );
  const [isBotInterfaceOpen, setIsBotInterfaceOpen] = useState(false);
  const [botCommandsDraft, setBotCommandsDraft] = useState('');
  const [botMenuType, setBotMenuType] = useState('commands');
  const [structuredMessageDraft, setStructuredMessageDraft] = useState({
    type: 'contact',
    firstName: '',
    lastName: '',
    phoneNumber: '',
    latitude: '',
    longitude: '',
    question: '',
    options: '',
  });
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [isQuickRepliesOpen, setIsQuickRepliesOpen] = useState(false);
  const [quickReplySearch, setQuickReplySearch] = useState('');
  const [isTemplateEditorOpen, setIsTemplateEditorOpen] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState(null);
  const [templateDraft, setTemplateDraft] = useState({
    title: '',
    content: '',
    scope: 'PERSONAL',
  });
  const [composerMode, setComposerMode] = useState('message');
  const [mentionedUserIds, setMentionedUserIds] = useState([]);
  const [editingNote, setEditingNote] = useState(null);
  const [editingNoteText, setEditingNoteText] = useState('');
  const [editingNoteMentionedUserIds, setEditingNoteMentionedUserIds] = useState([]);
  const [activeMessageActionsId, setActiveMessageActionsId] = useState(null);
  const [draftStorageStatus, setDraftStorageStatus] = useState('idle');
  const [voiceRecorderState, setVoiceRecorderState] = useState('idle');
  const [voiceElapsedSeconds, setVoiceElapsedSeconds] = useState(0);
  const [voiceDraft, setVoiceDraft] = useState(null);
  const [isVideoNoteRecorderOpen, setIsVideoNoteRecorderOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [historyFilter, setHistoryFilter] = useState('all');
  const [historyDate, setHistoryDate] = useState('');
  const [searchResultIndex, setSearchResultIndex] = useState(0);
  const [highlightedMessageId, setHighlightedMessageId] = useState(null);
  const [olderMessages, setOlderMessages] = useState([]);
  const [olderHistoryCursor, setOlderHistoryCursor] = useState(undefined);
  const [olderHistoryScope, setOlderHistoryScope] = useState('');
  const [isOlderHistoryLoading, setIsOlderHistoryLoading] = useState(false);
  const messageListRef = useRef(null);
  const composerRef = useRef(null);
  const attachmentInputRef = useRef(null);
  const draftSelectionRef = useRef({ start: 0, end: 0 });
  const pendingClientRequestIdRef = useRef(null);
  const mediaGroupClientRequestIdRef = useRef(null);
  const structuredClientRequestIdRef = useRef(null);
  const scheduleClientRequestIdRef = useRef(null);
  const botInterfaceClientRequestIdRef = useRef(null);
  const automationRequestRef = useRef(null);
  useEffect(() => {
    structuredClientRequestIdRef.current = null;
  }, [structuredMessageDraft]);
  useEffect(() => {
    scheduleClientRequestIdRef.current = null;
  }, [draft, scheduledAt]);
  useEffect(() => {
    botInterfaceClientRequestIdRef.current = null;
  }, [botCommandsDraft, botMenuType]);
  const retryClientRequestIdsRef = useRef(new Map());
  const retryInFlightRef = useRef(new Set());
  const attachmentObjectUrlsRef = useRef(new Set());
  const submitGuardRef = useRef(createComposerSubmitGuard());
  const shouldStickToBottomRef = useRef(true);
  const clearedUnreadKeyRef = useRef(null);
  const whatsAppReadInFlightRef = useRef(new Set());
  const whatsAppReadCompletedRef = useRef(new Set());
  const whatsAppReadAttemptsRef = useRef(new Map());
  const wasOpenRef = useRef(false);
  const highlightTimerRef = useRef(null);
  const voiceRecorderRef = useRef(null);
  const voiceStreamRef = useRef(null);
  const voiceChunksRef = useRef([]);
  const voiceTimerRef = useRef(null);
  const discardVoiceRecordingRef = useRef(false);
  const voiceElapsedRef = useRef(0);
  const voiceAccumulatedMillisecondsRef = useRef(0);
  const voiceSegmentStartedAtRef = useRef(null);
  const voiceDraftUrlRef = useRef(null);
  const expertMediaRequestIdsRef = useRef(new Map());
  const lastChatActionAtRef = useRef(0);
  const openedInitialNoteRef = useRef(null);
  const hydratedDraftKeyRef = useRef(null);
  const draftSaveTimerRef = useRef(null);
  const whatsAppReadNotificationKeysRef = useRef(new Set());
  const deliveryNotificationStateRef = useRef(null);
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const stopVoiceResources = useCallback(() => {
    if (voiceTimerRef.current) {
      clearInterval(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }
    for (const track of voiceStreamRef.current?.getTracks() ?? []) track.stop();
    voiceStreamRef.current = null;
  }, []);
  const clearVoiceDraft = useCallback(() => {
    setVoiceDraft((current) => {
      if (current?.url) URL.revokeObjectURL(current.url);
      return null;
    });
    voiceDraftUrlRef.current = null;
    setVoiceElapsedSeconds(0);
    voiceElapsedRef.current = 0;
    setVoiceRecorderState('idle');
  }, []);
  const resetVoiceRecorder = useCallback(() => {
    discardVoiceRecordingRef.current = true;
    const recorder = voiceRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    voiceRecorderRef.current = null;
    stopVoiceResources();
    clearVoiceDraft();
  }, [clearVoiceDraft, stopVoiceResources]);
  const conversationQuery = useQuery({
    queryKey: [`omnicus-${projectId}-${identityId}-lead-company-conversation`, leadId, channel],
    queryFn: () => apiRequest(`/conversations/leads/${leadId}/${channel}/company`),
    enabled: open,
    refetchInterval: open ? 3000 : false,
  });
  const hasServerHistorySearch = Boolean(
    isSearchOpen && (searchQuery.trim() || historyFilter !== 'all' || historyDate),
  );
  const searchedHistoryQuery = useInfiniteQuery({
    queryKey: [
      `omnicus-${projectId}-${identityId}-conversation-history-search`,
      leadId,
      channel,
      searchQuery.trim(),
      historyFilter,
      historyDate,
    ],
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        limit: '100',
        filter: historyFilter,
      });
      if (searchQuery.trim()) params.set('query', searchQuery.trim());
      if (pageParam) params.set('cursor', pageParam);
      const range = conversationHistoryDateRange(historyDate);
      if (range) {
        params.set('dateFrom', range.dateFrom);
        params.set('dateTo', range.dateTo);
      }
      return apiRequest(
        `/conversations/leads/${leadId}/${channel}/company/messages?${params.toString()}`,
      );
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: open && hasServerHistorySearch,
    staleTime: 5_000,
  });
  const quickRepliesQuery = useQuery({
    queryKey: [`omnicus-${projectId}-${identityId}-conversation-quick-replies`],
    queryFn: () => apiRequest('/conversations/quick-replies'),
    enabled: open,
  });
  const notesQuery = useQuery({
    queryKey: [`omnicus-${projectId}-${identityId}-conversation-internal-notes`, leadId, channel],
    queryFn: () => apiRequest(`/conversations/leads/${leadId}/${channel}/company/notes`),
    enabled: open,
  });
  const workspaceQuery = useQuery({
    queryKey: [`omnicus-${projectId}-${identityId}-conversation-workspace`, leadId, channel],
    queryFn: () => apiRequest(`/conversations/leads/${leadId}/${channel}/company/workspace`),
    enabled: open,
  });
  const savedDraftQuery = useQuery({
    queryKey: [`omnicus-${projectId}-${identityId}-conversation-draft`, leadId, channel],
    queryFn: () => apiRequest(`/conversations/leads/${leadId}/${channel}/company/draft`),
    enabled: open,
    refetchOnWindowFocus: false,
  });
  const usersDirectoryQuery = useQuery({
    queryKey: [`omnicus-${projectId}-${identityId}-users-directory`],
    queryFn: () => apiRequest('/users/directory'),
    enabled: open,
    staleTime: 60_000,
  });
  const capabilitiesQuery = useQuery({
    queryKey: [`omnicus-${projectId}-${identityId}-channel-capabilities`, leadId, channel],
    queryFn: () => apiRequest(`/conversations/leads/${leadId}/${channel}/company/capabilities`),
    enabled: Boolean(open && conversationQuery.data?.conversation?.omnicusConnectionId),
    staleTime: 30_000,
    retry: false,
  });
  const whatsAppTemplatesQuery = useQuery({
    queryKey: [`omnicus-${projectId}-${identityId}-whatsapp-message-templates`, leadId, channel],
    queryFn: () => apiRequest(`/conversations/leads/${leadId}/whatsapp/company/message-templates`),
    enabled: Boolean(
      open &&
      channel === 'whatsapp' &&
      conversationQuery.data?.conversation?.omnicusConnectionId &&
      capabilitiesQuery.data?.capabilities.messageTemplates?.supported,
    ),
    staleTime: 30_000,
    retry: false,
  });
  const removeSavedDraft = useCallback(async () => {
    await apiRequest(`/conversations/leads/${leadId}/${channel}/company/draft`, {
      method: 'DELETE',
    });
    queryClient.setQueryData(
      [`omnicus-${projectId}-${identityId}-conversation-draft`, leadId, channel],
      null,
    );
    setDraftStorageStatus('idle');
  }, [channel, leadId, queryClient]);
  const providerMutation = useMutation({
    mutationFn: (input) =>
      apiRequest(input.path, {
        method: input.method,
        body: JSON.stringify(input.body),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [`omnicus-${projectId}-${identityId}-lead-company-conversation`, leadId, channel],
      });
    },
    onError: (error) => {
      void message.error(
        getFriendlyErrorMessage(
          error,
          `Unable to queue the ${channel === 'whatsapp' ? 'WhatsApp' : 'Telegram'} action.`,
        ),
      );
    },
  });
  const automationStateQuery = useQuery({
    queryKey: [`omnicus-${projectId}-${identityId}-telegram-automation-state`, leadId, channel],
    queryFn: () => apiRequest(`/conversations/leads/${leadId}/${channel}/company/automation-state`),
    enabled: open && isTelegramCapabilitySupported(capabilitiesQuery.data, 'automationManualMode'),
    retry: false,
  });
  const automationMutation = useMutation({
    mutationFn: (input) => {
      const expectedRevision = automationStateQuery.data?.revision ?? 0;
      const signature = JSON.stringify({ ...input, expectedRevision });
      if (automationRequestRef.current?.signature !== signature) {
        automationRequestRef.current = {
          signature,
          clientRequestId: crypto.randomUUID(),
        };
      }
      return apiRequest(`/conversations/leads/${leadId}/${channel}/company/automation-state`, {
        method: 'PUT',
        body: JSON.stringify({
          mode: input.mode,
          resumeAt: input.resumeAt,
          expectedRevision,
          clientRequestId: automationRequestRef.current.clientRequestId,
          reasonCode: 'CRM_USER_CHANGED_MODE',
        }),
      });
    },
    onSuccess: async () => {
      automationRequestRef.current = null;
      await queryClient.invalidateQueries({
        queryKey: [`omnicus-${projectId}-${identityId}-telegram-automation-state`, leadId, channel],
      });
    },
    onError: (error) => {
      void message.error(getFriendlyErrorMessage(error, 'Unable to change automation mode.'));
    },
  });
  const botInterfaceQuery = useQuery({
    queryKey: [`omnicus-${projectId}-${identityId}-telegram-bot-interface`, leadId, channel],
    queryFn: () => apiRequest(`/conversations/leads/${leadId}/${channel}/company/bot-interface`),
    enabled: open && isTelegramCapabilitySupported(capabilitiesQuery.data, 'botInterface'),
    retry: false,
  });
  const botInterfaceMutation = useMutation({
    mutationFn: () => {
      const commands = botCommandsDraft
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf(' - ');
          return {
            command: (separator >= 0 ? line.slice(0, separator) : line).trim().replace(/^\//, ''),
            description: (separator >= 0 ? line.slice(separator + 3) : 'Command').trim(),
          };
        });
      return apiRequest(`/conversations/leads/${leadId}/${channel}/company/bot-interface`, {
        method: 'PUT',
        body: JSON.stringify({
          clientRequestId:
            botInterfaceClientRequestIdRef.current ??
            (botInterfaceClientRequestIdRef.current = crypto.randomUUID()),
          expectedRevision: botInterfaceQuery.data?.revision ?? 0,
          commands,
          scope: { type: 'default' },
          menuButton: { type: botMenuType },
        }),
      });
    },
    onSuccess: async () => {
      botInterfaceClientRequestIdRef.current = null;
      setIsBotInterfaceOpen(false);
      await queryClient.invalidateQueries({
        queryKey: [`omnicus-${projectId}-${identityId}-telegram-bot-interface`, leadId, channel],
      });
      void message.success('Bot interface update queued');
    },
    onError: (error) =>
      void message.error(getFriendlyErrorMessage(error, 'Unable to update the bot interface.')),
  });
  const sendMutation = useMutation({
    mutationFn: ({
      text,
      clientRequestId,
      replyToMessageId,
      inlineKeyboard,
      replyMarkup: selectedReplyMarkup,
      richMessage,
      entities,
      protectContent: shouldProtectContent,
      messageEffectId: selectedMessageEffectId,
      quote,
      quotePosition,
      linkPreviewOptions: selectedLinkPreviewOptions,
      disableNotification: shouldDisableNotification,
      structured,
      interactive,
      template,
    }) =>
      apiRequest(`/conversations/leads/${leadId}/${channel}/company/messages`, {
        method: 'POST',
        body: JSON.stringify({
          text,
          clientRequestId,
          replyToMessageId,
          inlineKeyboard,
          replyMarkup: selectedReplyMarkup,
          richMessage,
          entities,
          protectContent: shouldProtectContent,
          messageEffectId: selectedMessageEffectId,
          quote,
          quotePosition,
          linkPreviewOptions: selectedLinkPreviewOptions,
          disableNotification: shouldDisableNotification,
          structured,
          interactive,
          template,
        }),
      }),
  });
  const attachmentMutation = useMutation({
    mutationFn: (input) => {
      const formData = new FormData();
      formData.append('file', input.file);
      formData.append('kind', input.kind);
      formData.append('clientRequestId', input.clientRequestId);
      if (input.caption) formData.append('caption', input.caption);
      if (input.replyToMessageId) {
        formData.append('replyToMessageId', input.replyToMessageId);
      }
      if (input.hasSpoiler) formData.append('hasSpoiler', 'true');
      if (input.disableNotification) {
        formData.append('disableNotification', 'true');
      }
      if (input.durationSeconds !== undefined) {
        formData.append('durationSeconds', String(input.durationSeconds));
      }
      return apiRequest(`/conversations/leads/${leadId}/${channel}/company/attachments`, {
        method: 'POST',
        body: formData,
      });
    },
  });
  const noteMutation = useMutation({
    mutationFn: (input) =>
      apiRequest(`/conversations/leads/${leadId}/${channel}/company/notes`, {
        method: 'POST',
        body: JSON.stringify({
          text: input.text,
          mentionedUserIds: input.mentionedUserIds,
          replyToMessageId: replyTarget?.omnicusMessageId,
        }),
      }),
    onSuccess: async () => {
      shouldStickToBottomRef.current = true;
      setDraft('');
      setMentionedUserIds([]);
      setReplyTarget(null);
      pendingClientRequestIdRef.current = null;
      await removeSavedDraft().catch(() => undefined);
      await queryClient.invalidateQueries({
        queryKey: [
          `omnicus-${projectId}-${identityId}-conversation-internal-notes`,
          leadId,
          channel,
        ],
      });
      void message.success('Internal note added');
    },
    onError: (error) => {
      void message.error(getFriendlyErrorMessage(error, 'Unable to add the internal note.'));
    },
  });
  const updateNoteMutation = useMutation({
    mutationFn: (input) =>
      apiRequest(`/conversations/leads/${leadId}/${channel}/company/notes/${input.noteId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          text: input.text,
          mentionedUserIds: input.mentionedUserIds,
        }),
      }),
    onSuccess: async () => {
      setEditingNote(null);
      setEditingNoteText('');
      setEditingNoteMentionedUserIds([]);
      await queryClient.invalidateQueries({
        queryKey: [
          `omnicus-${projectId}-${identityId}-conversation-internal-notes`,
          leadId,
          channel,
        ],
      });
      void message.success('Internal note updated');
    },
    onError: (error) => {
      void message.error(getFriendlyErrorMessage(error, 'Unable to update the internal note.'));
    },
  });
  const deleteNoteMutation = useMutation({
    mutationFn: (noteId) =>
      apiRequest(`/conversations/leads/${leadId}/${channel}/company/notes/${noteId}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [
          `omnicus-${projectId}-${identityId}-conversation-internal-notes`,
          leadId,
          channel,
        ],
      });
      void message.success('Internal note deleted');
    },
    onError: (error) => {
      void message.error(getFriendlyErrorMessage(error, 'Unable to delete the internal note.'));
    },
  });
  const createTemplateMutation = useMutation({
    mutationFn: (input) =>
      apiRequest('/conversations/quick-replies', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: async () => {
      setIsTemplateEditorOpen(false);
      setEditingTemplateId(null);
      setTemplateDraft({ title: '', content: '', scope: 'PERSONAL' });
      await queryClient.invalidateQueries({
        queryKey: [`omnicus-${projectId}-${identityId}-conversation-quick-replies`],
      });
      void message.success('Quick reply saved');
    },
    onError: (error) => {
      void message.error(getFriendlyErrorMessage(error, 'Unable to save the quick reply.'));
    },
  });
  const updateTemplateMutation = useMutation({
    mutationFn: (input) =>
      apiRequest(`/conversations/quick-replies/${editingTemplateId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: async () => {
      setIsTemplateEditorOpen(false);
      setEditingTemplateId(null);
      setTemplateDraft({ title: '', content: '', scope: 'PERSONAL' });
      await queryClient.invalidateQueries({
        queryKey: [`omnicus-${projectId}-${identityId}-conversation-quick-replies`],
      });
      void message.success('Quick reply updated');
    },
    onError: (error) => {
      void message.error(getFriendlyErrorMessage(error, 'Unable to update the quick reply.'));
    },
  });
  const deleteTemplateMutation = useMutation({
    mutationFn: (templateId) =>
      apiRequest(`/conversations/quick-replies/${templateId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [`omnicus-${projectId}-${identityId}-conversation-quick-replies`],
      });
      void message.success('Quick reply deleted');
    },
    onError: (error) => {
      void message.error(getFriendlyErrorMessage(error, 'Unable to delete the quick reply.'));
    },
  });
  const favoriteTemplateMutation = useMutation({
    mutationFn: (input) =>
      apiRequest(`/conversations/quick-replies/${input.templateId}/favorite`, {
        method: 'PUT',
        body: JSON.stringify({ favorite: input.favorite }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [`omnicus-${projectId}-${identityId}-conversation-quick-replies`],
      });
    },
    onError: (error) => {
      void message.error(getFriendlyErrorMessage(error, 'Favorite status could not be changed.'));
    },
  });
  const expertMediaMutation = useMutation({
    mutationFn: (files) => {
      const items = files.map((file) => {
        const existing = expertMediaRequestIdsRef.current.get(file._id);
        const clientRequestId = existing ?? crypto.randomUUID();
        expertMediaRequestIdsRef.current.set(file._id, clientRequestId);
        return { mediaId: file._id, clientRequestId };
      });
      return apiRequest(`/conversations/leads/${leadId}/${channel}/company/expert-media`, {
        method: 'POST',
        body: JSON.stringify({
          items,
          ...(channel === 'telegram' ? { disableNotification } : {}),
        }),
      });
    },
    onSuccess: async ({ results }) => {
      const accepted = results.filter((item) => item.status !== 'failed');
      const failed = results.filter((item) => item.status === 'failed');
      for (const item of accepted) {
        expertMediaRequestIdsRef.current.delete(item.mediaId);
      }
      shouldStickToBottomRef.current = true;
      onPendingExpertMediaClear?.(accepted.map((item) => item.mediaId));
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: [
            `omnicus-${projectId}-${identityId}-lead-company-conversation`,
            leadId,
            channel,
          ],
        }),
        queryClient.invalidateQueries({ queryKey: ['lead', leadId] }),
        queryClient.invalidateQueries({ queryKey: ['kanban-board'] }),
      ]);
      if (accepted.length) {
        setDisableNotification(false);
        void message.success(
          `Queued ${accepted.length} inspection file${accepted.length === 1 ? '' : 's'}`,
        );
      }
      if (failed.length) {
        void message.error(
          failed.length === 1
            ? (failed[0].errorMessage ?? 'The inspection file could not be sent.')
            : `${failed.length} inspection files failed and remain selected for retry.`,
        );
      }
    },
    onError: (error) => {
      void message.error(getFriendlyErrorMessage(error, 'Unable to send inspection media.'));
    },
  });
  const participantLabel = useMemo(() => {
    const participant = conversationQuery.data?.conversation?.participant;
    if (!participant) {
      return clientName;
    }
    const name = [participant.firstName, participant.lastName].filter(Boolean).join(' ');
    return name || (participant.username ? `@${participant.username}` : clientName);
  }, [clientName, conversationQuery.data?.conversation?.participant]);
  const conversation = conversationQuery.data?.conversation;
  const currentHistoryScope = `${leadId}:${channel}`;
  const baseMessages = useMemo(
    () => conversationQuery.data?.messages ?? [],
    [conversationQuery.data?.messages],
  );
  const scopedOlderMessages = useMemo(
    () => (olderHistoryScope === currentHistoryScope ? olderMessages : []),
    [currentHistoryScope, olderHistoryScope, olderMessages],
  );
  const messages = useMemo(
    () => mergeConversationMessages(scopedOlderMessages, baseMessages),
    [baseMessages, scopedOlderMessages],
  );
  const clearPendingExpertMedia = useCallback(() => {
    for (const file of pendingExpertMediaFiles) {
      expertMediaRequestIdsRef.current.delete(file._id);
    }
    onPendingExpertMediaClear?.();
  }, [onPendingExpertMediaClear, pendingExpertMediaFiles]);
  const searchedMessages = useMemo(
    () =>
      mergeConversationMessages(
        ...(searchedHistoryQuery.data?.pages.map((page) => page.messages) ?? []),
      ),
    [searchedHistoryQuery.data?.pages],
  );
  const providerOperations = useMemo(
    () => conversationQuery.data?.operations ?? [],
    [conversationQuery.data?.operations],
  );
  const readReceiptOperationsByMessageId = useMemo(() => {
    const operations = new Map();
    for (const operation of providerOperations) {
      if (operation.action !== 'MARK_READ') continue;
      const previous = operations.get(operation.omnicusMessageId);
      const previousAt = previous?.createdAt ? Date.parse(previous.createdAt) : 0;
      const nextAt = operation.createdAt ? Date.parse(operation.createdAt) : 0;
      if (!previous || nextAt >= previousAt) {
        operations.set(operation.omnicusMessageId, operation);
      }
    }
    return operations;
  }, [providerOperations]);
  useEffect(() => {
    if (!open) {
      deliveryNotificationStateRef.current = null;
      return;
    }
    if (!conversationQuery.isSuccess) return;
    const key = `${leadId}:${channel}`;
    const previous = deliveryNotificationStateRef.current;
    if (!previous || previous.key !== key) {
      deliveryNotificationStateRef.current = {
        key,
        messages: new Map(baseMessages.map((item) => [item._id, item.status])),
        operations: new Map(
          providerOperations.map((operation) => [operation._id, operation.status]),
        ),
      };
      return;
    }
    for (const item of baseMessages) {
      const priorStatus = previous.messages.get(item._id);
      if (item.direction === 'outbound' && priorStatus !== item.status) {
        if (item.status === 'failed') {
          void message.error(
            item.outboundErrorMessage ??
              `${channel === 'whatsapp' ? 'WhatsApp' : 'Telegram'} could not deliver the message. Open it for safe retry details.`,
          );
        } else if (item.status === 'unknown') {
          void message.warning(
            `${channel === 'whatsapp' ? 'WhatsApp' : 'Telegram'} delivery is still unknown. Reconciliation will continue; do not resend it.`,
          );
        }
      }
      previous.messages.set(item._id, item.status);
    }
    for (const operation of providerOperations) {
      const priorStatus = previous.operations.get(operation._id);
      if (priorStatus !== operation.status) {
        if (operation.action === 'MARK_READ') {
          continue;
        }
        if (operation.status === 'failed') {
          void message.error(
            operation.errorMessage ??
              `The ${channel === 'whatsapp' ? 'WhatsApp' : 'Telegram'} message action failed. Open the message for safe retry details.`,
          );
        } else if (operation.status === 'unknown') {
          void message.warning(
            `The ${channel === 'whatsapp' ? 'WhatsApp' : 'Telegram'} action has an unknown result and will not be retried automatically.`,
          );
        }
      }
      previous.operations.set(operation._id, operation.status);
    }
  }, [
    baseMessages,
    channel,
    conversationQuery.isSuccess,
    leadId,
    message,
    open,
    providerOperations,
  ]);
  useEffect(() => {
    if (!activeMessageActionsId) return;
    const closeActions = (event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest(`[data-message-id="${activeMessageActionsId}"]`) ||
          target.closest('.ant-popover'))
      ) {
        return;
      }
      setActiveMessageActionsId(null);
    };
    document.addEventListener('pointerdown', closeActions);
    return () => document.removeEventListener('pointerdown', closeActions);
  }, [activeMessageActionsId]);
  const supports = useCallback(
    (name) => canSend && isTelegramCapabilitySupported(capabilitiesQuery.data, name),
    [canSend, capabilitiesQuery.data],
  );
  useEffect(() => {
    if (!open) return;
    whatsAppReadNotificationKeysRef.current.clear();
    whatsAppReadCompletedRef.current.clear();
    whatsAppReadAttemptsRef.current.clear();
    whatsAppReadInFlightRef.current.clear();
  }, [open]);
  useEffect(() => {
    if (!open || channel !== 'whatsapp' || !supports('markMessageRead')) {
      return;
    }
    const isReadMarkableMessage = (item) =>
      item.direction === 'inbound' &&
      Boolean(item.omnicusMessageId?.trim()) &&
      Boolean(item.providerMessageId?.trim()) &&
      !item.interactive?.type &&
      !item.deletedAt &&
      item.status !== 'read' &&
      !['SYSTEM', 'AUTOMATION', 'BROADCAST'].includes(item.source ?? '');
    const isPermanentReadReceiptError = (errorCode) => errorCode === 'MESSAGE_NOT_MARKABLE_AS_READ';
    const showReadReceiptToast = (toastKey, content, level = 'error') => {
      if (whatsAppReadNotificationKeysRef.current.has(toastKey)) return;
      if (level === 'warning') {
        message.warning({ key: toastKey, content });
      } else {
        message.error({ key: toastKey, content });
      }
      whatsAppReadNotificationKeysRef.current.add(toastKey);
    };
    const buildReadReceiptToastKey = (operation) =>
      `${operation.providerOperationId ?? operation._id}:${operation.status}:${operation.errorCode ?? 'NO_ERROR'}`;
    const showReadReceiptError = (messageId, operation) => {
      const toastKey = buildReadReceiptToastKey(operation);
      if (isPermanentReadReceiptError(operation.errorCode)) {
        showReadReceiptToast(
          toastKey,
          'WhatsApp could not mark this message as read. Only an inbound WhatsApp message can be marked as read.',
        );
      } else {
        showReadReceiptToast(
          toastKey,
          'WhatsApp could not receive the read receipt. CRM will retry automatically.',
          'warning',
        );
      }
      whatsAppReadCompletedRef.current.add(messageId);
      whatsAppReadAttemptsRef.current.delete(messageId);
    };
    const showUnknownReadReceiptResult = (operation) => {
      const toastKey = `unknown:${buildReadReceiptToastKey(operation)}`;
      showReadReceiptToast(
        toastKey,
        'The WhatsApp read receipt has an unknown result and will be reconciled without blind retry.',
        'warning',
      );
    };
    for (const [messageId, operation] of readReceiptOperationsByMessageId) {
      if (!operation.status) {
        continue;
      }
      if (
        operation.status === 'unknown' ||
        operation.status === 'failed' ||
        operation.status === 'succeeded' ||
        operation.status === 'queued' ||
        operation.status === 'processing'
      ) {
        if (operation.status === 'unknown') {
          showUnknownReadReceiptResult(operation);
        } else if (operation.status === 'failed') {
          showReadReceiptError(messageId, operation);
        }
        whatsAppReadCompletedRef.current.add(messageId);
        whatsAppReadAttemptsRef.current.delete(messageId);
      }
    }
    const pending = messages.filter(
      (item) =>
        isReadMarkableMessage(item) &&
        item.omnicusMessageId &&
        !whatsAppReadCompletedRef.current.has(item.omnicusMessageId) &&
        !readReceiptOperationsByMessageId.has(item.omnicusMessageId) &&
        !whatsAppReadInFlightRef.current.has(item.omnicusMessageId) &&
        (whatsAppReadAttemptsRef.current.get(item.omnicusMessageId) ?? 0) < 3,
    );
    if (!pending.length) return;
    const readInFlight = whatsAppReadInFlightRef.current;
    let cancelled = false;
    let retryTimer = null;
    let releaseRetryDelay = null;
    const waitForRetry = (milliseconds) =>
      new Promise((resolve) => {
        releaseRetryDelay = resolve;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          releaseRetryDelay = null;
          resolve();
        }, milliseconds);
      });
    for (const item of pending) {
      if (item.omnicusMessageId) {
        readInFlight.add(item.omnicusMessageId);
      }
    }
    void (async () => {
      for (const item of pending) {
        if (cancelled || !item.omnicusMessageId) return;
        const messageId = item.omnicusMessageId;
        while (
          !cancelled &&
          !whatsAppReadCompletedRef.current.has(messageId) &&
          (whatsAppReadAttemptsRef.current.get(messageId) ?? 0) < 3
        ) {
          try {
            const operation = await apiRequest(
              `/conversations/leads/${leadId}/whatsapp/company/messages/${messageId}/read`,
              {
                method: 'PUT',
                body: JSON.stringify({ clientRequestId: messageId }),
              },
            );
            whatsAppReadCompletedRef.current.add(messageId);
            whatsAppReadAttemptsRef.current.delete(messageId);
            if (operation.status === 'unknown') {
              showUnknownReadReceiptResult(operation);
            } else if (operation.status === 'failed') {
              showReadReceiptError(messageId, operation);
              break;
            }
          } catch (error) {
            const attempts = (whatsAppReadAttemptsRef.current.get(messageId) ?? 0) + 1;
            whatsAppReadAttemptsRef.current.set(messageId, attempts);
            const errorCode = error instanceof ApiError ? error.code : undefined;
            const errorToastKey = `request:${messageId}:${errorCode ?? 'UNKNOWN'}`;
            if (attempts === 1) {
              showReadReceiptToast(
                errorToastKey,
                isPermanentReadReceiptError(errorCode)
                  ? 'WhatsApp could not mark this message as read. Only an inbound WhatsApp message can be marked as read.'
                  : 'WhatsApp could not receive the read receipt. CRM will retry automatically.',
                isPermanentReadReceiptError(errorCode) ? 'error' : 'warning',
              );
            }
            if (isPermanentReadReceiptError(errorCode) || attempts >= 3) {
              whatsAppReadCompletedRef.current.add(messageId);
              whatsAppReadAttemptsRef.current.delete(messageId);
              break;
            }
            if (attempts < 3 && !cancelled) {
              await waitForRetry(750 * 2 ** (attempts - 1));
            }
          }
        }
        readInFlight.delete(messageId);
      }
    })();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      releaseRetryDelay?.();
      for (const item of pending) {
        if (item.omnicusMessageId) {
          readInFlight.delete(item.omnicusMessageId);
        }
      }
    };
  }, [channel, leadId, message, messages, open, readReceiptOperationsByMessageId, supports]);
  const visibleMessages = useMemo(
    () =>
      hasServerHistorySearch
        ? searchedMessages
        : filterConversationMessages(
            messages,
            searchQuery,
            historyFilter,
            historyDate || undefined,
          ),
    [hasServerHistorySearch, historyDate, historyFilter, messages, searchQuery, searchedMessages],
  );
  const internalNotes = useMemo(() => notesQuery.data ?? [], [notesQuery.data]);
  const visibleInternalNotes = useMemo(
    () =>
      internalNotes.filter((note) =>
        noteMatchesHistorySearch(note, searchQuery, historyFilter, historyDate || undefined),
      ),
    [historyDate, historyFilter, internalNotes, searchQuery],
  );
  const timeline = useMemo(
    () => buildConversationTimeline(visibleMessages, undefined, visibleInternalNotes),
    [visibleInternalNotes, visibleMessages],
  );
  const searchResults = useMemo(() => timeline.filter((entry) => entry.type !== 'day'), [timeline]);
  const availableMessageEffects = useMemo(
    () => parseTelegramMessageEffects(capabilitiesQuery.data),
    [capabilitiesQuery.data],
  );
  const selectedMessageEffect = useMemo(
    () => availableMessageEffects.find((effect) => effect.id === messageEffectId),
    [availableMessageEffects, messageEffectId],
  );
  const draftPreviewUrl = linkPreviewOptions.url ?? draft.match(/https?:\/\/[^\s<>()]+/i)?.[0];
  const isLinkPreviewEnabled = linkPreviewOptions.isDisabled !== true;
  const hasAdvancedLinkPreviewOptions = Boolean(
    linkPreviewOptions.url?.trim() ||
    linkPreviewOptions.preferLargeMedia ||
    linkPreviewOptions.preferSmallMedia,
  );
  const hasRenderableLinkPreview = Boolean(isLinkPreviewEnabled && draftPreviewUrl);
  const linkPreviewSizeClass = linkPreviewOptions.preferLargeMedia
    ? 'is-large'
    : linkPreviewOptions.preferSmallMedia
      ? 'is-small'
      : 'is-default';
  const mediaMessages = useMemo(
    () =>
      messages.filter((item) =>
        ['PHOTO', 'VIDEO', 'VIDEO_NOTE', 'ANIMATION', 'STICKER'].includes(
          item.attachment?.kind ?? '',
        ),
      ),
    [messages],
  );
  const fileMessages = useMemo(
    () =>
      messages.filter(
        (item) =>
          item.attachment &&
          !['PHOTO', 'VIDEO', 'VIDEO_NOTE', 'ANIMATION', 'STICKER'].includes(
            item.attachment.kind ?? '',
          ),
      ),
    [messages],
  );
  const conversationLinks = useMemo(() => extractConversationLinks(messages), [messages]);
  const automationMessages = useMemo(
    () => messages.filter((item) => item.source === 'AUTOMATION'),
    [messages],
  );
  const quickReplies = useMemo(() => {
    const normalized = quickReplySearch.trim().toLocaleLowerCase();
    const templates = quickRepliesQuery.data ?? [];
    if (!normalized) return templates;
    return templates.filter((template) =>
      `${template.title} ${template.content}`.toLocaleLowerCase().includes(normalized),
    );
  }, [quickRepliesQuery.data, quickReplySearch]);
  const whatsAppTemplates = whatsAppTemplatesQuery.data?.data ?? [];
  const selectedWhatsAppTemplate = whatsAppTemplates.find(
    (template) => template.id === selectedWhatsAppTemplateId,
  );
  const selectedWhatsAppTemplateFields = useMemo(
    () => whatsAppTemplateFields(selectedWhatsAppTemplate),
    [selectedWhatsAppTemplate],
  );
  const selectedWhatsAppTemplateUnsupportedReason = selectedWhatsAppTemplate
    ? whatsAppTemplateUnsupportedReason(selectedWhatsAppTemplate)
    : null;
  const selectedWhatsAppTemplateMediaHeader = selectedWhatsAppTemplate?.components
    .map((component, componentIndex) => ({ component, componentIndex }))
    .find(
      ({ component }) =>
        component.type === 'HEADER' &&
        ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(component.format ?? ''),
    );
  const selectedWhatsAppTemplateNeedsMedia = Boolean(selectedWhatsAppTemplateMediaHeader);
  const isOmnicusConversation = conversation?.transport === 'omnicus';
  const isConnected = Boolean(conversation?.externalChatId || conversation?.externalContactId);
  const isTelegramConversationDisconnected = channel === 'telegram' && !isConnected;
  const channelOutboundAvailable = Boolean(
    canSend &&
    isConnected &&
    isOmnicusConversation &&
    conversation?.crmProjectId &&
    conversation?.omnicusProjectId &&
    conversation?.omnicusContactId &&
    conversation?.omnicusChannelIdentityId &&
    conversation?.omnicusConnectionId,
  );
  const whatsAppServiceWindow = capabilitiesQuery.data?.serviceWindow;
  const whatsAppFreeformAvailable =
    channel !== 'whatsapp' || whatsAppServiceWindow?.state === 'OPEN';
  const whatsAppScheduleExpiresAt =
    channel === 'whatsapp' ? whatsAppServiceWindow?.expiresAt : undefined;
  const isWhatsAppScheduleTimeOutsideWindow = Boolean(
    whatsAppScheduleExpiresAt &&
    scheduledAt &&
    new Date(scheduledAt).getTime() >= new Date(whatsAppScheduleExpiresAt).getTime(),
  );
  const textOutboundAvailable = Boolean(channelOutboundAvailable && whatsAppFreeformAvailable);
  const mediaOutboundAvailable = textOutboundAvailable;
  const expertMediaOutboundAvailable = textOutboundAvailable;
  const hasFrozenCaptionFailure = pendingAttachments.some(
    (item) => item.status === 'failed' && Boolean(item.operation?.caption),
  );
  const channelLabel = channel === 'telegram' ? 'Telegram' : 'WhatsApp';
  const lastTimelineKey = timeline.at(-1)?.key;
  const hasPendingExpertMedia = pendingExpertMediaFiles.length > 0;
  const pendingExpertMediaSummary = useMemo(() => {
    const visibleNames = pendingExpertMediaFiles.slice(0, 3).map((file) => file.fileName);
    const hiddenCount = pendingExpertMediaFiles.length - visibleNames.length;
    return [visibleNames.join(', '), hiddenCount > 0 ? `+${hiddenCount} more` : '']
      .filter(Boolean)
      .join(' ');
  }, [pendingExpertMediaFiles]);
  const emitChatAction = useCallback(
    async (action) => {
      if (!supports('chatActions')) return;
      try {
        await apiRequest(`/conversations/leads/${leadId}/${channel}/company/chat-actions`, {
          method: 'POST',
          body: JSON.stringify({ action }),
        });
      } catch {
        // Ephemeral indicators are best effort and never affect message send.
      }
    },
    [channel, leadId, supports],
  );
  useEffect(() => {
    if (!open && wasOpenRef.current) {
      draftCloseRef.current();
      for (const url of attachmentObjectUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      attachmentObjectUrlsRef.current.clear();
      setPendingAttachments([]);
      resetVoiceRecorder();
    }
    if (open && !wasOpenRef.current) {
      setChannel(initialChannel ?? 'telegram');
      setDraft('');
      setDraftEntities([]);
      setProtectContent(false);
      setMessageEffectId('');
      setQuoteText('');
      setLinkPreviewOptions({});
      setHasSpoiler(false);
      setRevealedSpoilers(new Set());
      setEditingMessage(null);
      pendingClientRequestIdRef.current = null;
      for (const url of attachmentObjectUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      attachmentObjectUrlsRef.current.clear();
      setPendingAttachments([]);
      setReplyTarget(null);
      setKeyboardButtons([]);
      setIsKeyboardEditorOpen(false);
      setIsDetailsOpen(false);
      setIsSearchOpen(false);
      setSearchQuery('');
      setHistoryFilter('all');
      setHistoryDate('');
      setSearchResultIndex(0);
      setHighlightedMessageId(null);
      setIsQuickRepliesOpen(false);
      setQuickReplySearch('');
      setComposerMode('message');
      setDraftStorageStatus('idle');
      setMentionedUserIds([]);
      setEditingNote(null);
      setEditingNoteText('');
      setEditingNoteMentionedUserIds([]);
      setActiveMessageActionsId(null);
      setIsTemplateEditorOpen(false);
      setIsWhatsAppTemplateOpen(false);
      setSelectedWhatsAppTemplateId('');
      setWhatsAppTemplateValues({});
      setWhatsAppTemplateMedia(null);
      setIsWhatsAppInteractiveOpen(false);
      setEditingTemplateId(null);
      setTemplateDraft({ title: '', content: '', scope: 'PERSONAL' });
      hydratedDraftKeyRef.current = null;
      resetVoiceRecorder();
      whatsAppReadCompletedRef.current.clear();
      whatsAppReadInFlightRef.current.clear();
      whatsAppReadAttemptsRef.current.clear();
    }
    wasOpenRef.current = open;
  }, [initialChannel, open, resetVoiceRecorder]);
  useEffect(() => {
    if (!open || !canSend || savedDraftQuery.isLoading) return;
    const key = `${leadId}:${channel}`;
    if (hydratedDraftKeyRef.current === key) return;
    hydratedDraftKeyRef.current = key;
    const saved = savedDraftQuery.data;
    if (!saved) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setComposerMode(saved.composerMode);
      setDraft(saved.text ?? '');
      setDraftStorageStatus('saved');
      setMentionedUserIds(saved.mentionedUserIds ?? []);
      setDraftEntities(saved.entities ?? []);
      setProtectContent(Boolean(saved.protectContent));
      setDisableNotification(Boolean(saved.disableNotification));
      setMessageEffectId(saved.messageEffectId ?? '');
      setQuoteText(saved.quote ?? '');
      setLinkPreviewOptions(saved.linkPreviewOptions ?? {});
      setReplyMarkup(saved.replyMarkup);
      setKeyboardButtons(
        (saved.inlineKeyboard ?? []).flatMap((row) =>
          row.map((button) => ({
            id: crypto.randomUUID(),
            text: button.text,
            action: button.callbackData ? 'callback' : 'url',
            value: button.callbackData ?? button.url ?? '',
          })),
        ),
      );
      setReplyTarget(
        messages.find((item) => item.omnicusMessageId === saved.replyToMessageId) ?? null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [channel, leadId, messages, open, savedDraftQuery.data, savedDraftQuery.isLoading]);
  useEffect(() => {
    if (!open || !canSend || savedDraftQuery.isLoading) return;
    const key = `${leadId}:${channel}`;
    if (hydratedDraftKeyRef.current !== key) return;
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      setDraftStorageStatus('saving');
      const hasDraft = Boolean(
        replyMarkup ||
        draft.trim() ||
        draftEntities.length ||
        keyboardButtons.length ||
        replyTarget ||
        quoteText.trim() ||
        protectContent ||
        disableNotification ||
        messageEffectId.trim() ||
        Object.keys(linkPreviewOptions).length ||
        composerMode === 'note',
      );
      const path = `/conversations/leads/${leadId}/${channel}/company/draft`;
      const request = hasDraft
        ? apiRequest(path, {
            method: 'PUT',
            body: JSON.stringify({
              composerMode,
              text: draft,
              mentionedUserIds,
              entities: draftEntities,
              inlineKeyboard: buildInlineKeyboard(keyboardButtons) ?? [],
              replyMarkup,
              linkPreviewOptions,
              quote: quoteText || undefined,
              replyToMessageId: replyTarget?.omnicusMessageId,
              protectContent,
              disableNotification,
              messageEffectId: messageEffectId || undefined,
            }),
          })
        : apiRequest(path, { method: 'DELETE' });
      void request
        .then((value) => {
          queryClient.setQueryData(
            [`omnicus-${projectId}-${identityId}-conversation-draft`, leadId, channel],
            hasDraft ? value : null,
          );
          setDraftStorageStatus(hasDraft ? 'saved' : 'idle');
        })
        .catch(() => setDraftStorageStatus('failed'));
    }, 700);
    return () => {
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    };
  }, [
    channel,
    composerMode,
    draft,
    draftEntities,
    disableNotification,
    keyboardButtons,
    leadId,
    linkPreviewOptions,
    messageEffectId,
    mentionedUserIds,
    open,
    protectContent,
    queryClient,
    quoteText,
    replyTarget,
    replyMarkup,
    savedDraftQuery.isLoading,
  ]);
  useEffect(
    () => () => {
      draftCloseRef.current();
      for (const url of attachmentObjectUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      attachmentObjectUrlsRef.current.clear();
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      discardVoiceRecordingRef.current = true;
      const recorder = voiceRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      stopVoiceResources();
      if (voiceDraftUrlRef.current) {
        URL.revokeObjectURL(voiceDraftUrlRef.current);
        voiceDraftUrlRef.current = null;
      }
    },
    [stopVoiceResources],
  );
  useEffect(() => {
    shouldStickToBottomRef.current = true;
  }, [channel, open]);
  useEffect(() => {
    if (
      !open ||
      !initialNoteId ||
      openedInitialNoteRef.current === initialNoteId ||
      !internalNotes.some((note) => note._id === initialNoteId)
    ) {
      return;
    }
    openedInitialNoteRef.current = initialNoteId;
    requestAnimationFrame(() => {
      scrollChatItem(document.getElementById(`chat-note-${initialNoteId}`));
      setHighlightedMessageId(initialNoteId);
    });
  }, [initialNoteId, internalNotes, open]);
  useEffect(() => {
    if (!open) {
      clearedUnreadKeyRef.current = null;
      return;
    }
    const unreadKey = `${leadId}:${channel}`;
    if (conversationQuery.isSuccess && conversation && clearedUnreadKeyRef.current !== unreadKey) {
      clearedUnreadKeyRef.current = unreadKey;
      void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      void queryClient.invalidateQueries({ queryKey: ['kanban-board'] });
    }
  }, [channel, conversation, conversationQuery.isSuccess, leadId, open, queryClient]);
  useEffect(() => {
    const messageList = messageListRef.current;
    if (messageList && shouldStickToBottomRef.current) {
      messageList.scrollTop = messageList.scrollHeight;
    }
  }, [lastTimelineKey, open]);
  useEffect(() => {
    if (!open || composerMode !== 'message' || !draft || !supports('chatActions')) {
      return;
    }
    const now = Date.now();
    if (now - lastChatActionAtRef.current < 4_000) return;
    lastChatActionAtRef.current = now;
    void emitChatAction('TYPING');
  }, [composerMode, draft, emitChatAction, open, supports]);
  const sendComposer = () => {
    void submitGuardRef.current.run(async () => {
      setIsComposerSending(true);
      try {
        await submitComposer();
      } finally {
        setIsComposerSending(false);
      }
    });
  };
  const submitComposer = async () => {
    const text = draft.trim();
    const inlineKeyboard = buildInlineKeyboard(keyboardButtons);
    if (composerMode === 'note') {
      if (!text || pendingAttachments.length) return;
      await noteMutation.mutateAsync({ text, mentionedUserIds });
      return;
    }
    const unresolvedVariables = [...text.matchAll(/\{\{\s*([a-z0-9_.-]+)\s*\}\}/gi)].map(
      (match) => match[1],
    );
    if (unresolvedVariables.length) {
      void message.error(
        `Complete missing template fields: ${[...new Set(unresolvedVariables)].join(', ')}`,
      );
      return;
    }
    if (keyboardButtons.length && inlineKeyboard?.length !== keyboardButtons.length) {
      void message.error('Complete every inline keyboard button before sending.');
      return;
    }
    if (!textOutboundAvailable || !hasComposerContent(text, pendingAttachments.length)) {
      return;
    }
    if (keyboardButtons.length && pendingAttachments.length) {
      void message.error('Inline buttons can only be sent with a text message.');
      return;
    }
    if (keyboardButtons.length && !text) {
      void message.error('Inline buttons require a text message.');
      return;
    }
    if (replyMarkup && !text) {
      void message.error('Reply keyboard or Force Reply requires a text message.');
      return;
    }
    if (replyMarkup && keyboardButtons.length) {
      void message.error('Choose either inline buttons or reply markup.');
      return;
    }
    if (
      pendingAttachments.length &&
      (draftEntities.length ||
        protectContent ||
        messageEffectId.trim() ||
        quoteText.trim() ||
        Object.keys(linkPreviewOptions).length)
    ) {
      void message.error(
        'Formatting and advanced message options must be sent separately from attachment captions.',
      );
      return;
    }
    if (sendAsMediaGroup && pendingAttachments.length) {
      const groupKinds = pendingAttachments.map((item) => item.kind);
      const distinctKinds = new Set(groupKinds);
      const isVisualGroup = groupKinds.every((kind) => ['PHOTO', 'VIDEO'].includes(kind));
      const isSameKindGroup =
        distinctKinds.size === 1 && ['AUDIO', 'DOCUMENT'].includes(groupKinds[0]);
      if (
        pendingAttachments.length < 2 ||
        pendingAttachments.length > 10 ||
        (!isVisualGroup && !isSameKindGroup)
      ) {
        void message.error(
          'Albums support 2–10 photos/videos, or files of one audio/document kind.',
        );
        return;
      }
      const clientRequestId = mediaGroupClientRequestIdRef.current ?? crypto.randomUUID();
      mediaGroupClientRequestIdRef.current = clientRequestId;
      const formData = new FormData();
      pendingAttachments.forEach((item) => formData.append('files', item.file));
      formData.append('kinds', JSON.stringify(groupKinds));
      formData.append('clientRequestId', clientRequestId);
      if (text) formData.append('caption', text);
      if (hasSpoiler) formData.append('hasSpoiler', 'true');
      if (disableNotification) formData.append('disableNotification', 'true');
      try {
        await apiRequest(`/conversations/leads/${leadId}/${channel}/company/media-group`, {
          method: 'POST',
          body: formData,
        });
        pendingAttachments.forEach((item) =>
          releaseAttachmentDraft(item, (url) => {
            URL.revokeObjectURL(url);
            attachmentObjectUrlsRef.current.delete(url);
          }),
        );
        setPendingAttachments([]);
        setDraft('');
        setHasSpoiler(false);
        setDisableNotification(false);
        setSendAsMediaGroup(false);
        mediaGroupClientRequestIdRef.current = null;
        await queryClient.invalidateQueries({
          queryKey: [
            `omnicus-${projectId}-${identityId}-lead-company-conversation`,
            leadId,
            channel,
          ],
        });
      } catch (error) {
        setPendingAttachments((current) => current.map((item) => ({ ...item, status: 'failed' })));
        void message.error(getFriendlyErrorMessage(error, 'Unable to queue the media group.'));
      }
      return;
    }
    const normalizedQuote = quoteText.trim();
    const quotePosition = normalizedQuote ? replyTarget?.text.indexOf(normalizedQuote) : undefined;
    if (normalizedQuote && (quotePosition === undefined || quotePosition < 0)) {
      void message.error('The quote must match text from the replied message.');
      return;
    }
    const selectedLinkPreviewOptions = supports('linkPreviewOptions')
      ? linkPreviewOptions
      : undefined;
    const plan = planAttachmentOperations(
      pendingAttachments,
      text,
      replyTarget?.omnicusMessageId,
      hasSpoiler,
      channel === 'whatsapp' ? ['AUDIO', 'VOICE', 'VIDEO_NOTE', 'STICKER'] : undefined,
    );
    const planById = new Map(plan.drafts.map((item) => [item.id, item]));
    setPendingAttachments((current) => current.map((item) => planById.get(item.id) ?? item));
    let textSucceeded = false;
    let textError;
    let sentTextStatus;
    if (plan.textOperation) {
      const clientRequestId = pendingClientRequestIdRef.current ?? crypto.randomUUID();
      pendingClientRequestIdRef.current = clientRequestId;
      try {
        const sentText = await sendMutation.mutateAsync({
          text: plan.textOperation.text,
          clientRequestId,
          replyToMessageId: plan.textOperation.replyToMessageId,
          inlineKeyboard,
          replyMarkup,
          entities:
            supports('formattingEntities') && draftEntities.length ? draftEntities : undefined,
          protectContent: supports('protectContent') && protectContent ? true : undefined,
          disableNotification:
            channel === 'telegram' ? disableNotification || undefined : undefined,
          messageEffectId:
            supports('messageEffects') && messageEffectId.trim()
              ? messageEffectId.trim()
              : undefined,
          quote: supports('quote') && normalizedQuote ? normalizedQuote : undefined,
          quotePosition: supports('quote') && normalizedQuote ? quotePosition : undefined,
          linkPreviewOptions:
            selectedLinkPreviewOptions && Object.keys(selectedLinkPreviewOptions).length
              ? selectedLinkPreviewOptions
              : undefined,
        });
        if (sentText.status === 'failed') {
          throw new Error('Omnicus could not queue the message.');
        }
        sentTextStatus = sentText.status;
        textSucceeded = true;
        pendingClientRequestIdRef.current = null;
      } catch (error) {
        textError = error;
      }
    }
    setPendingAttachments((current) =>
      current.map((item) =>
        planById.has(item.id) ? { ...planById.get(item.id), status: 'sending' } : item,
      ),
    );
    const batch = await runAttachmentBatch(plan.drafts, async (item) => {
      const sentAttachment = await attachmentMutation.mutateAsync({
        file: item.file,
        kind: item.kind,
        clientRequestId: item.clientRequestId,
        caption: item.operation?.caption,
        replyToMessageId: item.operation?.replyToMessageId,
        hasSpoiler: item.operation?.hasSpoiler,
        durationSeconds: item.durationSeconds,
        disableNotification: channel === 'telegram' ? disableNotification || undefined : undefined,
      });
      if (sentAttachment.status === 'failed') {
        throw new Error('Omnicus could not queue the attachment.');
      }
      return sentAttachment;
    });
    const succeededIds = new Set(batch.succeeded.map(({ draft: item }) => item.id));
    const failedIds = new Set(batch.failed.map(({ draft: item }) => item.id));
    for (const { draft: item } of batch.succeeded) {
      releaseAttachmentDraft(item, (url) => {
        URL.revokeObjectURL(url);
        attachmentObjectUrlsRef.current.delete(url);
      });
    }
    setPendingAttachments((current) =>
      current
        .filter((item) => !succeededIds.has(item.id))
        .map((item) => (failedIds.has(item.id) ? { ...item, status: 'failed' } : item)),
    );
    const captionSucceeded = Boolean(
      plan.captionTargetId && succeededIds.has(plan.captionTargetId),
    );
    const replyAttachmentSucceeded = batch.succeeded.some(
      ({ draft: item }) => item.operation?.replyToMessageId,
    );
    if (textSucceeded || captionSucceeded) {
      setDraft('');
      setDraftEntities([]);
      setProtectContent(false);
      setDisableNotification(false);
      setMessageEffectId('');
      setQuoteText('');
      setLinkPreviewOptions({});
    }
    if (batch.succeeded.length && !batch.failed.length) setHasSpoiler(false);
    if (textSucceeded) {
      setKeyboardButtons([]);
      setReplyMarkup(undefined);
    }
    if ((textSucceeded && plan.textOperation?.replyToMessageId) || replyAttachmentSucceeded) {
      setReplyTarget(null);
    }
    if (textError) {
      void message.error(getFriendlyErrorMessage(textError, 'Unable to send the message.'));
    }
    if (batch.failed.length) {
      void message.error(
        `${batch.failed.length} attachment${batch.failed.length === 1 ? '' : 's'} failed and remain ready for retry.`,
      );
    }
    const unknownCount =
      (sentTextStatus === 'unknown' ? 1 : 0) +
      batch.succeeded.filter(({ result }) => result.status === 'unknown').length;
    if (unknownCount) {
      void message.warning(
        `${unknownCount} operation${unknownCount === 1 ? '' : 's'} has an unknown result and will not be retried automatically.`,
      );
    }
    if (textSucceeded || batch.succeeded.length) {
      shouldStickToBottomRef.current = true;
      if (!textError && !batch.failed.length) {
        await removeSavedDraft().catch(() => undefined);
      }
      await queryClient.invalidateQueries({
        queryKey: [`omnicus-${projectId}-${identityId}-lead-company-conversation`, leadId, channel],
      });
    }
  };
  const selectAttachments = (files) => {
    if (!files?.length) return;
    const accepted = Array.from(files).filter((file) => {
      const error =
        channel === 'whatsapp'
          ? whatsAppMediaError(file, mediaKind)
          : telegramMediaError(file, mediaKind);
      if (!error) return true;
      void message.error(`${file.name}: ${error}`);
      return false;
    });
    const selected = createAttachmentDrafts(accepted, mediaKind, {
      createId: () => crypto.randomUUID(),
      createObjectUrl: (file) => {
        const url = URL.createObjectURL(file);
        attachmentObjectUrlsRef.current.add(url);
        return url;
      },
    });
    setPendingAttachments((current) => [...current, ...selected]);
    const selectedKinds = new Set(selected.map((item) => item.kind));
    if (selectedKinds.has('PHOTO')) void emitChatAction('UPLOAD_PHOTO');
    else if (selectedKinds.has('VIDEO')) void emitChatAction('UPLOAD_VIDEO');
    else if (selectedKinds.has('VIDEO_NOTE')) {
      void emitChatAction('RECORD_VIDEO_NOTE');
    } else void emitChatAction('UPLOAD_DOCUMENT');
  };
  const removeAttachment = (id) => {
    setPendingAttachments((current) => {
      const selected = current.find((item) => item.id === id);
      if (selected) {
        releaseAttachmentDraft(selected, (url) => {
          URL.revokeObjectURL(url);
          attachmentObjectUrlsRef.current.delete(url);
        });
      }
      return current.filter((item) => item.id !== id);
    });
  };
  const insertEmoji = (emoji) => {
    const { start, end } = draftSelectionRef.current;
    const nextDraft = `${draft.slice(0, start)}${emoji}${draft.slice(end)}`;
    const nextCursor = start + emoji.length;
    setDraft(nextDraft);
    setDraftEntities([]);
    setEmojiPickerOpen(false);
    draftSelectionRef.current = { start: nextCursor, end: nextCursor };
    setDraftSelection({ start: nextCursor, end: nextCursor });
    requestAnimationFrame(() => {
      const textarea = composerRef.current?.querySelector('textarea');
      textarea?.focus();
      textarea?.setSelectionRange(nextCursor, nextCursor);
    });
  };
  const applyQuickReply = (template) => {
    const result = interpolateQuickReply(template.content, {
      ...(workspaceQuery.data?.variables ?? {}),
      'client.name': workspaceQuery.data?.variables['client.name'] ?? participantLabel,
      'client.username':
        workspaceQuery.data?.variables['client.username'] ?? conversation?.participant?.username,
      'lead.id': workspaceQuery.data?.variables['lead.id'] ?? leadId,
    });
    setComposerMode('message');
    setDraft(result.text);
    setDraftEntities([]);
    setIsQuickRepliesOpen(false);
    setQuickReplySearch('');
    pendingClientRequestIdRef.current = null;
    void apiRequest(`/conversations/quick-replies/${template._id}/use`, {
      method: 'POST',
    })
      .then(() =>
        queryClient.invalidateQueries({
          queryKey: [`omnicus-${projectId}-${identityId}-conversation-quick-replies`],
        }),
      )
      .catch(() => undefined);
    if (result.unresolved.length) {
      void message.warning(`Complete missing template fields: ${result.unresolved.join(', ')}`);
    }
    requestAnimationFrame(() => composerRef.current?.querySelector('textarea')?.focus());
  };
  const currentVoiceElapsedMilliseconds = () =>
    voiceAccumulatedMillisecondsRef.current +
    (voiceSegmentStartedAtRef.current === null
      ? 0
      : performance.now() - voiceSegmentStartedAtRef.current);
  const syncVoiceElapsed = () => {
    const seconds = Math.min(
      MAX_VOICE_RECORDING_SECONDS,
      Math.floor(currentVoiceElapsedMilliseconds() / 1000),
    );
    voiceElapsedRef.current = seconds;
    setVoiceElapsedSeconds(seconds);
    return seconds;
  };
  const closeVoiceSegment = () => {
    if (voiceSegmentStartedAtRef.current !== null) {
      voiceAccumulatedMillisecondsRef.current +=
        performance.now() - voiceSegmentStartedAtRef.current;
      voiceSegmentStartedAtRef.current = null;
    }
  };
  const finalVoiceDurationSeconds = () => {
    closeVoiceSegment();
    const seconds = Math.min(
      MAX_VOICE_RECORDING_SECONDS,
      Math.max(1, Math.ceil(voiceAccumulatedMillisecondsRef.current / 1000)),
    );
    voiceElapsedRef.current = seconds;
    setVoiceElapsedSeconds(seconds);
    return seconds;
  };
  const startVoiceTimer = (recorder) => {
    if (voiceTimerRef.current) clearInterval(voiceTimerRef.current);
    voiceTimerRef.current = setInterval(() => {
      if (syncVoiceElapsed() < MAX_VOICE_RECORDING_SECONDS) return;
      if (recorder.state !== 'inactive') recorder.stop();
      void message.info('Voice recordings are limited to 30 minutes');
    }, 250);
  };
  const startVoiceRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      void message.error('Voice recording is not supported by this browser');
      return;
    }
    clearVoiceDraft();
    void emitChatAction('RECORD_VOICE');
    discardVoiceRecordingRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = [
        'audio/ogg;codecs=opus',
        'audio/ogg',
        'audio/mp4;codecs=mp4a.40.2',
        'audio/mp4',
      ].find((candidate) => MediaRecorder.isTypeSupported(candidate));
      if (!mimeType) {
        stream.getTracks().forEach((track) => track.stop());
        void message.error(
          'This browser cannot record a compatible voice message. Upload an OGG/Opus or M4A file instead.',
        );
        return;
      }
      const recorder = new MediaRecorder(stream, {
        audioBitsPerSecond: VOICE_RECORDING_BITS_PER_SECOND,
        mimeType,
      });
      voiceStreamRef.current = stream;
      voiceRecorderRef.current = recorder;
      voiceChunksRef.current = [];
      voiceElapsedRef.current = 0;
      voiceAccumulatedMillisecondsRef.current = 0;
      voiceSegmentStartedAtRef.current = performance.now();
      setVoiceElapsedSeconds(0);
      recorder.ondataavailable = (event) => {
        if (event.data.size) voiceChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const durationSeconds = finalVoiceDurationSeconds();
        stopVoiceResources();
        voiceRecorderRef.current = null;
        if (discardVoiceRecordingRef.current) {
          voiceChunksRef.current = [];
          voiceAccumulatedMillisecondsRef.current = 0;
          voiceSegmentStartedAtRef.current = null;
          voiceElapsedRef.current = 0;
          setVoiceElapsedSeconds(0);
          discardVoiceRecordingRef.current = false;
          return;
        }
        const resolvedType = recorder.mimeType || mimeType;
        const normalizedType = resolvedType.split(';', 1)[0] || resolvedType;
        const blob = new Blob(voiceChunksRef.current, { type: resolvedType });
        voiceChunksRef.current = [];
        if (!blob.size) {
          setVoiceRecorderState('idle');
          void message.error('The voice recording is empty');
          return;
        }
        const extension = normalizedType === 'audio/ogg' ? 'ogg' : 'm4a';
        const file = new File(
          [blob],
          `voice-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`,
          { type: normalizedType },
        );
        const url = URL.createObjectURL(blob);
        voiceDraftUrlRef.current = url;
        setVoiceDraft({
          file,
          url,
          durationSeconds,
          kind: 'VOICE',
        });
        setVoiceRecorderState('preview');
      };
      recorder.start(250);
      setVoiceRecorderState('recording');
      startVoiceTimer(recorder);
    } catch (error) {
      stopVoiceResources();
      voiceSegmentStartedAtRef.current = null;
      setVoiceRecorderState('idle');
      void message.error(
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Microphone access was not granted'
          : 'Voice recording could not be started',
      );
    }
  };
  const pauseOrResumeVoiceRecording = () => {
    const recorder = voiceRecorderRef.current;
    if (!recorder) return;
    if (recorder.state === 'recording') {
      recorder.pause();
      closeVoiceSegment();
      syncVoiceElapsed();
      if (voiceTimerRef.current) {
        clearInterval(voiceTimerRef.current);
        voiceTimerRef.current = null;
      }
      setVoiceRecorderState('paused');
      return;
    }
    if (recorder.state === 'paused') {
      recorder.resume();
      voiceSegmentStartedAtRef.current = performance.now();
      startVoiceTimer(recorder);
      setVoiceRecorderState('recording');
    }
  };
  const stopVoiceRecording = () => {
    const recorder = voiceRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  };
  const cancelVoiceRecording = () => {
    discardVoiceRecordingRef.current = true;
    const recorder = voiceRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    stopVoiceResources();
    clearVoiceDraft();
  };
  const addVoiceDraftToComposer = () => {
    if (!voiceDraft) return;
    const [recordingDraft] = createAttachmentDrafts([voiceDraft.file], voiceDraft.kind, {
      createId: () => crypto.randomUUID(),
      createObjectUrl: (file) => {
        const url = URL.createObjectURL(file);
        attachmentObjectUrlsRef.current.add(url);
        return url;
      },
    });
    recordingDraft.durationSeconds = voiceDraft.durationSeconds;
    setPendingAttachments((current) => [...current, recordingDraft]);
    clearVoiceDraft();
  };
  const copyMessage = async (item) => {
    if (!item.text) return;
    try {
      await navigator.clipboard.writeText(item.text);
      void message.success('Message copied');
    } catch {
      void message.error('Unable to copy the message');
    }
  };
  const messageActionPath = (item, suffix = '') =>
    `/conversations/leads/${leadId}/${channel}/company/messages/${item.omnicusMessageId}${suffix}`;
  const startEditingMessage = (item) => {
    setEditingMessage(item);
    setEditDraft(item.text);
    setEditEntities(item.entities ?? []);
  };
  const submitMessageEdit = () => {
    if (!editingMessage?.omnicusMessageId || !editDraft.trim()) return;
    const preservedEntities = editEntities.filter(
      (entity) => entity.offset + entity.length <= editDraft.length,
    );
    providerMutation.mutate(
      {
        path: messageActionPath(editingMessage),
        method: 'PATCH',
        body: {
          clientRequestId: crypto.randomUUID(),
          text: editDraft,
          entities: preservedEntities,
          ...(editingMessage.linkPreviewOptions
            ? { linkPreviewOptions: editingMessage.linkPreviewOptions }
            : {}),
        },
      },
      {
        onSuccess: () => {
          setEditingMessage(null);
          setEditDraft('');
          setEditEntities([]);
        },
      },
    );
  };
  const confirmMessageDelete = (item) => {
    Modal.confirm({
      title: `Delete this ${channelLabel} message?`,
      content: `The operation is queued through Omnicus and may be restricted by ${channelLabel}.`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        await providerMutation.mutateAsync({
          path: messageActionPath(item),
          method: 'DELETE',
          body: { clientRequestId: crypto.randomUUID() },
        });
      },
    });
  };
  const changeMessageReaction = (item, value) => {
    providerMutation.mutate({
      path: messageActionPath(item, '/reaction'),
      method: value ? 'PUT' : 'DELETE',
      body: value
        ? {
            clientRequestId: crypto.randomUUID(),
            type: 'emoji',
            value,
          }
        : { clientRequestId: crypto.randomUUID() },
    });
  };
  const toggleMessagePin = (item) => {
    providerMutation.mutate({
      path: messageActionPath(item, '/pin'),
      method: item.isPinned ? 'DELETE' : 'PUT',
      body: { clientRequestId: crypto.randomUUID() },
    });
  };
  const retryProviderOperation = (operation) => {
    const operationId = operation.providerOperationId;
    if (
      !operationId ||
      !canRetryProviderOperation(operation, supports('explicitRetry')) ||
      retryInFlightRef.current.has(operationId)
    ) {
      return;
    }
    const clientRequestId = getStableRetryClientRequestId(
      retryClientRequestIdsRef.current,
      operationId,
      () => crypto.randomUUID(),
    );
    retryInFlightRef.current.add(operationId);
    providerMutation.mutate(
      {
        path: `/conversations/leads/${leadId}/${channel}/company/operations/${operationId}/retry`,
        method: 'POST',
        body: { clientRequestId },
      },
      {
        onSuccess: () => {
          retryClientRequestIdsRef.current.delete(operationId);
          void message.success('Retry queued');
        },
        onSettled: () => {
          retryInFlightRef.current.delete(operationId);
        },
      },
    );
  };
  const setLinkPreviewOption = (key, value) => {
    setLinkPreviewOptions((current) => {
      const next = { ...current };
      if (value === undefined || value === '' || value === false) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  };
  const toggleDraftFormat = (type) => {
    const { start, end } = draftSelectionRef.current;
    if (end <= start) {
      void message.info('Select part of the message first');
      return;
    }
    setDraftEntities((current) => toggleComposerEntity(current, type, start, end));
  };
  const toggleWhatsAppDraftFormat = (type) => {
    const { start, end } = draftSelectionRef.current;
    if (end <= start) {
      void message.info('Select part of the message first');
      return;
    }
    const marker = {
      bold: '*',
      italic: '_',
      strikethrough: '~',
      code: '```',
    }[type];
    const selectedText = draft.slice(start, end);
    const hasMarkers =
      start >= marker.length &&
      draft.slice(start - marker.length, start) === marker &&
      draft.slice(end, end + marker.length) === marker;
    const nextSelection = hasMarkers
      ? { start: start - marker.length, end: end - marker.length }
      : { start: start + marker.length, end: end + marker.length };
    const nextDraft = hasMarkers
      ? `${draft.slice(0, start - marker.length)}${selectedText}${draft.slice(end + marker.length)}`
      : `${draft.slice(0, start)}${marker}${selectedText}${marker}${draft.slice(end)}`;
    pendingClientRequestIdRef.current = null;
    setDraft(nextDraft);
    setDraftSelection(nextSelection);
    draftSelectionRef.current = nextSelection;
  };
  const isDraftFormatActive = (type) => {
    const { start, end } = draftSelection;
    return draftEntities.some(
      (entity) => entity.type === type && entity.offset === start && entity.length === end - start,
    );
  };
  const isWhatsAppDraftFormatActive = (type) => {
    const marker = {
      bold: '*',
      italic: '_',
      strikethrough: '~',
      code: '```',
    }[type];
    const { start, end } = draftSelection;
    return (
      end > start &&
      start >= marker.length &&
      draft.slice(start - marker.length, start) === marker &&
      draft.slice(end, end + marker.length) === marker
    );
  };
  const scrollToReferencedMessage = (omnicusMessageId) => {
    if (!omnicusMessageId) return;
    const source = messages.find((item) => item.omnicusMessageId === omnicusMessageId);
    if (!source) {
      void message.info('The referenced message is not loaded yet');
      return;
    }
    setSearchQuery('');
    requestAnimationFrame(() => {
      const element = document.getElementById(`chat-message-${source._id}`);
      scrollChatItem(element);
      setHighlightedMessageId(source._id);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 1600);
    });
  };
  const navigateSearchResult = (direction) => {
    if (!searchResults.length) return;
    const nextIndex = (searchResultIndex + direction + searchResults.length) % searchResults.length;
    setSearchResultIndex(nextIndex);
    const result = searchResults[nextIndex];
    const id = result.type === 'message' ? result.message._id : result.note._id;
    const prefix = result.type === 'message' ? 'chat-message' : 'chat-note';
    requestAnimationFrame(() => {
      scrollChatItem(document.getElementById(`${prefix}-${id}`));
      setHighlightedMessageId(id);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 1600);
    });
  };
  const nextOlderHistoryCursor =
    olderHistoryScope === currentHistoryScope && olderHistoryCursor !== undefined
      ? olderHistoryCursor
      : conversationQuery.data?.messagePage?.nextCursor;
  const loadOlderHistory = async () => {
    if (!nextOlderHistoryCursor || isOlderHistoryLoading) return;
    const list = messageListRef.current;
    const previousHeight = list?.scrollHeight ?? 0;
    setIsOlderHistoryLoading(true);
    try {
      const params = new URLSearchParams({
        limit: '100',
        cursor: nextOlderHistoryCursor,
      });
      const page = await apiRequest(
        `/conversations/leads/${leadId}/${channel}/company/messages?${params.toString()}`,
      );
      if (olderHistoryScope !== currentHistoryScope) {
        setOlderHistoryScope(currentHistoryScope);
        setOlderMessages(page.messages);
      } else {
        setOlderMessages((current) => mergeConversationMessages(page.messages, current));
      }
      setOlderHistoryCursor(page.nextCursor);
      requestAnimationFrame(() => {
        if (list) list.scrollTop += list.scrollHeight - previousHeight;
      });
    } catch (error) {
      void message.error(getFriendlyErrorMessage(error, 'Unable to load earlier messages.'));
    } finally {
      setIsOlderHistoryLoading(false);
    }
  };
  const reorderPendingAttachment = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    setPendingAttachments((current) =>
      reorderAttachmentDrafts(current, String(active.id), String(over.id)),
    );
  };
  const sendWhatsAppTemplate = async () => {
    if (!selectedWhatsAppTemplate) return;
    if (selectedWhatsAppTemplateUnsupportedReason) {
      void message.error(selectedWhatsAppTemplateUnsupportedReason);
      return;
    }
    setIsSendingWhatsAppTemplate(true);
    try {
      let mediaParameter;
      if (selectedWhatsAppTemplateMediaHeader) {
        if (!whatsAppTemplateMedia) {
          void message.error('Choose the required template header file.');
          return;
        }
        const format = selectedWhatsAppTemplateMediaHeader.component.format;
        const kind = format === 'IMAGE' ? 'PHOTO' : format === 'VIDEO' ? 'VIDEO' : 'DOCUMENT';
        const fileError = whatsAppMediaError(whatsAppTemplateMedia.file, kind);
        if (fileError) {
          void message.error(fileError);
          return;
        }
        let mediaAssetId = whatsAppTemplateMedia.mediaAssetId;
        if (!mediaAssetId) {
          const formData = new FormData();
          formData.append('file', whatsAppTemplateMedia.file);
          formData.append('kind', kind);
          formData.append('clientRequestId', whatsAppTemplateMedia.clientRequestId);
          const uploaded = await apiRequest(
            `/conversations/leads/${leadId}/whatsapp/company/message-templates/media`,
            { method: 'POST', body: formData },
          );
          mediaAssetId = uploaded.mediaAssetId;
          setWhatsAppTemplateMedia((current) => (current ? { ...current, mediaAssetId } : current));
        }
        mediaParameter = {
          componentIndex: selectedWhatsAppTemplateMediaHeader.componentIndex,
          type: format === 'IMAGE' ? 'image' : format === 'VIDEO' ? 'video' : 'document',
          mediaAssetId,
        };
      }
      const template = buildWhatsAppTemplateSend(
        selectedWhatsAppTemplate,
        whatsAppTemplateValues,
        mediaParameter,
      );
      if (!template) {
        void message.error('Complete every required template field.');
        return;
      }
      await sendMutation.mutateAsync({
        clientRequestId: crypto.randomUUID(),
        template,
        replyToMessageId: replyTarget?.omnicusMessageId,
      });
      setIsWhatsAppTemplateOpen(false);
      setSelectedWhatsAppTemplateId('');
      setWhatsAppTemplateValues({});
      setWhatsAppTemplateMedia(null);
      setReplyTarget(null);
      shouldStickToBottomRef.current = true;
      await queryClient.invalidateQueries({
        queryKey: [`omnicus-${projectId}-${identityId}-lead-company-conversation`, leadId, channel],
      });
      void message.success('WhatsApp template queued');
    } catch (error) {
      void message.error(getFriendlyErrorMessage(error, 'Unable to send the WhatsApp template.'));
    } finally {
      setIsSendingWhatsAppTemplate(false);
    }
  };
  const sendWhatsAppInteractive = async () => {
    const item = whatsAppInteractiveDraft;
    const body = item.body.trim();
    if (!body) return;
    const options = item.options
      .split('\n')
      .map((line, index) => {
        const [titlePart, idPart, ...descriptionParts] = line.split('|');
        const title = titlePart?.trim();
        if (!title) return null;
        return {
          id: idPart?.trim() || `option_${index + 1}`,
          title,
          description: descriptionParts.join('|').trim() || undefined,
        };
      })
      .filter((option) => Boolean(option));
    const maximum = item.type === 'button' ? 3 : 10;
    if (!options.length || options.length > maximum) {
      void message.error(
        item.type === 'button' ? 'Add 1 to 3 button options.' : 'Add 1 to 10 list options.',
      );
      return;
    }
    const duplicateIds = new Set(options.map((option) => option.id)).size !== options.length;
    if (duplicateIds) {
      void message.error('Every option must have a unique ID.');
      return;
    }
    setIsSendingWhatsAppInteractive(true);
    try {
      let mediaHeader;
      if (item.type === 'button' && item.headerType !== 'text') {
        if (!whatsAppInteractiveMedia) {
          void message.error('Choose the interactive header file.');
          return;
        }
        const kind =
          item.headerType === 'image'
            ? 'PHOTO'
            : item.headerType === 'video'
              ? 'VIDEO'
              : 'DOCUMENT';
        const fileError = whatsAppMediaError(whatsAppInteractiveMedia.file, kind);
        if (fileError) {
          void message.error(fileError);
          return;
        }
        let mediaAssetId = whatsAppInteractiveMedia.mediaAssetId;
        if (!mediaAssetId) {
          const formData = new FormData();
          formData.append('file', whatsAppInteractiveMedia.file);
          formData.append('kind', kind);
          formData.append('clientRequestId', whatsAppInteractiveMedia.clientRequestId);
          const uploaded = await apiRequest(
            `/conversations/leads/${leadId}/whatsapp/company/message-templates/media`,
            { method: 'POST', body: formData },
          );
          mediaAssetId = uploaded.mediaAssetId;
          setWhatsAppInteractiveMedia((current) =>
            current ? { ...current, mediaAssetId } : current,
          );
        }
        mediaHeader = { type: item.headerType, mediaAssetId };
      }
      const textHeader = item.header.trim()
        ? { type: 'text', text: item.header.trim() }
        : undefined;
      const interactive =
        item.type === 'button'
          ? {
              type: 'button',
              body: { text: body },
              ...(mediaHeader || textHeader ? { header: mediaHeader ?? textHeader } : {}),
              ...(item.footer.trim() ? { footer: { text: item.footer.trim() } } : {}),
              action: {
                buttons: options.map(({ id, title }) => ({ id, title })),
              },
            }
          : {
              type: 'list',
              body: { text: body },
              ...(textHeader ? { header: textHeader } : {}),
              ...(item.footer.trim() ? { footer: { text: item.footer.trim() } } : {}),
              action: {
                button: item.actionLabel.trim() || 'Choose',
                sections: [
                  {
                    ...(item.sectionTitle.trim() ? { title: item.sectionTitle.trim() } : {}),
                    rows: options,
                  },
                ],
              },
            };
      await sendMutation.mutateAsync({
        clientRequestId: crypto.randomUUID(),
        interactive,
        replyToMessageId: replyTarget?.omnicusMessageId,
      });
      setIsWhatsAppInteractiveOpen(false);
      setWhatsAppInteractiveDraft({
        type: 'button',
        headerType: 'text',
        header: '',
        body: '',
        footer: '',
        actionLabel: 'Choose',
        sectionTitle: 'Options',
        options: '',
      });
      setWhatsAppInteractiveMedia(null);
      setReplyTarget(null);
      shouldStickToBottomRef.current = true;
      await queryClient.invalidateQueries({
        queryKey: [`omnicus-${projectId}-${identityId}-lead-company-conversation`, leadId, channel],
      });
      void message.success('Interactive WhatsApp message queued');
    } catch (error) {
      void message.error(
        getFriendlyErrorMessage(error, 'Unable to send the interactive WhatsApp message.'),
      );
    } finally {
      setIsSendingWhatsAppInteractive(false);
    }
  };
  const sendStructuredMessage = async () => {
    const item = structuredMessageDraft;
    let structured;
    if (item.type === 'contact') {
      if (!item.firstName.trim() || !item.phoneNumber.trim()) return;
      structured =
        channel === 'whatsapp'
          ? {
              type: 'whatsapp_contact',
              formattedName: [item.firstName.trim(), item.lastName.trim()]
                .filter(Boolean)
                .join(' '),
              firstName: item.firstName.trim(),
              lastName: item.lastName.trim() || undefined,
              phones: [{ phone: item.phoneNumber.trim() }],
            }
          : {
              type: 'contact',
              firstName: item.firstName.trim(),
              lastName: item.lastName.trim() || undefined,
              phoneNumber: item.phoneNumber.trim(),
            };
    } else if (item.type === 'location') {
      const latitude = Number(item.latitude);
      const longitude = Number(item.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
      structured =
        channel === 'whatsapp'
          ? { type: 'whatsapp_location', latitude, longitude }
          : { type: 'location', latitude, longitude };
    } else {
      if (channel === 'whatsapp') {
        void message.error('WhatsApp polls are not available in this version.');
        return;
      }
      const options = item.options
        .split('\n')
        .map((option) => option.trim())
        .filter(Boolean);
      if (!item.question.trim() || options.length < 2) return;
      structured = {
        type: 'poll',
        question: item.question.trim(),
        options,
      };
    }
    try {
      await sendMutation.mutateAsync({
        clientRequestId:
          structuredClientRequestIdRef.current ??
          (structuredClientRequestIdRef.current = crypto.randomUUID()),
        structured,
        replyToMessageId: replyTarget?.omnicusMessageId,
      });
      setIsStructuredMessageOpen(false);
      structuredClientRequestIdRef.current = null;
      setStructuredMessageDraft({
        type: 'contact',
        firstName: '',
        lastName: '',
        phoneNumber: '',
        latitude: '',
        longitude: '',
        question: '',
        options: '',
      });
      await queryClient.invalidateQueries({
        queryKey: [`omnicus-${projectId}-${identityId}-lead-company-conversation`, leadId, channel],
      });
    } catch (error) {
      void message.error(getFriendlyErrorMessage(error, 'Unable to send structured message.'));
    }
  };
  const resetScheduleEditor = () => {
    setScheduledAt('');
    setScheduleMode('once');
    setScheduleInterval(1);
    setScheduleCount(2);
    setEditingSchedule(null);
    setIsScheduleOpen(false);
    scheduleClientRequestIdRef.current = null;
  };
  const openNewSchedule = () => {
    resetScheduleEditor();
    setIsScheduleOpen(true);
  };
  const openScheduleEditor = (item) => {
    if (!item.scheduleId || !item.scheduledAt) return;
    setEditingSchedule(item);
    setScheduledAt(scheduleInputValue(item.scheduledAt));
    setScheduleMode(
      item.scheduleRecurrence?.frequency === 'DAILY'
        ? 'daily'
        : item.scheduleRecurrence?.frequency === 'WEEKLY'
          ? 'weekly'
          : 'once',
    );
    setScheduleInterval(item.scheduleRecurrence?.interval ?? 1);
    setScheduleCount(item.scheduleRecurrence?.count ?? 2);
    scheduleClientRequestIdRef.current = null;
    setIsScheduleOpen(true);
  };
  const scheduleCurrentMessage = async () => {
    if ((!editingSchedule && !draft.trim()) || !scheduledAt) return;
    const recurrence =
      channel === 'whatsapp' || scheduleMode === 'once'
        ? undefined
        : {
            frequency: scheduleMode === 'daily' ? 'DAILY' : 'WEEKLY',
            interval: scheduleInterval,
            count: scheduleCount,
          };
    try {
      const clientRequestId =
        scheduleClientRequestIdRef.current ??
        (scheduleClientRequestIdRef.current = crypto.randomUUID());
      if (editingSchedule?.scheduleId) {
        setScheduleActionId(editingSchedule.scheduleId);
        await apiRequest(
          `/conversations/leads/${leadId}/${channel}/company/scheduled/${editingSchedule.scheduleId}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              clientRequestId,
              expectedRevision: editingSchedule.scheduleRevision ?? 1,
              scheduledAt: new Date(scheduledAt).toISOString(),
              recurrence: recurrence ?? null,
            }),
          },
        );
      } else {
        await apiRequest(`/conversations/leads/${leadId}/${channel}/company/scheduled`, {
          method: 'POST',
          body: JSON.stringify({
            text: draft.trim(),
            clientRequestId,
            scheduledAt: new Date(scheduledAt).toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            ...(channel === 'telegram' && disableNotification ? { disableNotification: true } : {}),
            ...(channel === 'telegram'
              ? {
                  replyMarkup,
                  entities: draftEntities,
                  inlineKeyboard: buildInlineKeyboard(keyboardButtons),
                  replyToMessageId: replyTarget?.omnicusMessageId,
                  quote: quoteText || undefined,
                  quotePosition: quoteText ? replyTarget?.text.indexOf(quoteText) : undefined,
                  protectContent,
                  messageEffectId: messageEffectId || undefined,
                  linkPreviewOptions,
                }
              : {}),
            recurrence,
          }),
        });
        setDraft('');
        setReplyMarkup(undefined);
        setDraftEntities([]);
        setKeyboardButtons([]);
        setReplyTarget(null);
        setQuoteText('');
        setProtectContent(false);
        setDisableNotification(false);
        setMessageEffectId('');
        setLinkPreviewOptions({});
        await removeSavedDraft().catch(() => undefined);
      }
      const wasEditing = Boolean(editingSchedule);
      resetScheduleEditor();
      shouldStickToBottomRef.current = true;
      await queryClient.invalidateQueries({
        queryKey: [`omnicus-${projectId}-${identityId}-lead-company-conversation`, leadId, channel],
      });
      void message.success(wasEditing ? 'Schedule updated' : 'Message scheduled');
    } catch (error) {
      void message.error(
        getFriendlyErrorMessage(
          error,
          editingSchedule ? 'Unable to update the schedule.' : 'Unable to schedule the message.',
        ),
      );
    } finally {
      setScheduleActionId(null);
    }
  };
  const confirmScheduleCancel = (item) => {
    if (!item.scheduleId) return;
    modal.confirm({
      title: 'Cancel scheduled message?',
      content: `This queued occurrence will not be sent to ${channelLabel}.`,
      okText: 'Cancel schedule',
      okButtonProps: { danger: true },
      async onOk() {
        setScheduleActionId(item.scheduleId);
        try {
          await apiRequest(
            `/conversations/leads/${leadId}/${channel}/company/scheduled/${item.scheduleId}`,
            {
              method: 'DELETE',
              body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
            },
          );
          await queryClient.invalidateQueries({
            queryKey: [
              `omnicus-${projectId}-${identityId}-lead-company-conversation`,
              leadId,
              channel,
            ],
          });
          void message.success('Scheduled message cancelled');
        } catch (error) {
          void message.error(
            getFriendlyErrorMessage(error, 'Unable to cancel the scheduled message.'),
          );
          throw error;
        } finally {
          setScheduleActionId(null);
        }
      },
    });
  };
  const applyReplyMarkup = () => {
    if (replyMarkupMode === 'remove') {
      setReplyMarkup({ type: 'reply_keyboard_remove' });
    } else if (replyMarkupMode === 'force') {
      setReplyMarkup({
        type: 'force_reply',
        ...(replyInputPlaceholder.trim()
          ? { inputFieldPlaceholder: replyInputPlaceholder.trim() }
          : {}),
      });
    } else {
      const buttons = replyKeyboardDraft
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 8)
        .map((line) => {
          const [kind, ...labelParts] = line.split(':');
          const label = labelParts.join(':').trim();
          if (kind === 'contact' && label) return { text: label, requestContact: true };
          if (kind === 'location' && label) return { text: label, requestLocation: true };
          return { text: line };
        });
      if (!buttons.length) {
        void message.error('Add at least one reply keyboard button.');
        return;
      }
      setReplyMarkup({
        type: 'reply_keyboard',
        keyboard: buttons.map((button) => [button]),
        isPersistent: replyKeyboardPersistent,
        oneTimeKeyboard: replyKeyboardOneTime,
        resizeKeyboard: true,
        ...(replyInputPlaceholder.trim()
          ? { inputFieldPlaceholder: replyInputPlaceholder.trim() }
          : {}),
      });
    }
    setKeyboardButtons([]);
    setIsReplyMarkupEditorOpen(false);
  };
  const sendRichMessage = async () => {
    const markdown = richMessageDraft.trim();
    if (!markdown) return;
    try {
      await sendMutation.mutateAsync({
        clientRequestId: crypto.randomUUID(),
        richMessage: { markdown },
        disableNotification: disableNotification || undefined,
      });
      setRichMessageDraft('');
      setIsRichMessageOpen(false);
      shouldStickToBottomRef.current = true;
      await queryClient.invalidateQueries({
        queryKey: [`omnicus-${projectId}-${identityId}-lead-company-conversation`, leadId, channel],
      });
      void message.success('Rich message queued');
    } catch (error) {
      void message.error(getFriendlyErrorMessage(error, 'Unable to send the rich message.'));
    }
  };
  const attachmentMenu = {
    items: Object.keys(mediaKindLabels)
      .filter((kind) => kind !== 'STICKER' || supports('stickers'))
      .filter((kind) => channel !== 'whatsapp' || !['VIDEO_NOTE', 'ANIMATION'].includes(kind))
      .map((kind) => ({
        key: kind,
        icon:
          kind === 'PHOTO' || kind === 'VIDEO' || kind === 'VIDEO_NOTE' ? (
            <PictureOutlined />
          ) : kind === 'DOCUMENT' ? (
            <FolderOpenOutlined />
          ) : (
            <PaperClipOutlined />
          ),
        label: (
          <span className="chat-media-kind-option">
            <strong>{mediaKindLabels[kind]}</strong>
            <small>
              {
                (channel === 'whatsapp'
                  ? whatsAppMediaKindDescriptions
                  : telegramMediaKindDescriptions)[kind]
              }
            </small>
          </span>
        ),
      })),
    onClick: ({ key }) => {
      setMediaKind(key);
      if (key === 'VIDEO_NOTE') {
        setIsVideoNoteRecorderOpen(true);
        return;
      }
      requestAnimationFrame(() => attachmentInputRef.current?.click());
    },
  };
  const closeChat = () => {
    if (!canSend || !hydratedDraftKeyRef.current) return;
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    const hasDraft = Boolean(
      replyMarkup ||
      draft.trim() ||
      draftEntities.length ||
      keyboardButtons.length ||
      replyTarget ||
      quoteText.trim() ||
      protectContent ||
      disableNotification ||
      messageEffectId.trim() ||
      Object.keys(linkPreviewOptions).length ||
      composerMode === 'note',
    );
    const path = `/conversations/leads/${leadId}/${channel}/company/draft`;
    const request = hasDraft
      ? apiRequest(path, {
          method: 'PUT',
          body: JSON.stringify({
            composerMode,
            text: draft,
            mentionedUserIds,
            entities: draftEntities,
            inlineKeyboard: buildInlineKeyboard(keyboardButtons) ?? [],
            replyMarkup,
            linkPreviewOptions,
            quote: quoteText || undefined,
            replyToMessageId: replyTarget?.omnicusMessageId,
            protectContent,
            disableNotification,
            messageEffectId: messageEffectId || undefined,
          }),
        })
      : Promise.resolve();
    if (pendingAttachments.length) {
      void message.info(
        'The text draft is saved. Selected local files are not retained after closing.',
      );
    }
    void request.catch(() => undefined).finally(onClose);
  };
  draftCloseRef.current = closeChat;
  return (
    <ChatFrame
      open={open}
      title={null}
      onCancel={closeChat}
      footer={null}
      width={1180}
      className="lead-chat-modal"
      centered
      closable={false}
      destroyOnHidden
    >
      <div className="chat-shell">
        <header className="chat-contact-header">
          <div className="chat-contact-identity">
            <Avatar className="chat-contact-avatar" size={44}>
              {contactInitials(participantLabel)}
            </Avatar>
            <span className="chat-contact-copy">
              <strong>{participantLabel}</strong>
              <small>
                {conversation?.participant?.username
                  ? `@${conversation.participant.username} · `
                  : ''}
                {isConnected ? `${channelLabel} connected` : `${channelLabel} is not connected`}
              </small>
            </span>
          </div>

          <div className="chat-header-actions">
            <Segmented
              size="small"
              value={channel}
              onChange={(value) => {
                hydratedDraftKeyRef.current = null;
                setChannel(value);
                setDraft('');
                setDraftEntities([]);
                setProtectContent(false);
                setDisableNotification(false);
                setMessageEffectId('');
                pendingClientRequestIdRef.current = null;
                setPendingAttachments((current) => {
                  for (const item of current) {
                    releaseAttachmentDraft(item, (url) => {
                      URL.revokeObjectURL(url);
                      attachmentObjectUrlsRef.current.delete(url);
                    });
                  }
                  return [];
                });
                setQuoteText('');
                setLinkPreviewOptions({});
                setReplyTarget(null);
                setKeyboardButtons([]);
                setIsKeyboardEditorOpen(false);
                setSearchQuery('');
                setHistoryFilter('all');
                setHistoryDate('');
                setSearchResultIndex(0);
                setComposerMode('message');
                setDraftStorageStatus('idle');
                setMentionedUserIds([]);
                setIsQuickRepliesOpen(false);
                setIsWhatsAppTemplateOpen(false);
                setSelectedWhatsAppTemplateId('');
                setWhatsAppTemplateValues({});
                setWhatsAppTemplateMedia(null);
                setIsWhatsAppInteractiveOpen(false);
                resetVoiceRecorder();
                whatsAppReadCompletedRef.current.clear();
                whatsAppReadInFlightRef.current.clear();
                whatsAppReadAttemptsRef.current.clear();
              }}
              options={[
                {
                  label: (
                    <span>
                      <WechatOutlined /> Telegram
                    </span>
                  ),
                  value: 'telegram',
                },
                {
                  label: (
                    <span>
                      <WhatsAppOutlined /> WhatsApp
                    </span>
                  ),
                  value: 'whatsapp',
                },
              ]}
            />
            <Button
              type={isSearchOpen ? 'primary' : 'text'}
              icon={<SearchOutlined />}
              aria-label="Search messages"
              onClick={() => {
                setIsSearchOpen((current) => !current);
                if (isSearchOpen) {
                  setSearchQuery('');
                  setHistoryFilter('all');
                  setHistoryDate('');
                }
              }}
            />
            <Button
              type="text"
              icon={<InfoCircleOutlined />}
              aria-label="Conversation information"
              onClick={() => setIsDetailsOpen(true)}
            />
            <Button
              type="text"
              icon={<CloseOutlined />}
              aria-label="Close chat"
              onClick={closeChat}
            />
          </div>
        </header>

        {isSearchOpen ? (
          <div className="chat-search-bar">
            <Input
              autoFocus
              allowClear
              prefix={<SearchOutlined />}
              placeholder="Search messages, files or sources"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setSearchResultIndex(0);
              }}
            />
            <Select
              value={historyFilter}
              onChange={(value) => {
                setHistoryFilter(value);
                setSearchResultIndex(0);
              }}
              className="chat-history-filter"
              options={[
                { value: 'all', label: 'All' },
                { value: 'media', label: 'Media' },
                { value: 'documents', label: 'Documents' },
                { value: 'links', label: 'Links' },
                { value: 'automation', label: 'Automation' },
                { value: 'manager', label: 'Manager' },
                { value: 'failed', label: 'Failed' },
              ]}
            />
            <DatePicker
              allowClear
              className="chat-history-date"
              format="DD MMM YYYY"
              placeholder="Any date"
              value={historyDate ? dayjs(historyDate) : null}
              onChange={(value) => {
                setHistoryDate(value?.format('YYYY-MM-DD') ?? '');
                setSearchResultIndex(0);
              }}
            />
            <span className="chat-search-navigation">
              <Typography.Text type="secondary">
                {searchResults.length
                  ? `${(searchResultIndex % searchResults.length) + 1}/${searchResults.length}`
                  : '0 results'}
              </Typography.Text>
              <Button
                type="text"
                size="small"
                icon={<UpOutlined />}
                aria-label="Previous search result"
                disabled={!searchResults.length}
                onClick={() => navigateSearchResult(-1)}
              />
              <Button
                type="text"
                size="small"
                icon={<DownOutlined />}
                aria-label="Next search result"
                disabled={!searchResults.length}
                onClick={() => navigateSearchResult(1)}
              />
            </span>
          </div>
        ) : null}

        {conversationQuery.isLoading ? (
          <div className="state-panel">
            <Spin size="large" />
          </div>
        ) : conversationQuery.isError ? (
          <Alert
            type="error"
            showIcon
            message={`${channelLabel} chat is not available`}
            description={getFriendlyErrorMessage(
              conversationQuery.error,
              `Unable to load ${channelLabel} conversation.`,
            )}
          />
        ) : (
          <>
            {!isConnected ? (
              <div className="chat-connect-panel">
                <div className="chat-status chat-status-neutral">
                  <InfoCircleOutlined />
                  <span>
                    No {channelLabel} conversation connected. Omnicus will connect it after contact
                    synchronization.
                  </span>
                </div>
              </div>
            ) : null}
            {channel === 'whatsapp' && isConnected ? (
              <div
                className={`chat-whatsapp-window chat-whatsapp-window-${(whatsAppServiceWindow?.state ?? 'UNKNOWN').toLowerCase()}`}
                role="status"
              >
                <span className="chat-whatsapp-window-content">
                  <WhatsAppOutlined />
                  <span>
                    <strong>
                      {capabilitiesQuery.isError
                        ? 'WhatsApp sending options are unavailable'
                        : whatsAppServiceWindow?.state === 'OPEN'
                          ? 'Customer-service window is open'
                          : whatsAppServiceWindow?.state === 'CLOSED'
                            ? 'Customer-service window is closed'
                            : 'Customer-service window is being checked'}
                    </strong>
                    <small>
                      {capabilitiesQuery.isError
                        ? getFriendlyErrorMessage(
                            capabilitiesQuery.error,
                            'Check the WhatsApp connection in Omnicus and try again.',
                          )
                        : whatsAppServiceWindow?.state === 'OPEN'
                          ? `Free-form messages are available${whatsAppServiceWindow.expiresAt ? ` until ${new Date(whatsAppServiceWindow.expiresAt).toLocaleString()}` : ''}.`
                          : 'Use an approved WhatsApp template to start or reopen the conversation.'}
                    </small>
                  </span>
                </span>
                {capabilitiesQuery.isError ? (
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    loading={capabilitiesQuery.isFetching}
                    onClick={() => void capabilitiesQuery.refetch()}
                  >
                    Try again
                  </Button>
                ) : supports('messageTemplates') ? (
                  <Button
                    size="small"
                    icon={<FileTextOutlined />}
                    disabled={!channelOutboundAvailable}
                    className="chat-whatsapp-window-template-button"
                    onClick={() => setIsWhatsAppTemplateOpen(true)}
                  >
                    Choose Meta template
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div
              ref={messageListRef}
              className="chat-message-list"
              onScroll={(event) => {
                const element = event.currentTarget;
                const distanceFromBottom =
                  element.scrollHeight - element.scrollTop - element.clientHeight;
                shouldStickToBottomRef.current = distanceFromBottom < 72;
              }}
            >
              <div className="chat-message-stack">
                {hasServerHistorySearch && searchedHistoryQuery.isLoading ? (
                  <div className="chat-history-loader">
                    <Spin size="small" /> Searching the full conversation…
                  </div>
                ) : hasServerHistorySearch && searchedHistoryQuery.hasNextPage ? (
                  <Button
                    className="chat-history-load-more"
                    loading={searchedHistoryQuery.isFetchingNextPage}
                    onClick={() => void searchedHistoryQuery.fetchNextPage()}
                  >
                    Load more matches
                  </Button>
                ) : !hasServerHistorySearch && nextOlderHistoryCursor ? (
                  <Button
                    className="chat-history-load-more"
                    loading={isOlderHistoryLoading}
                    onClick={() => void loadOlderHistory()}
                  >
                    Load earlier messages
                  </Button>
                ) : null}
                {visibleMessages.length || visibleInternalNotes.length ? (
                  timeline.map((entry) => {
                    if (entry.type === 'day') {
                      return (
                        <div className="chat-day-separator" key={entry.key}>
                          <span>{entry.label}</span>
                        </div>
                      );
                    }
                    if (entry.type === 'note') {
                      return (
                        <article
                          id={`chat-note-${entry.note._id}`}
                          className={`chat-timeline-note${
                            entry.note.mentionedUserIds.includes(currentUser?.id ?? '')
                              ? ' is-mentioned'
                              : ''
                          }${
                            highlightedMessageId === entry.note._id
                              ? ' chat-message-highlighted'
                              : ''
                          }`}
                          key={entry.key}
                        >
                          <header>
                            <span>
                              <FileTextOutlined />
                              <strong>Internal note</strong>
                              {entry.note.mentionedUserIds.includes(currentUser?.id ?? '') ? (
                                <Tag color="gold" bordered={false}>
                                  Mentioned you
                                </Tag>
                              ) : null}
                            </span>
                            <span className="chat-note-header-actions">
                              {(currentUser?.role === 'ADMIN' ||
                                entry.note.authorUserId === currentUser?.id) && (
                                <>
                                  <Button
                                    type="text"
                                    size="small"
                                    icon={<EditOutlined />}
                                    aria-label="Edit internal note"
                                    onClick={() => {
                                      setEditingNote(entry.note);
                                      setEditingNoteText(entry.note.text);
                                      setEditingNoteMentionedUserIds(entry.note.mentionedUserIds);
                                    }}
                                  />
                                  <Button
                                    type="text"
                                    danger
                                    size="small"
                                    icon={<DeleteOutlined />}
                                    aria-label="Delete internal note"
                                    onClick={() =>
                                      modal.confirm({
                                        title: 'Delete internal note?',
                                        content:
                                          'The note will disappear from the conversation for the team.',
                                        okText: 'Delete',
                                        okButtonProps: { danger: true },
                                        onOk: async () => {
                                          await deleteNoteMutation.mutateAsync(entry.note._id);
                                        },
                                      })
                                    }
                                  />
                                </>
                              )}
                              <time>
                                {entry.note.createdAt
                                  ? new Date(entry.note.createdAt).toLocaleTimeString([], {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                    })
                                  : ''}
                              </time>
                            </span>
                          </header>
                          <p>{entry.note.text}</p>
                          <footer>
                            <span>{entry.note.authorName}</span>
                            <small>Visible only to your team</small>
                          </footer>
                        </article>
                      );
                    }
                    const { message: item, groupPosition, mediaGroupPosition, showSender } = entry;
                    const latestOperation = latestMessageOperation(
                      providerOperations,
                      item.omnicusMessageId,
                    );
                    const providerActionPending = isProviderOperationPending(latestOperation);
                    const providerMessageReady = ['received', 'sent', 'delivered', 'read'].includes(
                      item.status,
                    );
                    const displayedEffect =
                      availableMessageEffects.find(
                        (effect) => effect.id === item.messageEffectId,
                      ) ??
                      (item.messageEffectId
                        ? {
                            id: item.messageEffectId,
                            label: 'Effect applied',
                          }
                        : undefined);
                    const displayedPreviewUrl =
                      item.linkPreviewOptions?.url ??
                      item.text.match(/https?:\/\/[^\s<>()]+/i)?.[0];
                    const safeFailureMessage =
                      item.status === 'unknown'
                        ? 'Delivery is being checked. Do not send this message again.'
                        : item.status === 'failed'
                          ? (item.outboundErrorMessage ??
                            latestOperation?.errorMessage ??
                            `${channel === 'whatsapp' ? 'WhatsApp' : 'Telegram'} could not deliver this message. You can retry it safely.`)
                          : undefined;
                    const whatsAppTemplateMessage = item.whatsappTemplate
                      ? resolveWhatsAppTemplateMessage(item.whatsappTemplate, whatsAppTemplates)
                      : null;
                    return (
                      <div
                        key={item._id}
                        id={`chat-message-${item._id}`}
                        className={`chat-message-row chat-message-row-${item.direction} chat-message-group-${groupPosition} chat-media-group-${mediaGroupPosition}${highlightedMessageId === item._id ? ' chat-message-highlighted' : ''}${activeMessageActionsId === item._id ? ' is-actions-open' : ''}`}
                      >
                        <div
                          className="chat-message-bubble"
                          data-message-id={item._id}
                          tabIndex={0}
                          aria-label="Message. Click to show actions"
                          aria-expanded={activeMessageActionsId === item._id}
                          onClick={(event) => {
                            const target = event.target;
                            if (
                              target.closest(
                                "button, a, input, textarea, audio, video, [role='button']",
                              ) ||
                              window.getSelection()?.toString()
                            ) {
                              return;
                            }
                            setActiveMessageActionsId((current) =>
                              current === item._id ? null : item._id,
                            );
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter' && event.key !== ' ') {
                              return;
                            }
                            event.preventDefault();
                            setActiveMessageActionsId((current) =>
                              current === item._id ? null : item._id,
                            );
                          }}
                        >
                          {showSender && item.direction !== 'outbound' ? (
                            <strong className="chat-message-sender">
                              {messageSourceLabel(item)}
                            </strong>
                          ) : null}
                          {item.referencePreview ? (
                            <button
                              type="button"
                              className="chat-reference-preview"
                              onClick={() =>
                                scrollToReferencedMessage(item.referencePreview?.omnicusMessageId)
                              }
                            >
                              <small>{item.interactive ? 'Button response to' : 'Reply to'}</small>
                              <strong>{item.referencePreview.senderName ?? 'Message'}</strong>
                              <span>{item.quote ?? item.referencePreview.text}</span>
                            </button>
                          ) : null}
                          {item.deletedAt ? (
                            <div className="chat-message-deleted">
                              {channel === 'whatsapp'
                                ? 'This message was deleted in WhatsApp'
                                : 'Message deleted'}
                            </div>
                          ) : (
                            <>
                              <MessageAttachment
                                item={item}
                                spoilerRevealed={revealedSpoilers.has(item._id)}
                                onRevealSpoiler={() =>
                                  setRevealedSpoilers((current) => {
                                    const next = new Set(current);
                                    next.add(item._id);
                                    return next;
                                  })
                                }
                              />
                              {item.whatsappTemplate ? (
                                <div className="chat-whatsapp-template-message">
                                  <small>Meta template</small>
                                  {whatsAppTemplateMessage?.header ? (
                                    <strong>{whatsAppTemplateMessage.header}</strong>
                                  ) : null}
                                  {whatsAppTemplateMessage?.body ? (
                                    <span>{whatsAppTemplateMessage.body}</span>
                                  ) : (
                                    <strong>{item.whatsappTemplate.name}</strong>
                                  )}
                                  {whatsAppTemplateMessage?.footer ? (
                                    <small>{whatsAppTemplateMessage.footer}</small>
                                  ) : null}
                                  {whatsAppTemplateMessage?.buttons.length ? (
                                    <div className="chat-whatsapp-template-buttons">
                                      {whatsAppTemplateMessage.buttons.map(
                                        (button, buttonIndex) => (
                                          <span key={`${button}-${buttonIndex}`}>{button}</span>
                                        ),
                                      )}
                                    </div>
                                  ) : null}
                                  <small>
                                    {item.whatsappTemplate.name} ·{' '}
                                    {item.whatsappTemplate.languageCode}
                                  </small>
                                </div>
                              ) : item.whatsappInteractive ? (
                                <div className="chat-whatsapp-interactive-message">
                                  {item.whatsappInteractive.header?.type === 'text' ? (
                                    <strong>{item.whatsappInteractive.header.text}</strong>
                                  ) : null}
                                  <span>{item.whatsappInteractive.body.text}</span>
                                  {item.whatsappInteractive.footer?.text ? (
                                    <small>{item.whatsappInteractive.footer.text}</small>
                                  ) : null}
                                  <div>
                                    {item.whatsappInteractive.type === 'button'
                                      ? item.whatsappInteractive.action.buttons.map((button) => (
                                          <span key={button.id}>{button.title}</span>
                                        ))
                                      : item.whatsappInteractive.action.sections.flatMap(
                                          (section) =>
                                            section.rows.map((row) => (
                                              <span key={row.id}>{row.title}</span>
                                            )),
                                        )}
                                  </div>
                                </div>
                              ) : item.interactive ? (
                                <div className="chat-interactive-event">
                                  <small>
                                    {item.interactive.type === 'list_reply'
                                      ? 'List option selected'
                                      : 'Button selected'}
                                  </small>
                                  <strong>
                                    {item.interactive.title ??
                                      item.interactive.displayText ??
                                      item.interactive.data ??
                                      'Callback'}
                                  </strong>
                                  {item.interactive.description ? (
                                    <span>{item.interactive.description}</span>
                                  ) : null}
                                </div>
                              ) : item.sharedContact ? (
                                <div className="chat-shared-contact">
                                  <Avatar icon={<UserOutlined />} />
                                  <span>
                                    <strong>
                                      {[item.sharedContact.firstName, item.sharedContact.lastName]
                                        .filter(Boolean)
                                        .join(' ')}
                                    </strong>
                                    <a href={`tel:${item.sharedContact.phoneNumber}`}>
                                      {item.sharedContact.phoneNumber}
                                    </a>
                                  </span>
                                </div>
                              ) : item.structured?.type === 'whatsapp_contact' ? (
                                <div className="chat-shared-contact">
                                  <Avatar icon={<UserOutlined />} />
                                  <span>
                                    <strong>{item.structured.formattedName}</strong>
                                    {item.structured.phones.map((phone) => (
                                      <a
                                        href={`tel:${phone.phone}`}
                                        key={`${phone.phone}-${phone.type ?? 'phone'}`}
                                      >
                                        {phone.phone}
                                      </a>
                                    ))}
                                  </span>
                                </div>
                              ) : item.structured?.type === 'whatsapp_contacts' ? (
                                <div className="chat-shared-contact-list">
                                  {item.structured.contacts.map((contact, contactIndex) => (
                                    <div
                                      className="chat-shared-contact"
                                      key={`${contact.formattedName}-${contactIndex}`}
                                    >
                                      <Avatar icon={<UserOutlined />} />
                                      <span>
                                        <strong>{contact.formattedName}</strong>
                                        {contact.phones.map((phone) => (
                                          <a
                                            href={`tel:${phone.phone}`}
                                            key={`${phone.phone}-${phone.type ?? 'phone'}`}
                                          >
                                            {phone.phone}
                                          </a>
                                        ))}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              ) : item.structured?.type === 'whatsapp_location' ? (
                                <a
                                  className="chat-message-link-card"
                                  href={`https://www.openstreetmap.org/?mlat=${item.structured.latitude}&mlon=${item.structured.longitude}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  <LinkOutlined />
                                  {item.structured.name ??
                                    item.structured.address ??
                                    'Open shared location'}
                                </a>
                              ) : item.structured?.type === 'contact' ? (
                                <div className="chat-shared-contact">
                                  <Avatar icon={<UserOutlined />} />
                                  <span>
                                    <strong>
                                      {[item.structured.firstName, item.structured.lastName]
                                        .filter(Boolean)
                                        .join(' ')}
                                    </strong>
                                    <a href={`tel:${item.structured.phoneNumber}`}>
                                      {item.structured.phoneNumber}
                                    </a>
                                  </span>
                                </div>
                              ) : item.structured?.type === 'location' ? (
                                <a
                                  className="chat-message-link-card"
                                  href={`https://www.openstreetmap.org/?mlat=${item.structured.latitude}&mlon=${item.structured.longitude}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  <LinkOutlined /> Open shared location
                                </a>
                              ) : item.structured?.type === 'poll' ? (
                                <div className="chat-structured-poll">
                                  <strong>{item.structured.question}</strong>
                                  {item.structured.options.map((option) => (
                                    <span key={option}>{option}</span>
                                  ))}
                                </div>
                              ) : item.richMessage ? (
                                <div className="chat-structured-poll">
                                  <small>Telegram rich message</small>
                                  <Typography.Text className="chat-message-text">
                                    {item.richMessage.markdown}
                                  </Typography.Text>
                                </div>
                              ) : !item.attachment ? (
                                <Typography.Text className="chat-message-text">
                                  {renderFormattedMessage(
                                    formatStructuredCarOfferText(item.text),
                                    item.entities,
                                  )}
                                </Typography.Text>
                              ) : null}
                              {item.attachment &&
                              item.text &&
                              item.text !== item.attachment.fileName &&
                              item.text !== 'Media attachment' ? (
                                <Typography.Text className="chat-message-text">
                                  {renderFormattedMessage(
                                    formatStructuredCarOfferText(item.text),
                                    item.entities,
                                  )}
                                </Typography.Text>
                              ) : null}
                              {item.inlineKeyboard?.length ? (
                                <div className="chat-inline-keyboard-preview">
                                  {item.inlineKeyboard.flat().map((button, index) => (
                                    <span key={`${button.text}-${index}`}>{button.text}</span>
                                  ))}
                                </div>
                              ) : null}
                              {item.replyMarkup ? (
                                <div className="chat-message-option-badges">
                                  <span>
                                    {item.replyMarkup.type === 'force_reply'
                                      ? 'Force Reply'
                                      : item.replyMarkup.type === 'reply_keyboard_remove'
                                        ? 'Reply keyboard removed'
                                        : `${item.replyMarkup.keyboard.flat().length} reply buttons`}
                                  </span>
                                </div>
                              ) : null}
                              {item.linkPreviewOptions?.isDisabled !== true &&
                              displayedPreviewUrl ? (
                                <a
                                  className="chat-message-link-card"
                                  href={displayedPreviewUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  <LinkOutlined />
                                  <span>
                                    <strong>Link preview</strong>
                                    <small>{displayedPreviewUrl}</small>
                                  </span>
                                </a>
                              ) : null}
                              {item.protectContent || displayedEffect ? (
                                <div className="chat-message-option-badges">
                                  {item.protectContent ? (
                                    <span>
                                      <EyeInvisibleOutlined /> Protected
                                    </span>
                                  ) : null}
                                  {displayedEffect ? (
                                    <span>
                                      {displayedEffect.emoji ?? <ThunderboltOutlined />}{' '}
                                      {displayedEffect.label}
                                    </span>
                                  ) : null}
                                </div>
                              ) : null}
                              {item.sourceContext ? (
                                item.sourceContext.webUrl ? (
                                  <a
                                    className="chat-source-context"
                                    href={item.sourceContext.webUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {item.sourceContext.displayName}
                                  </a>
                                ) : (
                                  <span className="chat-source-context">
                                    {item.sourceContext.displayName}
                                  </span>
                                )
                              ) : null}
                            </>
                          )}
                          <div
                            className="chat-message-actions"
                            onClick={(event) => event.stopPropagation()}
                          >
                            {item.scheduleId &&
                            item.status === 'queued' &&
                            (channel === 'telegram' || channel === 'whatsapp') &&
                            supports('scheduling') ? (
                              <>
                                <Button
                                  type="text"
                                  size="small"
                                  icon={<CalendarOutlined />}
                                  aria-label="Edit scheduled delivery"
                                  disabled={scheduleActionId === item.scheduleId}
                                  onClick={() => openScheduleEditor(item)}
                                />
                                <Button
                                  type="text"
                                  danger
                                  size="small"
                                  icon={<CloseCircleOutlined />}
                                  aria-label="Cancel scheduled message"
                                  disabled={scheduleActionId === item.scheduleId}
                                  onClick={() => confirmScheduleCancel(item)}
                                />
                              </>
                            ) : null}
                            {providerMessageReady && item.omnicusMessageId && !item.deletedAt ? (
                              <Button
                                type="text"
                                size="small"
                                icon={<RollbackOutlined />}
                                aria-label="Reply to message"
                                onClick={() => {
                                  setQuoteText('');
                                  setReplyTarget(item);
                                  pendingClientRequestIdRef.current = null;
                                }}
                              />
                            ) : null}
                            {item.text && !item.deletedAt ? (
                              <Button
                                type="text"
                                size="small"
                                icon={<CopyOutlined />}
                                aria-label="Copy message"
                                onClick={() => void copyMessage(item)}
                              />
                            ) : null}
                            {item.direction === 'outbound' &&
                            providerMessageReady &&
                            item.omnicusMessageId &&
                            !item.deletedAt &&
                            supports('editMessage') ? (
                              <Button
                                type="text"
                                size="small"
                                icon={<EditOutlined />}
                                aria-label="Edit message"
                                disabled={providerActionPending}
                                onClick={() => startEditingMessage(item)}
                              />
                            ) : null}
                            {providerMessageReady &&
                            item.omnicusMessageId &&
                            !item.deletedAt &&
                            supports('reactions') ? (
                              <Popover
                                placement="top"
                                trigger="click"
                                content={
                                  <div className="chat-reaction-picker">
                                    {messageReactionOptions.map((reaction) => (
                                      <button
                                        type="button"
                                        key={reaction}
                                        onClick={() => changeMessageReaction(item, reaction)}
                                      >
                                        {reaction}
                                      </button>
                                    ))}
                                    {item.managerReaction ? (
                                      <button
                                        type="button"
                                        className="chat-reaction-remove"
                                        onClick={() => changeMessageReaction(item)}
                                      >
                                        Remove
                                      </button>
                                    ) : null}
                                  </div>
                                }
                              >
                                <Button
                                  type="text"
                                  size="small"
                                  icon={<HeartOutlined />}
                                  aria-label="React to message"
                                  disabled={providerActionPending}
                                />
                              </Popover>
                            ) : null}
                            {providerMessageReady &&
                            item.omnicusMessageId &&
                            !item.deletedAt &&
                            supports('pinMessage') ? (
                              <Button
                                type="text"
                                size="small"
                                icon={<PushpinOutlined />}
                                className={item.isPinned ? 'is-active' : ''}
                                aria-label={item.isPinned ? 'Unpin message' : 'Pin message'}
                                disabled={providerActionPending}
                                onClick={() => toggleMessagePin(item)}
                              />
                            ) : null}
                            {providerMessageReady &&
                            item.omnicusMessageId &&
                            !item.deletedAt &&
                            supports('deleteMessage') ? (
                              <Button
                                type="text"
                                danger
                                size="small"
                                icon={<DeleteOutlined />}
                                aria-label="Delete message"
                                disabled={providerActionPending}
                                onClick={() => confirmMessageDelete(item)}
                              />
                            ) : null}
                            {canRetryProviderOperation(
                              latestOperation,
                              supports('explicitRetry'),
                            ) ? (
                              <Button
                                type="text"
                                size="small"
                                icon={<ReloadOutlined />}
                                aria-label="Retry failed action"
                                disabled={providerMutation.isPending}
                                onClick={() => retryProviderOperation(latestOperation)}
                              />
                            ) : null}
                          </div>
                          {item.managerReaction || item.clientReactions?.length || item.isPinned ? (
                            <div className="chat-message-state-badges">
                              {item.managerReaction ? (
                                <button
                                  type="button"
                                  className="chat-manager-reaction"
                                  aria-label="Remove your reaction"
                                  disabled={providerActionPending}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    changeMessageReaction(item);
                                  }}
                                >
                                  {item.managerReaction.value}
                                </button>
                              ) : null}
                              {item.clientReactions?.map((reaction, index) => (
                                <span
                                  className="chat-client-reaction"
                                  key={`${reaction.type}-${reaction.emoji ?? reaction.customEmojiId ?? index}`}
                                  aria-label={`Client reaction from ${item.clientReactionActor?.displayName ?? 'client'}`}
                                >
                                  {reaction.type === 'emoji'
                                    ? reaction.emoji
                                    : reaction.type === 'paid'
                                      ? '⭐'
                                      : 'Custom emoji'}
                                </span>
                              ))}
                              {item.isPinned ? (
                                <span>
                                  <PushpinOutlined /> Pinned
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                          {safeFailureMessage ? (
                            <div
                              className={`chat-message-safe-error chat-message-safe-error-${item.status}`}
                              role="status"
                            >
                              {safeFailureMessage}
                            </div>
                          ) : null}
                          <div className="chat-message-footer">
                            <span className="chat-message-telegram-meta">
                              <MessageSourceIcon item={item} />
                              {item.direction === 'outbound' &&
                              item.source &&
                              item.source !== 'CRM' ? (
                                <small className="chat-message-source-label">
                                  {messageSourceLabel(item)}
                                </small>
                              ) : null}
                              {item.disableNotification ? (
                                <BellOutlined aria-label="Sent silently" />
                              ) : null}
                              {item.scheduledAt ? (
                                <small className="chat-message-schedule-label">
                                  <ClockCircleOutlined />
                                  {item.status === 'queued' || item.status === 'processing'
                                    ? `Scheduled ${new Date(item.scheduledAt).toLocaleString([], {
                                        month: 'short',
                                        day: 'numeric',
                                        hour: '2-digit',
                                        minute: '2-digit',
                                      })}`
                                    : 'Scheduled'}
                                  {item.scheduleRecurrence
                                    ? ` · Every ${item.scheduleRecurrence.interval} ${
                                        item.scheduleRecurrence.frequency === 'DAILY'
                                          ? 'day(s)'
                                          : 'week(s)'
                                      }${
                                        item.scheduleRecurrence.count
                                          ? ` · ${item.scheduleRecurrence.count} total`
                                          : ''
                                      }`
                                    : ''}
                                </small>
                              ) : null}
                              <time>{messageTime(item)}</time>
                              <DeliveryStatusIcon item={item} />
                              {item.editedAt ? <small>edited</small> : null}
                              {providerActionPending ? (
                                <LoadingOutlined spin aria-label="Action pending" />
                              ) : null}
                            </span>
                            <Typography.Text
                              type="secondary"
                              className="chat-message-meta chat-message-meta-legacy"
                            >
                              {item.senderName ??
                                (item.direction === 'outbound' ? 'CRM' : 'Client')}
                              {(item.occurredAt ?? item.createdAt)
                                ? ` · ${new Date(item.occurredAt ?? item.createdAt).toLocaleString()}`
                                : ''}
                              {item.direction === 'outbound'
                                ? ` · ${deliveryStatusLabel(item.status)}`
                                : ''}
                            </Typography.Text>
                            {providerMessageReady && item.omnicusMessageId && !item.deletedAt ? (
                              <Button
                                type="text"
                                size="small"
                                icon={<RollbackOutlined />}
                                className="chat-reply-action"
                                onClick={() => {
                                  setQuoteText('');
                                  setReplyTarget(item);
                                  pendingClientRequestIdRef.current = null;
                                }}
                              >
                                Reply
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={searchQuery ? 'No matching messages' : 'No messages yet'}
                  />
                )}
              </div>
            </div>

            {hasPendingExpertMedia ? (
              <div className="chat-pending-media-panel">
                <div className="chat-pending-media-copy">
                  <Badge count={pendingExpertMediaFiles.length} color="#0f766e" />
                  <span className="chat-pending-media-summary">
                    <strong>Inspection files selected</strong>
                    <small>{pendingExpertMediaSummary}</small>
                  </span>
                </div>
                <div className="chat-pending-media-actions">
                  <Button
                    size="small"
                    onClick={clearPendingExpertMedia}
                    disabled={expertMediaMutation.isPending}
                  >
                    Clear
                  </Button>
                  <Button
                    type="primary"
                    size="small"
                    loading={expertMediaMutation.isPending}
                    disabled={!isConnected || !expertMediaOutboundAvailable}
                    onClick={() => expertMediaMutation.mutate(pendingExpertMediaFiles)}
                  >
                    Send media
                  </Button>
                </div>
              </div>
            ) : null}

            <div
              ref={composerRef}
              aria-disabled={!channelOutboundAvailable}
              className={`chat-composer${!channelOutboundAvailable ? ' chat-composer--disabled' : ''}`}
              inert={!channelOutboundAvailable}
            >
              <div className="chat-composer-scroll">
                {replyTarget ? (
                  <div className="chat-reply-composer-preview">
                    <span>
                      <small>Replying to {replyTarget.senderName ?? 'message'}</small>
                      <strong>
                        {replyTarget.text ||
                          replyTarget.attachment?.fileName ||
                          replyTarget.interactive?.displayText ||
                          'Message'}
                      </strong>
                    </span>
                    <Button
                      size="small"
                      onClick={() => {
                        setQuoteText('');
                        setReplyTarget(null);
                        pendingClientRequestIdRef.current = null;
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : null}

                {composerMode === 'note' ? (
                  <div className="chat-note-mode-banner">
                    <FileTextOutlined />
                    <span>
                      <strong>Internal note</strong>
                      <small>This will not be sent to the client</small>
                    </span>
                    <Button
                      type="text"
                      size="small"
                      icon={<CloseOutlined />}
                      aria-label="Exit internal note mode"
                      onClick={() => setComposerMode('message')}
                    />
                  </div>
                ) : null}
                <input
                  ref={attachmentInputRef}
                  type="file"
                  multiple
                  accept={mediaInputAccept(channel, mediaKind)}
                  className="chat-attachment-input"
                  onChange={(event) => {
                    selectAttachments(event.target.files);
                    event.target.value = '';
                  }}
                />
                {voiceRecorderState !== 'idle' ? (
                  <div className="chat-voice-recorder">
                    {voiceRecorderState === 'preview' && voiceDraft ? (
                      <>
                        <div className="chat-voice-preview-main">
                          <audio
                            src={voiceDraft.url}
                            controls
                            preload="metadata"
                            onLoadedMetadata={(event) => repairAudioDuration(event.currentTarget)}
                          />
                          <Segmented
                            size="small"
                            value={voiceDraft.kind}
                            options={[
                              { value: 'VOICE', label: 'Voice' },
                              { value: 'AUDIO', label: 'Audio file' },
                            ]}
                            onChange={(kind) =>
                              setVoiceDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      kind: kind,
                                    }
                                  : current,
                              )
                            }
                          />
                        </div>
                        <span className="chat-voice-recorder-actions">
                          <Button
                            type="text"
                            danger
                            icon={<DeleteOutlined />}
                            aria-label="Delete recording"
                            onClick={clearVoiceDraft}
                          />
                          <Button
                            icon={<ReloadOutlined />}
                            onClick={() => void startVoiceRecording()}
                          >
                            Re-record
                          </Button>
                          <Button
                            type="primary"
                            icon={<PlusOutlined />}
                            onClick={addVoiceDraftToComposer}
                          >
                            Add recording
                          </Button>
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="chat-recording-indicator">
                          <i />
                          <strong>
                            {voiceRecorderState === 'paused'
                              ? 'Recording paused'
                              : 'Recording voice'}
                          </strong>
                          <time>{recordingTime(voiceElapsedSeconds)}</time>
                        </span>
                        <span className="chat-voice-recorder-actions">
                          <Button
                            icon={
                              voiceRecorderState === 'paused' ? (
                                <PlayCircleOutlined />
                              ) : (
                                <PauseOutlined />
                              )
                            }
                            onClick={pauseOrResumeVoiceRecording}
                          >
                            {voiceRecorderState === 'paused' ? 'Resume' : 'Pause'}
                          </Button>
                          <Button
                            type="primary"
                            icon={<StopOutlined />}
                            onClick={stopVoiceRecording}
                          >
                            Stop
                          </Button>
                          <Button
                            type="text"
                            danger
                            icon={<CloseOutlined />}
                            aria-label="Cancel recording"
                            onClick={cancelVoiceRecording}
                          />
                        </span>
                      </>
                    )}
                  </div>
                ) : null}
                {pendingAttachments.length ? (
                  <DndContext
                    sensors={dndSensors}
                    collisionDetection={closestCenter}
                    onDragEnd={reorderPendingAttachment}
                  >
                    <SortableContext
                      items={pendingAttachments.map((item) => item.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="chat-attachment-drafts" aria-label="Pending attachments">
                        {pendingAttachments.map((item) => (
                          <SortableAttachmentDraft
                            id={item.id}
                            key={item.id}
                            disabled={isComposerSending}
                          >
                            <div
                              className={`chat-attachment-draft chat-attachment-draft-${item.status}`}
                            >
                              {item.previewUrl &&
                              (item.file.type === 'video/webm' ||
                                item.file.name.toLowerCase().endsWith('.webm')) ? (
                                <video src={item.previewUrl} autoPlay loop muted playsInline />
                              ) : item.previewUrl &&
                                !item.file.name.toLowerCase().endsWith('.tgs') ? (
                                <img src={item.previewUrl} alt={item.file.name} />
                              ) : (
                                <FileOutlined />
                              )}
                              <span>
                                <strong>{item.file.name}</strong>
                                <small>
                                  {item.kind} · {(item.file.size / 1024 / 1024).toFixed(2)} MB
                                  {item.status === 'failed' ? ' · Ready to retry' : ''}
                                  {item.status === 'failed' && item.operation?.caption
                                    ? ' · Caption locked'
                                    : ''}
                                </small>
                              </span>
                              <Button
                                size="small"
                                type="text"
                                icon={<CloseOutlined />}
                                className="chat-attachment-draft-remove"
                                onClick={() => removeAttachment(item.id)}
                                disabled={isComposerSending}
                                aria-label={`Remove ${item.file.name}`}
                              />
                            </div>
                          </SortableAttachmentDraft>
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                ) : null}
                {channel === 'telegram' &&
                supports('mediaGroups') &&
                pendingAttachments.length >= 2 &&
                pendingAttachments.length <= 10 &&
                (pendingAttachments.every((item) => ['PHOTO', 'VIDEO'].includes(item.kind)) ||
                  (new Set(pendingAttachments.map((item) => item.kind)).size === 1 &&
                    ['AUDIO', 'DOCUMENT'].includes(pendingAttachments[0]?.kind))) ? (
                  <label className="chat-media-spoiler-toggle">
                    <Switch
                      size="small"
                      checked={sendAsMediaGroup}
                      disabled={isComposerSending}
                      onChange={(checked) => {
                        setSendAsMediaGroup(checked);
                        if (!checked) mediaGroupClientRequestIdRef.current = null;
                      }}
                    />
                    Send as media group
                  </label>
                ) : null}
                {pendingAttachments.some((item) =>
                  ['PHOTO', 'VIDEO', 'ANIMATION'].includes(item.kind),
                ) &&
                channel === 'telegram' &&
                supports('mediaSpoilers') ? (
                  <label className="chat-media-spoiler-toggle">
                    <Switch
                      size="small"
                      checked={hasSpoiler}
                      disabled={
                        isComposerSending ||
                        pendingAttachments.some(
                          (item) =>
                            item.status === 'failed' && item.operation?.hasSpoiler !== undefined,
                        )
                      }
                      onChange={(checked) => setHasSpoiler(checked)}
                    />
                    Hide with spoiler
                  </label>
                ) : null}
                {(channel === 'telegram' || channel === 'whatsapp') &&
                voiceRecorderState === 'idle' &&
                composerMode === 'message' ? (
                  <div className="chat-format-toolbar">
                    {channel === 'whatsapp' || supports('formattingEntities') ? (
                      <>
                        {(channel === 'whatsapp'
                          ? [
                              ['bold', <BoldOutlined />, 'Bold'],
                              ['italic', <ItalicOutlined />, 'Italic'],
                              ['strikethrough', <StrikethroughOutlined />, 'Strikethrough'],
                              ['code', <CodeOutlined />, 'Monospace'],
                            ]
                          : [
                              ['bold', <BoldOutlined />, 'Bold'],
                              ['italic', <ItalicOutlined />, 'Italic'],
                              ['underline', <UnderlineOutlined />, 'Underline'],
                              ['strikethrough', <StrikethroughOutlined />, 'Strikethrough'],
                              ['code', <CodeOutlined />, 'Code'],
                              ['spoiler', <EyeInvisibleOutlined />, 'Spoiler'],
                            ]
                        ).map(([format, icon, label]) => (
                          <Button
                            key={format}
                            type={
                              channel === 'whatsapp'
                                ? isWhatsAppDraftFormatActive(format)
                                  ? 'primary'
                                  : 'text'
                                : isDraftFormatActive(format)
                                  ? 'primary'
                                  : 'text'
                            }
                            size="small"
                            icon={icon}
                            aria-label={label}
                            className={`chat-format-${format}`}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() =>
                              channel === 'whatsapp'
                                ? toggleWhatsAppDraftFormat(format)
                                : toggleDraftFormat(format)
                            }
                          />
                        ))}
                      </>
                    ) : null}
                    {channel === 'telegram' && supports('protectContent') ? (
                      <label className="chat-protect-toggle">
                        <Switch
                          size="small"
                          checked={protectContent}
                          onChange={(checked) => {
                            pendingClientRequestIdRef.current = null;
                            setProtectContent(checked);
                          }}
                        />
                        Protect
                      </label>
                    ) : null}
                    {channel === 'telegram' && !isTelegramConversationDisconnected ? (
                      <label className="chat-silent-toggle">
                        <Switch
                          size="small"
                          checked={disableNotification}
                          onChange={(checked) => {
                            pendingClientRequestIdRef.current = null;
                            setDisableNotification(checked);
                          }}
                        />
                        Silent
                      </label>
                    ) : null}
                    {channel === 'telegram' &&
                    supports('messageEffects') &&
                    availableMessageEffects.length ? (
                      <Popover
                        placement="topRight"
                        trigger="click"
                        content={
                          <div className="chat-effect-editor">
                            <strong>Message effect</strong>
                            <Select
                              allowClear
                              showSearch
                              optionFilterProp="label"
                              options={availableMessageEffects.map((effect) => ({
                                value: effect.id,
                                label: `${effect.emoji ? `${effect.emoji} ` : ''}${effect.label}`,
                              }))}
                              value={messageEffectId}
                              placeholder="Choose an effect"
                              onChange={(effectId) => {
                                pendingClientRequestIdRef.current = null;
                                setMessageEffectId(effectId ?? '');
                              }}
                            />
                            <small>Available effects are provided by Omnicus.</small>
                          </div>
                        }
                      >
                        <Button
                          type={messageEffectId ? 'primary' : 'text'}
                          size="small"
                          icon={<ThunderboltOutlined />}
                        >
                          Effect
                        </Button>
                      </Popover>
                    ) : null}
                    {channel === 'telegram' && supports('quote') && replyTarget ? (
                      <Popover
                        placement="topRight"
                        trigger="click"
                        content={
                          <div className="chat-advanced-option-editor">
                            <strong>Quote from replied message</strong>
                            <Input.TextArea
                              value={quoteText}
                              maxLength={1024}
                              autoSize={{ minRows: 2, maxRows: 5 }}
                              placeholder="Paste the exact excerpt to quote"
                              onChange={(event) => {
                                pendingClientRequestIdRef.current = null;
                                setQuoteText(event.target.value);
                              }}
                            />
                            <small>
                              The excerpt must exactly match the message you are replying to.
                            </small>
                          </div>
                        }
                      >
                        <Button
                          type={quoteText.trim() ? 'primary' : 'text'}
                          size="small"
                          icon={<RollbackOutlined />}
                        >
                          Quote
                        </Button>
                      </Popover>
                    ) : null}
                    {supports('linkPreviewOptions') ? (
                      <Popover
                        placement="topRight"
                        trigger="click"
                        content={
                          <div className="chat-advanced-option-editor chat-link-preview-editor">
                            <label className="chat-link-preview-switch">
                              <span>
                                <strong>Website card</strong>
                                <small>
                                  {isLinkPreviewEnabled
                                    ? `On - ${channel === 'whatsapp' ? 'WhatsApp' : 'Telegram'} will attach a card for the first link.`
                                    : `Off - ${channel === 'whatsapp' ? 'WhatsApp' : 'Telegram'} will send only the message text.`}
                                </small>
                              </span>
                              <Switch
                                size="small"
                                checked={isLinkPreviewEnabled}
                                onChange={(checked) => {
                                  pendingClientRequestIdRef.current = null;
                                  setLinkPreviewOptions(checked ? {} : { isDisabled: true });
                                }}
                              />
                            </label>
                            {isLinkPreviewEnabled ? (
                              channel === 'telegram' ? (
                                <div className="chat-link-preview-settings">
                                  <label>
                                    <span>
                                      Position
                                      <small>Place the card before or after the message.</small>
                                    </span>
                                    <Segmented
                                      block
                                      size="small"
                                      value={
                                        linkPreviewOptions.showAboveText
                                          ? 'Before message'
                                          : 'After message'
                                      }
                                      options={['Before message', 'After message']}
                                      onChange={(value) => {
                                        pendingClientRequestIdRef.current = null;
                                        setLinkPreviewOption(
                                          'showAboveText',
                                          value === 'Before message',
                                        );
                                      }}
                                    />
                                  </label>
                                  <details className="chat-link-preview-advanced">
                                    <summary>Advanced settings</summary>
                                    <div>
                                      <label>
                                        <span>
                                          Preview URL
                                          <small>
                                            Leave empty to use the first link from the message.
                                          </small>
                                        </span>
                                        <Input
                                          prefix={<LinkOutlined />}
                                          value={linkPreviewOptions.url ?? ''}
                                          placeholder="https://example.com"
                                          onChange={(event) => {
                                            pendingClientRequestIdRef.current = null;
                                            const url = event.target.value;
                                            setLinkPreviewOptions((current) => {
                                              const next = { ...current };
                                              if (url) next.url = url;
                                              else {
                                                delete next.url;
                                                delete next.preferSmallMedia;
                                                delete next.preferLargeMedia;
                                              }
                                              return next;
                                            });
                                          }}
                                        />
                                      </label>
                                      {linkPreviewOptions.url?.trim() ? (
                                        <label>
                                          <span>
                                            Image size
                                            <small>
                                              Telegram may ignore this if the website does not
                                              support both sizes.
                                            </small>
                                          </span>
                                          <Segmented
                                            block
                                            size="small"
                                            value={
                                              linkPreviewOptions.preferLargeMedia
                                                ? 'Large'
                                                : linkPreviewOptions.preferSmallMedia
                                                  ? 'Small'
                                                  : 'Default'
                                            }
                                            options={['Default', 'Small', 'Large']}
                                            onChange={(value) => {
                                              pendingClientRequestIdRef.current = null;
                                              setLinkPreviewOptions((current) => {
                                                const next = { ...current };
                                                delete next.preferSmallMedia;
                                                delete next.preferLargeMedia;
                                                return {
                                                  ...next,
                                                  ...(value === 'Small'
                                                    ? { preferSmallMedia: true }
                                                    : {}),
                                                  ...(value === 'Large'
                                                    ? { preferLargeMedia: true }
                                                    : {}),
                                                };
                                              });
                                            }}
                                          />
                                        </label>
                                      ) : null}
                                      {hasAdvancedLinkPreviewOptions ? (
                                        <Button
                                          size="small"
                                          onClick={() => {
                                            pendingClientRequestIdRef.current = null;
                                            setLinkPreviewOptions((current) => {
                                              const next = { ...current };
                                              delete next.url;
                                              delete next.preferSmallMedia;
                                              delete next.preferLargeMedia;
                                              return next;
                                            });
                                          }}
                                        >
                                          Reset advanced settings
                                        </Button>
                                      ) : null}
                                    </div>
                                  </details>
                                </div>
                              ) : (
                                <small className="chat-link-preview-disabled-note">
                                  WhatsApp will build the card from the first link in the message.
                                </small>
                              )
                            ) : (
                              <small className="chat-link-preview-disabled-note">
                                Website cards are disabled for this message.
                              </small>
                            )}
                          </div>
                        }
                      >
                        <Button
                          type={Object.keys(linkPreviewOptions).length ? 'primary' : 'text'}
                          size="small"
                          icon={<LinkOutlined />}
                        >
                          {isLinkPreviewEnabled ? 'Website card on' : 'Website card off'}
                        </Button>
                      </Popover>
                    ) : null}
                    {channel === 'telegram' && draftEntities.length ? (
                      <small>{draftEntities.length} format marks</small>
                    ) : channel === 'whatsapp' ? (
                      <small>WhatsApp formatting</small>
                    ) : null}
                  </div>
                ) : null}
                {voiceRecorderState === 'idle' &&
                composerMode === 'message' &&
                draft.trim() &&
                (draftEntities.length ||
                  protectContent ||
                  messageEffectId ||
                  hasRenderableLinkPreview ||
                  keyboardButtons.length) ? (
                  <section
                    className="chat-composer-live-preview"
                    aria-label="Message appearance preview"
                  >
                    <header>
                      <span>Message appearance</span>
                      <div>
                        {protectContent ? (
                          <small>
                            <EyeInvisibleOutlined /> Protected
                          </small>
                        ) : null}
                        {selectedMessageEffect ? (
                          <small>
                            {selectedMessageEffect.emoji ?? <ThunderboltOutlined />}{' '}
                            {selectedMessageEffect.label}
                          </small>
                        ) : null}
                        {disableNotification ? (
                          <small>
                            <BellOutlined /> Silent
                          </small>
                        ) : null}
                        {!isLinkPreviewEnabled ? (
                          <small>
                            <LinkOutlined /> Link preview off
                          </small>
                        ) : null}
                      </div>
                    </header>
                    <div className="chat-composer-preview-bubble">
                      {isLinkPreviewEnabled &&
                      linkPreviewOptions.showAboveText &&
                      draftPreviewUrl ? (
                        <span className={`chat-composer-preview-link ${linkPreviewSizeClass}`}>
                          <LinkOutlined /> {draftPreviewUrl}
                        </span>
                      ) : null}
                      <span>{renderFormattedMessage(draft, draftEntities)}</span>
                      {isLinkPreviewEnabled &&
                      !linkPreviewOptions.showAboveText &&
                      draftPreviewUrl ? (
                        <span className={`chat-composer-preview-link ${linkPreviewSizeClass}`}>
                          <LinkOutlined /> {draftPreviewUrl}
                        </span>
                      ) : null}
                      {buildInlineKeyboard(keyboardButtons)?.length ? (
                        <div className="chat-inline-keyboard-preview">
                          {buildInlineKeyboard(keyboardButtons)
                            ?.flat()
                            .map((button, index) => (
                              <span key={`${button.text}-${index}`}>{button.text}</span>
                            ))}
                        </div>
                      ) : null}
                    </div>
                  </section>
                ) : null}
                {voiceRecorderState === 'idle' ? (
                  composerMode === 'note' ? (
                    <Mentions
                      value={draft}
                      prefix="@"
                      split=" "
                      autoSize={{ minRows: 2, maxRows: 6 }}
                      maxLength={4096}
                      placeholder="Write an internal note. Type @ to mention a teammate"
                      options={(usersDirectoryQuery.data ?? []).map((user) => ({
                        key: user.id,
                        value: user.name,
                        label: `${user.name} · ${user.role}`,
                      }))}
                      onChange={(value) => {
                        setDraft(value);
                        const mentioned = (usersDirectoryQuery.data ?? [])
                          .filter((user) => value.includes(`@${user.name}`))
                          .map((user) => user.id);
                        setMentionedUserIds(mentioned);
                      }}
                      onSelect={(option) =>
                        setMentionedUserIds((current) => [
                          ...new Set([...current, String(option.key)]),
                        ])
                      }
                      onKeyDown={(event) => {
                        if (
                          shouldSubmitComposerKey({
                            key: event.key,
                            shiftKey: event.shiftKey,
                            isComposing: event.nativeEvent.isComposing,
                          })
                        ) {
                          event.preventDefault();
                          sendComposer();
                        }
                      }}
                      disabled={isComposerSending || noteMutation.isPending}
                    />
                  ) : (
                    <Input.TextArea
                      value={draft}
                      onChange={(event) => {
                        pendingClientRequestIdRef.current = null;
                        const nextDraft = event.target.value;
                        setDraftEntities((current) =>
                          current.filter(
                            (entity) =>
                              entity.offset + entity.length <= nextDraft.length &&
                              draft.slice(entity.offset, entity.offset + entity.length) ===
                                nextDraft.slice(entity.offset, entity.offset + entity.length),
                          ),
                        );
                        setDraft(nextDraft);
                        draftSelectionRef.current = {
                          start: event.target.selectionStart,
                          end: event.target.selectionEnd,
                        };
                        setDraftSelection({
                          start: event.target.selectionStart,
                          end: event.target.selectionEnd,
                        });
                      }}
                      onSelect={(event) => {
                        draftSelectionRef.current = {
                          start: event.currentTarget.selectionStart,
                          end: event.currentTarget.selectionEnd,
                        };
                        setDraftSelection({
                          start: event.currentTarget.selectionStart,
                          end: event.currentTarget.selectionEnd,
                        });
                      }}
                      onKeyDown={(event) => {
                        if (
                          shouldSubmitComposerKey({
                            key: event.key,
                            shiftKey: event.shiftKey,
                            isComposing: event.nativeEvent.isComposing,
                          })
                        ) {
                          event.preventDefault();
                          sendComposer();
                        }
                      }}
                      placeholder={
                        isConnected
                          ? channel === 'whatsapp' && !whatsAppFreeformAvailable
                            ? 'Use an approved template until the customer replies'
                            : `Message ${participantLabel}`
                          : `Connect the ${channelLabel} conversation first`
                      }
                      autoSize={{ minRows: 2, maxRows: 6 }}
                      maxLength={4096}
                      disabled={
                        !textOutboundAvailable ||
                        isComposerSending ||
                        hasFrozenCaptionFailure ||
                        expertMediaMutation.isPending ||
                        noteMutation.isPending
                      }
                    />
                  )
                ) : null}
                {voiceRecorderState === 'idle' ? (
                  <small
                    className={`chat-draft-storage-status chat-draft-storage-status-${draftStorageStatus}`}
                    aria-live="polite"
                  >
                    {draftStorageStatus === 'saving'
                      ? 'Saving draft…'
                      : draftStorageStatus === 'saved'
                        ? 'Draft saved for 24 hours'
                        : draftStorageStatus === 'failed'
                          ? 'Draft could not be saved'
                          : '\u00a0'}
                  </small>
                ) : null}
              </div>
              {voiceRecorderState === 'idle' ? (
                <div className="chat-composer-actions">
                  <div className="chat-composer-tools">
                    {composerMode === 'message' ? (
                      <>
                        <Dropdown
                          menu={attachmentMenu}
                          placement="topLeft"
                          trigger={['click']}
                          overlayClassName="chat-media-kind-dropdown"
                          disabled={
                            !isConnected ||
                            !mediaOutboundAvailable ||
                            keyboardButtons.length > 0 ||
                            isComposerSending ||
                            expertMediaMutation.isPending ||
                            isTelegramConversationDisconnected
                          }
                        >
                          <Button
                            icon={<PaperClipOutlined />}
                            className="chat-tool-button"
                            aria-label="Attach files"
                          >
                            Attach
                          </Button>
                        </Dropdown>
                        {channel === 'telegram' && supports('inlineKeyboard') ? (
                          <Button
                            icon={<AppstoreAddOutlined />}
                            className="chat-keyboard-trigger"
                            disabled={
                              !textOutboundAvailable ||
                              isComposerSending ||
                              pendingAttachments.length > 0 ||
                              isTelegramConversationDisconnected
                            }
                            onClick={() => setIsKeyboardEditorOpen(true)}
                          >
                            Buttons
                            {keyboardButtons.length ? ` ${keyboardButtons.length}` : ''}
                          </Button>
                        ) : null}
                        {channel === 'telegram' && supports('replyKeyboard') ? (
                          <Button
                            icon={<AppstoreAddOutlined />}
                            className="chat-tool-button"
                            disabled={
                              !textOutboundAvailable ||
                              isComposerSending ||
                              keyboardButtons.length > 0 ||
                              isTelegramConversationDisconnected
                            }
                            onClick={() => setIsReplyMarkupEditorOpen(true)}
                          >
                            {replyMarkup ? 'Reply UI ✓' : 'Reply UI'}
                          </Button>
                        ) : null}
                        {channel === 'telegram' && supports('richMessages') ? (
                          <Button
                            icon={<FileTextOutlined />}
                            className="chat-tool-button"
                            disabled={
                              !textOutboundAvailable ||
                              isComposerSending ||
                              sendMutation.isPending ||
                              isTelegramConversationDisconnected
                            }
                            onClick={() => setIsRichMessageOpen(true)}
                          >
                            Rich
                          </Button>
                        ) : null}
                        {supports('structuredMessages') ? (
                          <Button
                            icon={<AppstoreAddOutlined />}
                            className="chat-tool-button"
                            disabled={
                              !textOutboundAvailable ||
                              sendMutation.isPending ||
                              isComposerSending ||
                              isTelegramConversationDisconnected
                            }
                            onClick={() => setIsStructuredMessageOpen(true)}
                          >
                            {channel === 'whatsapp' ? 'Contact / Location' : 'Contact / Poll'}
                          </Button>
                        ) : null}
                        {channel === 'whatsapp' && supports('messageTemplates') ? (
                          <Button
                            icon={<FileTextOutlined />}
                            className="chat-tool-button"
                            disabled={
                              !channelOutboundAvailable ||
                              sendMutation.isPending ||
                              isTelegramConversationDisconnected
                            }
                            onClick={() => setIsWhatsAppTemplateOpen(true)}
                          >
                            Meta template
                          </Button>
                        ) : null}
                        {channel === 'whatsapp' && supports('interactiveMessages') ? (
                          <Button
                            icon={<AppstoreAddOutlined />}
                            className="chat-tool-button"
                            disabled={
                              !textOutboundAvailable ||
                              sendMutation.isPending ||
                              isTelegramConversationDisconnected
                            }
                            onClick={() => setIsWhatsAppInteractiveOpen(true)}
                          >
                            Buttons / List
                          </Button>
                        ) : null}
                        {(channel === 'telegram' || channel === 'whatsapp') &&
                        supports('scheduling') ? (
                          <Button
                            icon={<CalendarOutlined />}
                            className="chat-tool-button"
                            disabled={
                              !draft.trim() ||
                              (channel === 'whatsapp' && !textOutboundAvailable) ||
                              isComposerSending ||
                              isTelegramConversationDisconnected
                            }
                            onClick={openNewSchedule}
                          >
                            Schedule
                          </Button>
                        ) : null}
                      </>
                    ) : null}
                    <Popover
                      open={isQuickRepliesOpen}
                      onOpenChange={setIsQuickRepliesOpen}
                      placement="topLeft"
                      trigger="click"
                      content={
                        <div className="chat-quick-replies">
                          <div className="chat-quick-replies-header">
                            <strong>Quick replies</strong>
                            <Button
                              type="link"
                              size="small"
                              icon={<PlusOutlined />}
                              onClick={() => {
                                setEditingTemplateId(null);
                                setTemplateDraft({
                                  title: '',
                                  content: '',
                                  scope: 'PERSONAL',
                                });
                                setIsQuickRepliesOpen(false);
                                setIsTemplateEditorOpen(true);
                              }}
                            >
                              New
                            </Button>
                          </div>
                          <small className="chat-quick-replies-note">
                            {channel === 'whatsapp'
                              ? 'CRM text shortcuts. They send as regular messages and cannot reopen a closed 24-hour window.'
                              : 'CRM text shortcuts for regular messages.'}
                          </small>
                          <Input
                            allowClear
                            prefix={<SearchOutlined />}
                            placeholder="Search quick replies"
                            value={quickReplySearch}
                            onChange={(event) => setQuickReplySearch(event.target.value)}
                          />
                          <div className="chat-quick-reply-list">
                            {quickRepliesQuery.isLoading ? (
                              <Spin size="small" />
                            ) : quickReplies.length ? (
                              quickReplies.map((template) => (
                                <div className="chat-quick-reply-item" key={template._id}>
                                  <button type="button" onClick={() => applyQuickReply(template)}>
                                    <span>
                                      <strong>{template.title}</strong>
                                      <Tag bordered={false}>{template.scope}</Tag>
                                    </span>
                                    <small>{template.content}</small>
                                  </button>
                                  <Button
                                    type="text"
                                    size="small"
                                    icon={template.isFavorite ? <StarFilled /> : <StarOutlined />}
                                    className={template.isFavorite ? 'is-favorite' : ''}
                                    aria-label={
                                      template.isFavorite
                                        ? `Remove ${template.title} from favorites`
                                        : `Add ${template.title} to favorites`
                                    }
                                    loading={favoriteTemplateMutation.isPending}
                                    onClick={() =>
                                      favoriteTemplateMutation.mutate({
                                        templateId: template._id,
                                        favorite: !template.isFavorite,
                                      })
                                    }
                                  />
                                  {currentUser?.role === 'ADMIN' ||
                                  (template.scope === 'PERSONAL' &&
                                    template.ownerUserId === currentUser?.id) ? (
                                    <span className="chat-quick-reply-actions">
                                      <Button
                                        type="text"
                                        size="small"
                                        icon={<EditOutlined />}
                                        aria-label={`Edit ${template.title}`}
                                        onClick={() => {
                                          setEditingTemplateId(template._id);
                                          setTemplateDraft({
                                            title: template.title,
                                            content: template.content,
                                            scope: template.scope,
                                          });
                                          setIsQuickRepliesOpen(false);
                                          setIsTemplateEditorOpen(true);
                                        }}
                                      />
                                      <Button
                                        type="text"
                                        danger
                                        size="small"
                                        icon={<DeleteOutlined />}
                                        aria-label={`Delete ${template.title}`}
                                        loading={deleteTemplateMutation.isPending}
                                        onClick={() => deleteTemplateMutation.mutate(template._id)}
                                      />
                                    </span>
                                  ) : null}
                                </div>
                              ))
                            ) : (
                              <Typography.Text type="secondary">
                                No quick replies yet
                              </Typography.Text>
                            )}
                          </div>
                        </div>
                      }
                    >
                      <Button
                        icon={<FileTextOutlined />}
                        title="Quick replies"
                        aria-label="Quick replies"
                        disabled={isComposerSending || isTelegramConversationDisconnected}
                      />
                    </Popover>
                    <Button
                      type={composerMode === 'note' ? 'primary' : 'default'}
                      icon={<FileTextOutlined />}
                      className="chat-note-mode-button"
                      title="Internal note"
                      aria-label="Internal note"
                      disabled={
                        pendingAttachments.length > 0 ||
                        isComposerSending ||
                        isTelegramConversationDisconnected
                      }
                      onClick={() =>
                        setComposerMode((current) => (current === 'note' ? 'message' : 'note'))
                      }
                    />
                    <Popover
                      open={emojiPickerOpen}
                      onOpenChange={setEmojiPickerOpen}
                      placement="topLeft"
                      trigger="click"
                      content={
                        <div className="chat-emoji-picker">
                          <EmojiPicker
                            width={340}
                            height={420}
                            theme={Theme.LIGHT}
                            emojiStyle={EmojiStyle.NATIVE}
                            lazyLoadEmojis
                            searchPlaceholder="Search emoji"
                            previewConfig={{ showPreview: false }}
                            onEmojiClick={(emojiData) => insertEmoji(emojiData.emoji)}
                          />
                        </div>
                      }
                    >
                      <Button
                        icon={<SmileOutlined />}
                        disabled={
                          (composerMode === 'message' &&
                            (!isConnected ||
                              !textOutboundAvailable ||
                              isTelegramConversationDisconnected)) ||
                          isComposerSending ||
                          expertMediaMutation.isPending
                        }
                        title="Choose emoji"
                        aria-label="Choose emoji"
                      />
                    </Popover>
                  </div>
                  {composerMode === 'message' &&
                  (channel === 'telegram' || channel === 'whatsapp') &&
                  !draft.trim() &&
                  pendingAttachments.length === 0 ? (
                    <Button
                      type="primary"
                      icon={<AudioOutlined />}
                      className="chat-microphone-button"
                      aria-label="Record voice message"
                      title={
                        channel === 'whatsapp' && !whatsAppFreeformAvailable
                          ? 'WhatsApp voice messages require an open 24-hour service window'
                          : 'Record voice message'
                      }
                      disabled={
                        !textOutboundAvailable ||
                        isComposerSending ||
                        expertMediaMutation.isPending ||
                        (channel === 'telegram' && isTelegramConversationDisconnected)
                      }
                      onClick={() => void startVoiceRecording()}
                    />
                  ) : (
                    <Button
                      type="primary"
                      icon={composerMode === 'note' ? <FileTextOutlined /> : <SendOutlined />}
                      className={`chat-send-button${composerMode === 'note' ? ' chat-note-send-button' : ''}`}
                      onClick={sendComposer}
                      loading={isComposerSending || noteMutation.isPending}
                      disabled={
                        (composerMode === 'message' && !textOutboundAvailable) ||
                        !hasComposerContent(draft, pendingAttachments.length) ||
                        (composerMode === 'note' && pendingAttachments.length > 0) ||
                        isComposerSending ||
                        expertMediaMutation.isPending ||
                        isTelegramConversationDisconnected
                      }
                      title="Send composer"
                      aria-label="Send composer"
                    >
                      {composerMode === 'note' ? 'Add note' : 'Send'}
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>

      <Drawer
        open={isDetailsOpen}
        title="Conversation information"
        placement="right"
        width={440}
        zIndex={1100}
        className="chat-information-drawer"
        onClose={() => setIsDetailsOpen(false)}
      >
        <Tabs
          defaultActiveKey="contact"
          items={[
            {
              key: 'contact',
              label: 'Contact',
              children: (
                <div className="chat-drawer-section">
                  <div className="chat-drawer-contact">
                    <Avatar size={56}>{contactInitials(participantLabel)}</Avatar>
                    <span>
                      <strong>{participantLabel}</strong>
                      <small>
                        {conversation?.participant?.username
                          ? `@${conversation.participant.username}`
                          : `${channelLabel} contact`}
                      </small>
                    </span>
                  </div>
                  <Descriptions
                    size="small"
                    column={1}
                    items={[
                      {
                        key: 'channel',
                        label: 'Channel',
                        children: channelLabel,
                      },
                      {
                        key: 'status',
                        label: 'Connection',
                        children: isConnected ? 'Connected' : 'Not connected',
                      },
                      {
                        key: 'messages',
                        label: 'Messages',
                        children: messages.length,
                      },
                      {
                        key: 'unread',
                        label: 'Unread',
                        children: conversation?.unreadCount ?? 0,
                      },
                      {
                        key: 'lead-status',
                        label: 'Lead status',
                        children: workspaceQuery.data?.lead.status ?? '—',
                      },
                      {
                        key: 'work-folder',
                        label: 'Work folder',
                        children: workspaceQuery.data?.lead.workFolder ?? '—',
                      },
                      {
                        key: 'manager',
                        label: 'Manager',
                        children: workspaceQuery.data?.lead.manager?.name ?? 'Not assigned',
                      },
                      {
                        key: 'budget',
                        label: 'Budget',
                        children: workspaceQuery.data?.lead.budget ?? '—',
                      },
                      {
                        key: 'source',
                        label: 'Source',
                        children: workspaceQuery.data?.lead.source ?? '—',
                      },
                    ]}
                  />
                  <div className="chat-drawer-lead-summary">
                    <strong>Vehicle / offer</strong>
                    {workspaceQuery.data?.lead.car ? (
                      <Descriptions
                        size="small"
                        column={1}
                        items={[
                          {
                            key: 'car',
                            label: 'Vehicle',
                            children:
                              [
                                workspaceQuery.data.lead.car.brand,
                                workspaceQuery.data.lead.car.model,
                                workspaceQuery.data.lead.car.year,
                              ]
                                .filter(Boolean)
                                .join(' ') || '—',
                          },
                          {
                            key: 'vin',
                            label: 'VIN',
                            children: workspaceQuery.data.lead.car.vin ?? '—',
                          },
                          {
                            key: 'price',
                            label: 'Price',
                            children: workspaceQuery.data.lead.car.price ?? '—',
                          },
                          {
                            key: 'mileage',
                            label: 'Mileage',
                            children: workspaceQuery.data.lead.car.mileage ?? '—',
                          },
                        ]}
                      />
                    ) : (
                      <Typography.Text type="secondary">No vehicle selected yet</Typography.Text>
                    )}
                  </div>
                </div>
              ),
            },
            {
              key: 'media',
              label: `Media ${mediaMessages.length || ''}`,
              children: mediaMessages.length ? (
                <div className="chat-drawer-media-grid">
                  {mediaMessages.map((item) =>
                    item.attachment?.url ? (
                      <a key={item._id} href={item.attachment.url} target="_blank" rel="noreferrer">
                        {item.attachment.kind === 'PHOTO' ? (
                          <img src={item.attachment.url} alt={item.attachment.fileName} />
                        ) : (
                          <span>
                            <PictureOutlined />
                            {item.attachment.kind}
                          </span>
                        )}
                      </a>
                    ) : (
                      <span className="chat-drawer-unavailable" key={item._id}>
                        <PictureOutlined />
                        Media unavailable
                      </span>
                    ),
                  )}
                </div>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No media" />
              ),
            },
            {
              key: 'files',
              label: `Files ${fileMessages.length || ''}`,
              children: fileMessages.length ? (
                <div className="chat-drawer-list">
                  {fileMessages.map((item) => (
                    <a
                      key={item._id}
                      href={item.attachment?.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-disabled={!item.attachment?.url}
                    >
                      <FileOutlined />
                      <span>
                        <strong>{item.attachment?.fileName}</strong>
                        <small>{item.attachment?.kind ?? 'FILE'}</small>
                      </span>
                    </a>
                  ))}
                </div>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No files" />
              ),
            },
            {
              key: 'links',
              label: `Links ${conversationLinks.length || ''}`,
              children: conversationLinks.length ? (
                <div className="chat-drawer-list">
                  {conversationLinks.map((url) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer">
                      <LinkOutlined />
                      <span>
                        <strong>{url}</strong>
                        <small>Open in a new tab</small>
                      </span>
                    </a>
                  ))}
                </div>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No links" />
              ),
            },
            {
              key: 'notes',
              label: `Notes ${internalNotes.length || ''}`,
              children: internalNotes.length ? (
                <div className="chat-internal-notes-list">
                  {internalNotes.map((note) => (
                    <article key={note._id}>
                      <header>
                        <strong>{note.authorName}</strong>
                        <time>
                          {note.createdAt ? new Date(note.createdAt).toLocaleString() : ''}
                        </time>
                      </header>
                      <p>{note.text}</p>
                      <small>Internal note · not sent to the client</small>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No internal notes" />
              ),
            },
            {
              key: 'automations',
              label: 'Automations',
              children: (
                <div className="chat-drawer-section">
                  <div className="chat-drawer-callout">
                    <RobotOutlined />
                    <span>
                      <strong>{automationMessages.length} automation messages</strong>
                      <small>
                        Provider-generated messages already visible in this conversation.
                      </small>
                    </span>
                  </div>
                  {supports('automationManualMode') ? (
                    <div className="chat-automation-mode">
                      <span>
                        <strong>Automation mode</strong>
                        <small>
                          AUTO lets Omnicus scenarios respond. MANUAL leaves the conversation with
                          the CRM manager.
                        </small>
                      </span>
                      <Segmented
                        value={automationStateQuery.data?.mode ?? 'AUTO'}
                        options={[
                          { label: 'Auto', value: 'AUTO' },
                          { label: 'Manual', value: 'MANUAL' },
                          ...(supports('automationPausedMode')
                            ? [{ label: 'Paused', value: 'PAUSED' }]
                            : []),
                        ]}
                        disabled={automationStateQuery.isLoading || automationMutation.isPending}
                        onChange={(mode) =>
                          automationMutation.mutate(
                            mode === 'PAUSED'
                              ? {
                                  mode,
                                  resumeAt:
                                    (automationResumeAt
                                      ? new Date(automationResumeAt).toISOString()
                                      : undefined) ||
                                    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                                }
                              : { mode: mode },
                          )
                        }
                      />
                      {supports('automationPausedMode') ? (
                        <DatePicker
                          allowClear
                          aria-label="Resume automation at"
                          className="chat-date-time-picker"
                          disabledDate={(value) => disableDatesBefore(value, minimumScheduleTime)}
                          disabledTime={(value) => disableTimesBefore(value, minimumScheduleTime)}
                          format="DD MMM YYYY, HH:mm"
                          minDate={dayjs(minimumScheduleTime)}
                          placeholder="Choose resume date and time"
                          showTime={{
                            defaultOpenValue: nextFiveMinuteStep(minimumScheduleTime),
                            format: 'HH:mm',
                            minuteStep: 5,
                          }}
                          value={automationResumeAt ? dayjs(automationResumeAt) : null}
                          onChange={(value) =>
                            setAutomationResumeAt(value?.format('YYYY-MM-DDTHH:mm') ?? '')
                          }
                        />
                      ) : null}
                    </div>
                  ) : (
                    <Typography.Text type="secondary">
                      Automation mode is unavailable for this connection.
                    </Typography.Text>
                  )}
                  {channel === 'telegram' && supports('botInterface') ? (
                    <div className="chat-automation-mode">
                      <span>
                        <strong>Bot menu</strong>
                        <small>
                          {botInterfaceQuery.data?.commands.length ?? 0} commands configured for
                          this Telegram connection.
                        </small>
                      </span>
                      <Button
                        icon={<SettingOutlined />}
                        disabled={currentUser?.role !== 'ADMIN' || botInterfaceQuery.isLoading}
                        onClick={() => {
                          setBotCommandsDraft(
                            (botInterfaceQuery.data?.commands ?? [])
                              .map((command) => `/${command.command} - ${command.description}`)
                              .join('\n'),
                          );
                          const currentType = botInterfaceQuery.data?.menuButton.type;
                          setBotMenuType(currentType === 'default' ? 'default' : 'commands');
                          setIsBotInterfaceOpen(true);
                        }}
                      >
                        Configure
                      </Button>
                    </div>
                  ) : null}
                </div>
              ),
            },
            {
              key: 'technical',
              label: 'Technical',
              children: (
                <Descriptions
                  size="small"
                  column={1}
                  className="chat-technical-details"
                  items={[
                    {
                      key: 'transport',
                      label: 'Transport',
                      children: conversation?.transport ?? '—',
                    },
                    {
                      key: 'contract-version',
                      label: 'Omnicus contract',
                      children: capabilitiesQuery.data?.contractVersion ?? 'Unavailable',
                    },
                    {
                      key: 'telegram-api-version',
                      label: channel === 'whatsapp' ? 'WhatsApp Cloud API' : 'Telegram Bot API',
                      children:
                        capabilitiesQuery.data?.providerApiVersion ??
                        capabilitiesQuery.data?.telegramBotApiVersion ??
                        'Unavailable',
                    },
                    {
                      key: 'crm-project',
                      label: 'CRM project',
                      children: conversation?.crmProjectId ?? '—',
                    },
                    {
                      key: 'omnicus-project',
                      label: 'Omnicus project',
                      children: conversation?.omnicusProjectId ?? '—',
                    },
                    {
                      key: 'contact-id',
                      label: 'Contact ID',
                      children: conversation?.omnicusContactId ?? '—',
                    },
                    {
                      key: 'connection-id',
                      label: 'Connection ID',
                      children: conversation?.omnicusConnectionId ?? '—',
                    },
                    {
                      key: 'identity-id',
                      label: 'Channel identity',
                      children: conversation?.omnicusChannelIdentityId ?? '—',
                    },
                  ]}
                />
              ),
            },
          ]}
        />
      </Drawer>

      <Modal
        open={Boolean(editingMessage)}
        title={`Edit ${channelLabel} message`}
        width={560}
        centered
        destroyOnHidden
        okText="Save changes"
        confirmLoading={providerMutation.isPending}
        okButtonProps={{ disabled: !editDraft.trim() }}
        onOk={submitMessageEdit}
        onCancel={() => {
          setEditingMessage(null);
          setEditDraft('');
          setEditEntities([]);
        }}
      >
        <div className="chat-edit-message-modal">
          <Input.TextArea
            value={editDraft}
            autoSize={{ minRows: 4, maxRows: 10 }}
            maxLength={4096}
            onChange={(event) => setEditDraft(event.target.value)}
          />
          {editDraft.trim() ? (
            <div className="chat-edit-format-preview">
              <small>Formatting preview</small>
              <div>{renderFormattedMessage(editDraft, editEntities)}</div>
            </div>
          ) : null}
          <Typography.Text type="secondary">
            The edit is queued and shown in CRM only after Omnicus reconciliation.
          </Typography.Text>
        </div>
      </Modal>

      <Modal
        open={isTemplateEditorOpen}
        title={editingTemplateId ? 'Edit quick reply' : 'New quick reply'}
        width={560}
        centered
        className="chat-template-modal"
        onCancel={() => {
          setIsTemplateEditorOpen(false);
          setEditingTemplateId(null);
          setTemplateDraft({ title: '', content: '', scope: 'PERSONAL' });
        }}
        footer={
          <>
            <Button onClick={() => setIsTemplateEditorOpen(false)}>Cancel</Button>
            <Button
              type="primary"
              loading={createTemplateMutation.isPending || updateTemplateMutation.isPending}
              disabled={!templateDraft.title.trim() || !templateDraft.content.trim()}
              onClick={() =>
                editingTemplateId
                  ? updateTemplateMutation.mutate(templateDraft)
                  : createTemplateMutation.mutate(templateDraft)
              }
            >
              {editingTemplateId ? 'Save changes' : 'Save quick reply'}
            </Button>
          </>
        }
      >
        <div className="chat-template-editor">
          <label>
            <span>Name</span>
            <Input
              maxLength={100}
              value={templateDraft.title}
              placeholder="For example: First response"
              onChange={(event) =>
                setTemplateDraft((current) => ({
                  ...current,
                  title: event.target.value,
                }))
              }
            />
          </label>
          <label>
            <span>Visibility</span>
            <Segmented
              block
              value={templateDraft.scope}
              options={[
                { value: 'PERSONAL', label: 'Personal' },
                {
                  value: 'TEAM',
                  label: 'Team',
                  disabled: currentUser?.role !== 'ADMIN',
                },
              ]}
              onChange={(scope) =>
                setTemplateDraft((current) => ({
                  ...current,
                  scope: scope,
                }))
              }
            />
          </label>
          <label>
            <span>Message</span>
            <Input.TextArea
              autoSize={{ minRows: 5, maxRows: 10 }}
              maxLength={4096}
              value={templateDraft.content}
              placeholder="Write the reusable message"
              onChange={(event) =>
                setTemplateDraft((current) => ({
                  ...current,
                  content: event.target.value,
                }))
              }
            />
          </label>
          <div className="chat-template-variables">
            <Typography.Text type="secondary">
              Insert an available CRM variable. Missing values are highlighted before the message
              can be sent.
            </Typography.Text>
            <div>
              {(
                workspaceQuery.data?.variableKeys ?? ['client.name', 'client.username', 'lead.id']
              ).map((key) => (
                <Button
                  size="small"
                  key={key}
                  onClick={() =>
                    setTemplateDraft((current) => ({
                      ...current,
                      content: `${current.content}${current.content ? ' ' : ''}{{${key}}}`,
                    }))
                  }
                >
                  {`{{${key}}}`}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        open={Boolean(editingNote)}
        title="Edit internal note"
        centered
        width={560}
        okText="Save changes"
        confirmLoading={updateNoteMutation.isPending}
        okButtonProps={{ disabled: !editingNoteText.trim() }}
        onOk={() =>
          editingNote &&
          updateNoteMutation.mutate({
            noteId: editingNote._id,
            text: editingNoteText.trim(),
            mentionedUserIds: editingNoteMentionedUserIds,
          })
        }
        onCancel={() => {
          setEditingNote(null);
          setEditingNoteText('');
          setEditingNoteMentionedUserIds([]);
        }}
      >
        <Mentions
          value={editingNoteText}
          prefix="@"
          split=" "
          options={(usersDirectoryQuery.data ?? []).map((user) => ({
            key: user.id,
            value: user.name,
            label: `${user.name} В· ${user.role}`,
          }))}
          maxLength={5000}
          autoSize={{ minRows: 5, maxRows: 12 }}
          placeholder="Edit the note. Type @ to mention a teammate"
          onChange={(value) => {
            setEditingNoteText(value);
            setEditingNoteMentionedUserIds(
              (usersDirectoryQuery.data ?? [])
                .filter((user) => value.includes(`@${user.name}`))
                .map((user) => user.id),
            );
          }}
          onSelect={(option) =>
            setEditingNoteMentionedUserIds((current) => [
              ...new Set([...current, String(option.key)]),
            ])
          }
        />
        <Typography.Text type="secondary">
          Internal notes remain visible only to CRM team members.
        </Typography.Text>
      </Modal>

      <Modal
        open={isReplyMarkupEditorOpen}
        title="Telegram reply interface"
        centered
        width={560}
        okText="Use for next message"
        onOk={applyReplyMarkup}
        onCancel={() => setIsReplyMarkupEditorOpen(false)}
        footer={(_, { OkBtn, CancelBtn }) => (
          <>
            <Button
              onClick={() => {
                setReplyMarkup(undefined);
                setIsReplyMarkupEditorOpen(false);
              }}
            >
              Clear
            </Button>
            <CancelBtn />
            <OkBtn />
          </>
        )}
      >
        <div className="chat-structured-editor">
          <Segmented
            block
            value={replyMarkupMode}
            options={[
              { label: 'Reply keyboard', value: 'keyboard' },
              { label: 'Force Reply', value: 'force' },
              { label: 'Remove keyboard', value: 'remove' },
            ]}
            onChange={(value) => setReplyMarkupMode(value)}
          />
          {replyMarkupMode === 'keyboard' ? (
            <>
              <Typography.Text type="secondary">
                One button per line. Prefix with contact: or location: to request that value from
                the Telegram user.
              </Typography.Text>
              <Input.TextArea
                autoSize={{ minRows: 4, maxRows: 8 }}
                value={replyKeyboardDraft}
                placeholder={'Yes\nNo\ncontact:Share contact\nlocation:Share location'}
                onChange={(event) => setReplyKeyboardDraft(event.target.value)}
              />
              <label>
                <Switch checked={replyKeyboardPersistent} onChange={setReplyKeyboardPersistent} />{' '}
                Persistent keyboard
              </label>
              <label>
                <Switch checked={replyKeyboardOneTime} onChange={setReplyKeyboardOneTime} /> Hide
                after one use
              </label>
            </>
          ) : null}
          {replyMarkupMode !== 'remove' ? (
            <Input
              maxLength={64}
              value={replyInputPlaceholder}
              placeholder="Input placeholder (optional)"
              onChange={(event) => setReplyInputPlaceholder(event.target.value)}
            />
          ) : null}
        </div>
      </Modal>

      <Modal
        open={isRichMessageOpen}
        title="Telegram rich message"
        centered
        width={860}
        okText="Send rich message"
        confirmLoading={sendMutation.isPending}
        okButtonProps={{ disabled: !richMessageDraft.trim() }}
        onOk={() => void sendRichMessage()}
        onCancel={() => setIsRichMessageOpen(false)}
      >
        <RichMessageComposer value={richMessageDraft} onChange={setRichMessageDraft} />
      </Modal>

      <Modal
        open={isBotInterfaceOpen}
        title="Telegram bot menu"
        centered
        width={600}
        okText="Apply"
        confirmLoading={botInterfaceMutation.isPending}
        onOk={() => botInterfaceMutation.mutate()}
        onCancel={() => setIsBotInterfaceOpen(false)}
      >
        <div className="chat-structured-editor">
          <Typography.Text type="secondary">
            One command per line: /command - Description. Changes are queued through Omnicus and
            apply to this connection.
          </Typography.Text>
          <Input.TextArea
            value={botCommandsDraft}
            autoSize={{ minRows: 6, maxRows: 14 }}
            placeholder="/start - Start conversation"
            onChange={(event) => setBotCommandsDraft(event.target.value)}
          />
          <Segmented
            block
            value={botMenuType}
            options={[
              { label: 'Commands menu', value: 'commands' },
              { label: 'Telegram default', value: 'default' },
            ]}
            onChange={(value) => setBotMenuType(value)}
          />
        </div>
      </Modal>

      <Modal
        open={isScheduleOpen}
        title={editingSchedule ? 'Edit scheduled delivery' : `Schedule ${channelLabel} message`}
        centered
        width={480}
        okText={editingSchedule ? 'Save changes' : 'Schedule'}
        confirmLoading={Boolean(scheduleActionId)}
        okButtonProps={{
          disabled:
            !scheduledAt ||
            (!editingSchedule && !draft.trim()) ||
            isWhatsAppScheduleTimeOutsideWindow,
        }}
        onOk={() => void scheduleCurrentMessage()}
        onCancel={resetScheduleEditor}
      >
        <div className="chat-structured-editor">
          <Typography.Text type="secondary">
            {channel === 'whatsapp'
              ? 'WhatsApp messages can be scheduled once, before the current 24-hour service window closes.'
              : 'The first occurrence uses your local timezone. Recurring schedules keep the same local wall-clock time across daylight-saving changes.'}
          </Typography.Text>
          <DatePicker
            allowClear
            className="chat-date-time-picker"
            disabledDate={(value) => disableDatesBefore(value, minimumScheduleTime)}
            disabledTime={(value) => disableTimesBefore(value, minimumScheduleTime)}
            format="DD MMM YYYY, HH:mm"
            minDate={dayjs(minimumScheduleTime)}
            maxDate={whatsAppScheduleExpiresAt ? dayjs(whatsAppScheduleExpiresAt) : undefined}
            placeholder="Choose delivery date and time"
            showTime={{
              defaultOpenValue: nextFiveMinuteStep(minimumScheduleTime),
              format: 'HH:mm',
              minuteStep: 5,
            }}
            value={scheduledAt ? dayjs(scheduledAt) : null}
            onChange={(value) => setScheduledAt(value?.format('YYYY-MM-DDTHH:mm') ?? '')}
          />
          {channel === 'telegram' ? (
            <Segmented
              block
              value={scheduleMode}
              options={[
                { label: 'Once', value: 'once' },
                { label: 'Daily', value: 'daily' },
                { label: 'Weekly', value: 'weekly' },
              ]}
              onChange={(value) => setScheduleMode(value)}
            />
          ) : null}
          {channel === 'telegram' && scheduleMode !== 'once' ? (
            <>
              <label>
                Repeat every
                <Input
                  type="number"
                  min={1}
                  max={30}
                  value={scheduleInterval}
                  onChange={(event) =>
                    setScheduleInterval(Math.min(30, Math.max(1, Number(event.target.value) || 1)))
                  }
                />
                {scheduleMode === 'daily' ? 'day(s)' : 'week(s)'}
              </label>
              <label>
                Total occurrences
                <Input
                  type="number"
                  min={2}
                  max={1000}
                  value={scheduleCount}
                  onChange={(event) =>
                    setScheduleCount(Math.min(1000, Math.max(2, Number(event.target.value) || 2)))
                  }
                />
              </label>
            </>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={isWhatsAppTemplateOpen}
        title="Send an approved Meta WhatsApp template"
        centered
        width={720}
        okText="Send Meta template"
        confirmLoading={isSendingWhatsAppTemplate}
        okButtonProps={{
          disabled:
            !selectedWhatsAppTemplate ||
            Boolean(selectedWhatsAppTemplateUnsupportedReason) ||
            (selectedWhatsAppTemplateNeedsMedia && !whatsAppTemplateMedia) ||
            selectedWhatsAppTemplateFields.some(
              (field) => !whatsAppTemplateValues[field.key]?.trim(),
            ),
        }}
        onOk={() => void sendWhatsAppTemplate()}
        onCancel={() => {
          setIsWhatsAppTemplateOpen(false);
          setSelectedWhatsAppTemplateId('');
          setWhatsAppTemplateValues({});
          setWhatsAppTemplateMedia(null);
        }}
      >
        <div className="chat-whatsapp-template-editor">
          <div className="chat-editor-intro">
            <WhatsAppOutlined />
            <span>
              <strong>Start or reopen a WhatsApp conversation</strong>
              <small>
                Only templates approved for this WhatsApp Business account are shown. A manager can
                send one even when the 24-hour customer-service window is closed.
              </small>
            </span>
          </div>
          <div className="chat-whatsapp-template-billing-note" role="note">
            <InfoCircleOutlined />
            <span>
              <strong>Meta may charge for this template message</strong>
              <small>
                Meta bills the connected WhatsApp Business account under its current rates, which
                can vary by template category and recipient market. CRM does not add a messaging
                fee, keep a balance, or store payment details.
              </small>
            </span>
          </div>
          {whatsAppTemplatesQuery.isLoading ? (
            <div className="chat-whatsapp-template-loading">
              <Spin size="small" /> Loading approved templates…
            </div>
          ) : whatsAppTemplatesQuery.isError ? (
            <Alert
              type="error"
              showIcon
              message="Approved templates could not be loaded"
              description={getFriendlyErrorMessage(
                whatsAppTemplatesQuery.error,
                'Check the WhatsApp connection and try again.',
              )}
            />
          ) : whatsAppTemplates.length ? (
            <>
              <label>
                <span className="chat-whatsapp-template-picker-heading">
                  Approved Meta template
                  <Button
                    icon={<ReloadOutlined />}
                    loading={whatsAppTemplatesQuery.isFetching}
                    onClick={() => void whatsAppTemplatesQuery.refetch()}
                    size="small"
                    type="link"
                  >
                    Refresh list
                  </Button>
                </span>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="Choose an approved Meta template"
                  value={selectedWhatsAppTemplateId || undefined}
                  options={whatsAppTemplates.map((template) => {
                    const unsupportedReason = whatsAppTemplateUnsupportedReason(template);
                    return {
                      value: template.id,
                      label: `${template.name} · ${template.languageCode} · ${template.category}${unsupportedReason ? ` · ${unsupportedReason}` : ''}`,
                      disabled: Boolean(unsupportedReason),
                    };
                  })}
                  onChange={(templateId) => {
                    setSelectedWhatsAppTemplateId(templateId);
                    setWhatsAppTemplateValues({});
                    setWhatsAppTemplateMedia(null);
                  }}
                />
                <small className="chat-whatsapp-template-sync-note">
                  This list contains templates synchronized from Meta through Omnicus. If a newly
                  approved template is missing, synchronize it in Omnicus and refresh the list here.
                </small>
              </label>
              {selectedWhatsAppTemplate ? (
                <div className="chat-whatsapp-template-card">
                  <header>
                    <span>
                      <strong>{selectedWhatsAppTemplate.name}</strong>
                      <small>{selectedWhatsAppTemplate.languageCode}</small>
                    </span>
                    <Tag bordered={false} color="green">
                      Approved
                    </Tag>
                  </header>
                  <div className="chat-whatsapp-template-preview">
                    {selectedWhatsAppTemplate.components.map((component, componentIndex) =>
                      component.text ? (
                        <span
                          className={`is-${component.type.toLowerCase()}`}
                          key={`${component.type}-${componentIndex}`}
                        >
                          {whatsAppTemplatePreview(
                            component.text,
                            componentIndex,
                            whatsAppTemplateValues,
                          )}
                        </span>
                      ) : component.type === 'BUTTONS' && component.buttons?.length ? (
                        <div
                          className="chat-whatsapp-template-buttons"
                          key={`${component.type}-${componentIndex}`}
                        >
                          {component.buttons.map((button, buttonIndex) => (
                            <span key={`${button.type}-${buttonIndex}`}>{button.text}</span>
                          ))}
                        </div>
                      ) : null,
                    )}
                  </div>
                  {selectedWhatsAppTemplateFields.length ? (
                    <div className="chat-whatsapp-template-fields">
                      {selectedWhatsAppTemplateFields.map((field) => (
                        <label key={field.key}>
                          <span>{field.label}</span>
                          <Input
                            value={whatsAppTemplateValues[field.key] ?? ''}
                            maxLength={field.kind === 'quick_reply' ? 256 : 4096}
                            placeholder={field.placeholder}
                            onChange={(event) =>
                              setWhatsAppTemplateValues((current) => ({
                                ...current,
                                [field.key]: event.target.value,
                              }))
                            }
                          />
                        </label>
                      ))}
                    </div>
                  ) : null}
                  {selectedWhatsAppTemplateNeedsMedia ? (
                    <label className="chat-whatsapp-template-media">
                      <span>
                        Header file
                        <small>
                          Required{' '}
                          {selectedWhatsAppTemplateMediaHeader?.component.format?.toLowerCase()}
                        </small>
                      </span>
                      <input
                        type="file"
                        accept={
                          selectedWhatsAppTemplateMediaHeader?.component.format === 'IMAGE'
                            ? 'image/jpeg,image/png'
                            : selectedWhatsAppTemplateMediaHeader?.component.format === 'VIDEO'
                              ? 'video/mp4,video/3gpp'
                              : undefined
                        }
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          setWhatsAppTemplateMedia(
                            file
                              ? {
                                  file,
                                  clientRequestId: crypto.randomUUID(),
                                }
                              : null,
                          );
                        }}
                      />
                      {whatsAppTemplateMedia ? (
                        <small className="chat-whatsapp-template-media-file">
                          <FileOutlined /> {whatsAppTemplateMedia.file.name} ·{' '}
                          {(whatsAppTemplateMedia.file.size / 1024 / 1024).toFixed(2)} MB
                        </small>
                      ) : null}
                    </label>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No approved WhatsApp templates are available"
            />
          )}
        </div>
      </Modal>

      <Modal
        open={isWhatsAppInteractiveOpen}
        title="Create an interactive WhatsApp message"
        centered
        width={680}
        okText="Send"
        confirmLoading={sendMutation.isPending || isSendingWhatsAppInteractive}
        okButtonProps={{
          disabled:
            !whatsAppInteractiveDraft.body.trim() ||
            !whatsAppInteractiveDraft.options.trim() ||
            (whatsAppInteractiveDraft.type === 'button' &&
              whatsAppInteractiveDraft.headerType !== 'text' &&
              !whatsAppInteractiveMedia),
        }}
        onOk={() => void sendWhatsAppInteractive()}
        onCancel={() => setIsWhatsAppInteractiveOpen(false)}
      >
        <div className="chat-whatsapp-interactive-editor">
          <Segmented
            block
            value={whatsAppInteractiveDraft.type}
            options={[
              { label: 'Reply buttons', value: 'button' },
              { label: 'Option list', value: 'list' },
            ]}
            onChange={(type) =>
              setWhatsAppInteractiveDraft((current) => {
                const nextType = type;
                if (nextType === 'list') setWhatsAppInteractiveMedia(null);
                return {
                  ...current,
                  type: nextType,
                  headerType: nextType === 'list' ? 'text' : current.headerType,
                  options: '',
                };
              })
            }
          />
          {whatsAppInteractiveDraft.type === 'button' ? (
            <label>
              <span>
                Header <small>Optional</small>
              </span>
              <Select
                value={whatsAppInteractiveDraft.headerType}
                options={[
                  { label: 'Text', value: 'text' },
                  { label: 'Image', value: 'image' },
                  { label: 'Video', value: 'video' },
                  { label: 'Document', value: 'document' },
                ]}
                onChange={(headerType) => {
                  setWhatsAppInteractiveDraft((current) => ({
                    ...current,
                    headerType,
                    header: headerType === 'text' ? current.header : '',
                  }));
                  if (headerType === 'text') setWhatsAppInteractiveMedia(null);
                }}
              />
            </label>
          ) : null}
          {whatsAppInteractiveDraft.headerType === 'text' ? (
            <label>
              <span>
                Heading <small>Optional</small>
              </span>
              <Input
                maxLength={60}
                value={whatsAppInteractiveDraft.header}
                placeholder="Short heading"
                onChange={(event) =>
                  setWhatsAppInteractiveDraft((current) => ({
                    ...current,
                    header: event.target.value,
                  }))
                }
              />
            </label>
          ) : (
            <label className="chat-whatsapp-template-media-field">
              <span>Header file</span>
              <input
                type="file"
                accept={
                  whatsAppInteractiveDraft.headerType === 'image'
                    ? 'image/jpeg,image/png'
                    : whatsAppInteractiveDraft.headerType === 'video'
                      ? 'video/mp4,video/3gpp'
                      : '.txt,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx'
                }
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  setWhatsAppInteractiveMedia(
                    file ? { file, clientRequestId: crypto.randomUUID() } : null,
                  );
                }}
              />
              {whatsAppInteractiveMedia ? (
                <small className="chat-whatsapp-template-media-file">
                  <FileOutlined /> {whatsAppInteractiveMedia.file.name}
                </small>
              ) : null}
            </label>
          )}
          <label>
            <span>Message</span>
            <Input.TextArea
              maxLength={1024}
              autoSize={{ minRows: 3, maxRows: 7 }}
              value={whatsAppInteractiveDraft.body}
              placeholder="Explain what the customer should choose"
              onChange={(event) =>
                setWhatsAppInteractiveDraft((current) => ({
                  ...current,
                  body: event.target.value,
                }))
              }
            />
          </label>
          {whatsAppInteractiveDraft.type === 'list' ? (
            <div className="chat-whatsapp-interactive-row">
              <label>
                <span>Open-list button</span>
                <Input
                  maxLength={20}
                  value={whatsAppInteractiveDraft.actionLabel}
                  onChange={(event) =>
                    setWhatsAppInteractiveDraft((current) => ({
                      ...current,
                      actionLabel: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                <span>
                  Section title <small>Optional</small>
                </span>
                <Input
                  maxLength={24}
                  value={whatsAppInteractiveDraft.sectionTitle}
                  onChange={(event) =>
                    setWhatsAppInteractiveDraft((current) => ({
                      ...current,
                      sectionTitle: event.target.value,
                    }))
                  }
                />
              </label>
            </div>
          ) : null}
          <label>
            <span>
              {whatsAppInteractiveDraft.type === 'button' ? 'Buttons' : 'List options'}
              <small>
                One per line: title | optional ID
                {whatsAppInteractiveDraft.type === 'list' ? ' | optional description' : ''}
              </small>
            </span>
            <Input.TextArea
              autoSize={{ minRows: 4, maxRows: 10 }}
              value={whatsAppInteractiveDraft.options}
              placeholder={
                whatsAppInteractiveDraft.type === 'button'
                  ? 'Yes | yes\nNo | no'
                  : 'Standard delivery | standard | 3–5 business days'
              }
              onChange={(event) =>
                setWhatsAppInteractiveDraft((current) => ({
                  ...current,
                  options: event.target.value,
                }))
              }
            />
          </label>
          <label>
            <span>
              Footer <small>Optional</small>
            </span>
            <Input
              maxLength={60}
              value={whatsAppInteractiveDraft.footer}
              placeholder="Helpful context"
              onChange={(event) =>
                setWhatsAppInteractiveDraft((current) => ({
                  ...current,
                  footer: event.target.value,
                }))
              }
            />
          </label>
        </div>
      </Modal>

      <Modal
        open={isStructuredMessageOpen}
        title={`Share a ${channel === 'whatsapp' ? 'WhatsApp' : 'Telegram'} contact or location`}
        centered
        width={560}
        okText="Send"
        confirmLoading={sendMutation.isPending}
        onOk={() => void sendStructuredMessage()}
        onCancel={() => setIsStructuredMessageOpen(false)}
      >
        <div className="chat-structured-editor">
          <Segmented
            block
            value={structuredMessageDraft.type}
            options={[
              { label: 'Contact', value: 'contact' },
              { label: 'Location', value: 'location' },
              ...(channel === 'telegram' ? [{ label: 'Poll', value: 'poll' }] : []),
            ]}
            onChange={(type) =>
              setStructuredMessageDraft((current) => ({
                ...current,
                type: type,
              }))
            }
          />
          {structuredMessageDraft.type === 'contact' ? (
            <>
              <Input
                placeholder="First name"
                value={structuredMessageDraft.firstName}
                onChange={(event) =>
                  setStructuredMessageDraft((current) => ({
                    ...current,
                    firstName: event.target.value,
                  }))
                }
              />
              <Input
                placeholder="Last name (optional)"
                value={structuredMessageDraft.lastName}
                onChange={(event) =>
                  setStructuredMessageDraft((current) => ({
                    ...current,
                    lastName: event.target.value,
                  }))
                }
              />
              <Input
                placeholder="Phone number"
                value={structuredMessageDraft.phoneNumber}
                onChange={(event) =>
                  setStructuredMessageDraft((current) => ({
                    ...current,
                    phoneNumber: event.target.value,
                  }))
                }
              />
            </>
          ) : structuredMessageDraft.type === 'location' ? (
            <>
              <Input
                placeholder="Latitude"
                value={structuredMessageDraft.latitude}
                onChange={(event) =>
                  setStructuredMessageDraft((current) => ({
                    ...current,
                    latitude: event.target.value,
                  }))
                }
              />
              <Input
                placeholder="Longitude"
                value={structuredMessageDraft.longitude}
                onChange={(event) =>
                  setStructuredMessageDraft((current) => ({
                    ...current,
                    longitude: event.target.value,
                  }))
                }
              />
            </>
          ) : (
            <>
              <Input
                placeholder="Poll question"
                value={structuredMessageDraft.question}
                onChange={(event) =>
                  setStructuredMessageDraft((current) => ({
                    ...current,
                    question: event.target.value,
                  }))
                }
              />
              <Input.TextArea
                placeholder="One option per line (2–12)"
                autoSize={{ minRows: 4, maxRows: 12 }}
                value={structuredMessageDraft.options}
                onChange={(event) =>
                  setStructuredMessageDraft((current) => ({
                    ...current,
                    options: event.target.value,
                  }))
                }
              />
            </>
          )}
        </div>
      </Modal>

      <Modal
        open={isKeyboardEditorOpen}
        title="Message buttons"
        width={760}
        centered
        className="chat-keyboard-modal"
        onCancel={() => setIsKeyboardEditorOpen(false)}
        footer={
          <Button type="primary" onClick={() => setIsKeyboardEditorOpen(false)}>
            Done
          </Button>
        }
      >
        <Typography.Paragraph type="secondary">
          Add callback actions or links below the message. Each button is sent on its own keyboard
          row.
        </Typography.Paragraph>
        <div className="chat-keyboard-editor">
          {keyboardButtons.length ? (
            keyboardButtons.map((button, index) => (
              <div className="chat-keyboard-editor-card" key={button.id}>
                <div className="chat-keyboard-editor-card-header">
                  <Typography.Text strong>Button {index + 1}</Typography.Text>
                  <Button
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label={`Remove button ${index + 1}`}
                    onClick={() => {
                      pendingClientRequestIdRef.current = null;
                      setKeyboardButtons((current) =>
                        current.filter((_candidate, candidateIndex) => candidateIndex !== index),
                      );
                    }}
                  />
                </div>
                <div className="chat-keyboard-editor-fields">
                  <label>
                    <span>Button text</span>
                    <Input
                      value={button.text}
                      maxLength={64}
                      placeholder="For example: View offer"
                      onChange={(event) => {
                        pendingClientRequestIdRef.current = null;
                        setKeyboardButtons((current) =>
                          current.map((candidate, candidateIndex) =>
                            candidateIndex === index
                              ? { ...candidate, text: event.target.value }
                              : candidate,
                          ),
                        );
                      }}
                    />
                  </label>
                  <label>
                    <span>Action</span>
                    <Segmented
                      block
                      value={button.action}
                      options={[
                        { label: 'Callback', value: 'callback' },
                        { label: 'Open URL', value: 'url' },
                      ]}
                      onChange={(action) => {
                        pendingClientRequestIdRef.current = null;
                        setKeyboardButtons((current) =>
                          current.map((candidate, candidateIndex) =>
                            candidateIndex === index
                              ? {
                                  ...candidate,
                                  action: action,
                                  value: '',
                                }
                              : candidate,
                          ),
                        );
                      }}
                    />
                  </label>
                  <label className="chat-keyboard-editor-value">
                    <span>
                      {button.action === 'callback' ? 'Callback data' : 'Destination URL'}
                    </span>
                    <Input
                      value={button.value}
                      maxLength={button.action === 'callback' ? 64 : 500}
                      placeholder={
                        button.action === 'callback'
                          ? 'For example: budget:1000'
                          : 'https://example.com'
                      }
                      onChange={(event) => {
                        pendingClientRequestIdRef.current = null;
                        setKeyboardButtons((current) =>
                          current.map((candidate, candidateIndex) =>
                            candidateIndex === index
                              ? { ...candidate, value: event.target.value }
                              : candidate,
                          ),
                        );
                      }}
                    />
                  </label>
                </div>
              </div>
            ))
          ) : (
            <div className="chat-keyboard-editor-empty">
              <AppstoreAddOutlined />
              <Typography.Text strong>No buttons added yet</Typography.Text>
              <Typography.Text type="secondary">
                Add the first button to create an interactive message.
              </Typography.Text>
            </div>
          )}
          <Button
            type="dashed"
            block
            icon={<PlusOutlined />}
            disabled={keyboardButtons.length >= 8}
            onClick={() => {
              pendingClientRequestIdRef.current = null;
              setKeyboardButtons((current) => [
                ...current,
                {
                  id: crypto.randomUUID(),
                  text: '',
                  action: 'callback',
                  value: '',
                },
              ]);
            }}
          >
            Add button
          </Button>
        </div>
      </Modal>

      <Modal
        open={isVideoNoteRecorderOpen}
        title="Telegram video note"
        width={520}
        centered
        destroyOnHidden
        className="chat-video-note-modal"
        onCancel={() => setIsVideoNoteRecorderOpen(false)}
        footer={
          <div className="chat-video-note-footer">
            <Button
              type="primary"
              icon={<VideoCameraOutlined />}
              onClick={() => {
                setIsVideoNoteRecorderOpen(false);
                setMediaKind('VIDEO_NOTE');
                requestAnimationFrame(() => attachmentInputRef.current?.click());
              }}
            >
              Choose video
            </Button>
          </div>
        }
      >
        <div className="chat-video-note-stage">
          <div className="chat-video-note-empty">
            <VideoCameraOutlined />
            <strong>Upload a Telegram video note</strong>
            <small>The selected video will be sent to Telegram as a video circle.</small>
          </div>
        </div>
      </Modal>
    </ChatFrame>
  );
}
function ChatFrame({ children }) {
  return <div className="omnicus-telegram-chat">{children}</div>;
}
function scrollChatItem(element) {
  const container = element?.closest('.chat-message-list');
  if (!element || !container) return;
  const offset = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTo({
    top: container.scrollTop + offset - container.clientHeight / 2,
    behavior: 'smooth',
  });
}
