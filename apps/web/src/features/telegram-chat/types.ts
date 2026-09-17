// Conversation UI contracts shared with the CRM chat implementation.
type Role = 'ADMIN' | 'MANAGER' | 'USER';
export interface UserDirectoryEntry {
  id: string;
  name: string;
  email: string;
  role: Role;
  locationCountry?: string;
  locationRegion?: string;
  locationCity?: string;
}

export interface User {
  _id: string;
  name: string;
  email: string;
  role: Role;
  locationCountry?: string;
  locationRegion?: string;
  locationCity?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Conversation {
  _id: string;
  leadId: string;
  channel: 'telegram' | 'whatsapp';
  accountType: 'company' | 'personal';
  channelAccountId: string;
  transport: 'omnicus';
  externalContactId?: string;
  externalChatId?: string;
  crmProjectId?: string;
  omnicusProjectId?: string;
  omnicusContactId?: string;
  omnicusChannelIdentityId?: string;
  omnicusConnectionId?: string;
  omnicusConversationId?: string;
  automationMode?: 'AUTO' | 'MANUAL' | 'PAUSED';
  automationRevision?: number;
  automationResumeAt?: string;
  automationReasonCode?: string;
  automationChangedAt?: string;
  assignedTo?: string;
  status: 'open' | 'closed';
  unreadCount: number;
  lastMessageAt?: string;
  participant?: {
    externalUserId?: string;
    username?: string;
    firstName?: string;
    lastName?: string;
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface ConversationMessage {
  _id: string;
  conversationId: string;
  leadId: string;
  direction: 'inbound' | 'outbound' | 'system';
  senderUserId?: string;
  senderName?: string;
  externalMessageId?: string;
  providerMessageId?: string;
  omnicusOperationId?: string;
  omnicusMessageId?: string;
  scheduleId?: string;
  scheduledAt?: string;
  scheduleTimezone?: string;
  scheduleRecurrence?: TelegramRecurrence;
  scheduleRevision?: number;
  scheduleOccurrence?: number;
  source?: 'CRM' | 'AUTOMATION' | 'BROADCAST' | 'SYSTEM';
  sourceContext?: {
    type: 'scenario' | 'broadcast' | 'system';
    id: string;
    displayName: string;
    webUrl?: string;
  };
  scenarioExecutionId?: string;
  broadcastId?: string;
  outboundErrorCode?: string;
  outboundErrorMessage?: string;
  lastReconciledAt?: string;
  providerStatusOccurredAt?: string;
  text: string;
  attachment?: {
    type: 'image' | 'video' | 'audio' | 'file' | 'sticker';
    kind?: ConversationMediaKind;
    url?: string;
    fileName: string;
    mimeType: string;
    size: number;
    durationSeconds?: number;
    providerAssetId?: string;
    storageStatus?: 'stored' | 'metadata_only' | 'download_failed';
    availability?: 'available' | 'unavailable';
    unavailableReason?: string;
    hasSpoiler?: boolean;
    mediaGroupId?: string;
    emoji?: string;
    setName?: string;
  };
  interactive?: {
    type: 'callback_query' | 'button_reply' | 'list_reply';
    callbackQueryId?: string;
    data?: string;
    displayText?: string;
    sourceMessageId?: string;
    id?: string;
    title?: string;
    description?: string;
  };
  sharedContact?: {
    firstName: string;
    lastName?: string;
    phoneNumber: string;
    telegramUserId?: string;
    vcard?: string;
  };
  structured?:
    | {
        type: 'contact';
        firstName: string;
        lastName?: string;
        phoneNumber: string;
        vcard?: string;
      }
    | {
        type: 'location';
        latitude: number;
        longitude: number;
        horizontalAccuracy?: number;
      }
    | {
        type: 'poll';
        question: string;
        options: string[];
        isAnonymous?: boolean;
        allowsMultipleAnswers?: boolean;
      }
    | {
        type: 'whatsapp_contact';
        formattedName: string;
        firstName?: string;
        lastName?: string;
        phones: Array<{ phone: string; type?: string; waId?: string }>;
        emails?: Array<{ email: string; type?: string }>;
      }
    | {
        type: 'whatsapp_contacts';
        contacts: Array<{
          formattedName: string;
          firstName?: string;
          lastName?: string;
          phones: Array<{ phone: string; type?: string; waId?: string }>;
          emails?: Array<{ email: string; type?: string }>;
        }>;
      }
    | {
        type: 'whatsapp_location';
        latitude: number;
        longitude: number;
        name?: string;
        address?: string;
      };
  replyToMessageId?: string;
  inlineKeyboard?: InlineKeyboard;
  replyMarkup?: TelegramReplyMarkup;
  richMessage?: TelegramRichMessage;
  whatsappTemplate?: WhatsAppTemplateSend;
  whatsappInteractive?: WhatsAppInteractiveMessage;
  entities?: ConversationMessageEntity[];
  linkPreviewOptions?: ConversationLinkPreviewOptions;
  quote?: string;
  quotePosition?: number;
  protectContent?: boolean;
  messageEffectId?: string;
  disableNotification?: boolean;
  managerReaction?: {
    type: 'emoji' | 'custom_emoji';
    value: string;
    isBig?: boolean;
  };
  clientReactions?: Array<{
    type: 'emoji' | 'custom_emoji' | 'paid';
    emoji?: string;
    customEmojiId?: string;
  }>;
  clientReactionActor?: {
    type: 'user';
    externalUserId: string;
    displayName: string;
    username?: string;
  };
  clientReactionOccurredAt?: string;
  isPinned?: boolean;
  editedAt?: string;
  deletedAt?: string;
  referencePreview?: {
    omnicusMessageId?: string;
    senderName?: string;
    text: string;
    mediaKind?: ConversationMediaKind;
  };
  occurredAt?: string;
  status:
    | 'received'
    | 'sent'
    | 'delivered'
    | 'read'
    | 'failed'
    | 'queued'
    | 'processing'
    | 'unknown'
    | 'deleted';
  createdAt?: string;
  updatedAt?: string;
}

export type ConversationMediaKind =
  'PHOTO' | 'DOCUMENT' | 'VIDEO' | 'AUDIO' | 'VOICE' | 'VIDEO_NOTE' | 'ANIMATION' | 'STICKER';

export interface InlineKeyboardButton {
  text: string;
  callbackData?: string;
  url?: string;
}

export type InlineKeyboard = InlineKeyboardButton[][];

export type TelegramReplyMarkup =
  | {
      type: 'reply_keyboard';
      keyboard: Array<
        Array<{
          text: string;
          requestContact?: boolean;
          requestLocation?: boolean;
        }>
      >;
      isPersistent?: boolean;
      resizeKeyboard?: boolean;
      oneTimeKeyboard?: boolean;
      inputFieldPlaceholder?: string;
      selective?: boolean;
    }
  | { type: 'reply_keyboard_remove'; selective?: boolean }
  | {
      type: 'force_reply';
      inputFieldPlaceholder?: string;
      selective?: boolean;
    };

export interface TelegramRichMessage {
  markdown: string;
  isRtl?: boolean;
  skipEntityDetection?: boolean;
  media?: {
    id: string;
    kind: 'ANIMATION' | 'AUDIO' | 'PHOTO' | 'VIDEO' | 'VOICE';
    mediaAssetId: string;
  };
}

export type WhatsAppTemplateParameter =
  | { type: 'text'; text: string }
  | {
      type: 'currency';
      currency: { fallbackValue: string; code: string; amount1000: number };
    }
  | { type: 'date_time'; dateTime: { fallbackValue: string } }
  | {
      type: 'image' | 'video' | 'document';
      mediaAssetId: string;
    }
  | { type: 'payload'; payload: string };

export interface WhatsAppTemplateSend {
  name: string;
  languageCode: string;
  components?: Array<
    | {
        type: 'header' | 'body';
        parameters: WhatsAppTemplateParameter[];
      }
    | {
        type: 'button';
        subType: 'quick_reply' | 'url';
        index: number;
        parameters: WhatsAppTemplateParameter[];
      }
  >;
}

export interface WhatsAppMessageTemplate {
  id: string;
  name: string;
  languageCode: string;
  status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED' | 'DISABLED' | 'UNKNOWN';
  category: 'AUTHENTICATION' | 'MARKETING' | 'UTILITY' | 'UNKNOWN';
  sendable: boolean;
  disabledReason: string | null;
  components: Array<{
    type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
    format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';
    parameterStyle?: 'none' | 'positional' | 'named' | 'mixed';
    unsupportedReason?: string;
    text?: string;
    buttons?: Array<{
      type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';
      text: string;
      parameterStyle?: 'none' | 'positional' | 'named' | 'mixed';
      unsupportedReason?: string;
      dynamic?: boolean;
    }>;
  }>;
}

export type WhatsAppInteractiveMessage =
  | {
      type: 'button';
      body: { text: string };
      header?:
        | { type: 'text'; text: string }
        | {
            type: 'image' | 'video' | 'document';
            mediaAssetId: string;
          };
      footer?: { text: string };
      action: { buttons: Array<{ id: string; title: string }> };
    }
  | {
      type: 'list';
      body: { text: string };
      header?: { type: 'text'; text: string };
      footer?: { text: string };
      action: {
        button: string;
        sections: Array<{
          title?: string;
          rows: Array<{ id: string; title: string; description?: string }>;
        }>;
      };
    };

export interface TelegramRecurrence {
  frequency: 'DAILY' | 'WEEKLY';
  interval: number;
  count?: number;
  until?: string;
}

export interface ConversationMessageEntity {
  type:
    | 'mention'
    | 'hashtag'
    | 'bot_command'
    | 'url'
    | 'email'
    | 'bold'
    | 'italic'
    | 'underline'
    | 'strikethrough'
    | 'spoiler'
    | 'blockquote'
    | 'expandable_blockquote'
    | 'code'
    | 'pre'
    | 'text_link'
    | 'phone_number'
    | 'custom_emoji';
  offset: number;
  length: number;
  url?: string;
  language?: string;
  customEmojiId?: string;
}

export interface ConversationLinkPreviewOptions {
  isDisabled?: boolean;
  url?: string;
  preferSmallMedia?: boolean;
  preferLargeMedia?: boolean;
  showAboveText?: boolean;
}

export type TelegramCapabilityName =
  | 'automationManualMode'
  | 'automationPausedMode'
  | 'chatActions'
  | 'deleteMessage'
  | 'editMessage'
  | 'externalDeletionEvents'
  | 'formattingEntities'
  | 'inlineKeyboard'
  | 'mediaGroups'
  | 'messageEffects'
  | 'botInterface'
  | 'externalActions'
  | 'pinMessage'
  | 'protectContent'
  | 'reactions'
  | 'userReactionEvents'
  | 'scheduling'
  | 'stickers'
  | 'mediaSpoilers'
  | 'structuredMessages'
  | 'replyKeyboard'
  | 'richMessages'
  | 'streamingDraft'
  | 'quote'
  | 'linkPreviewOptions'
  | 'explicitRetry'
  | 'messageTemplates'
  | 'interactiveMessages'
  | 'markMessageRead';

export interface TelegramCapabilityResponse {
  contractVersion: '3.0.0' | '3.1.0' | '3.2.0' | '3.3.0' | '4.0.0';
  channel?: 'telegram' | 'whatsapp';
  telegramBotApiVersion?: '10.2';
  providerApiVersion?: string;
  serviceWindow?: {
    state: 'OPEN' | 'CLOSED' | 'UNKNOWN';
    expiresAt: string | null;
    lastUserMessageAt: string | null;
  };
  capabilities: Partial<
    Record<
      TelegramCapabilityName,
      {
        supported: boolean;
        reasonCode?: string;
        limits?: Record<string, unknown>;
      }
    >
  >;
}

export interface ConversationProviderOperation {
  _id: string;
  messageDocumentId: string;
  omnicusMessageId: string;
  providerOperationId?: string;
  action:
    | 'EDIT_MESSAGE'
    | 'DELETE_MESSAGE'
    | 'SET_REACTION'
    | 'REMOVE_REACTION'
    | 'PIN_MESSAGE'
    | 'UNPIN_MESSAGE'
    | 'MARK_READ';
  status: 'processing' | 'queued' | 'succeeded' | 'failed' | 'unknown';
  errorCode?: string;
  errorMessage?: string;
  lastReconciledAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CompanyConversationResponse {
  conversation: Conversation | null;
  messages: ConversationMessage[];
  operations?: ConversationProviderOperation[];
  messagePage?: {
    nextCursor: string | null;
    hasMore: boolean;
  };
}

export interface ConversationMessagePage {
  messages: ConversationMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface QuickReplyTemplate {
  _id: string;
  title: string;
  content: string;
  scope: 'PERSONAL' | 'TEAM';
  ownerUserId?: string;
  isFavorite?: boolean;
  lastUsedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ConversationInternalNote {
  _id: string;
  leadId: string;
  conversationId?: string;
  channel: 'telegram' | 'whatsapp';
  authorUserId: string;
  authorName: string;
  text: string;
  mentionedUserIds: string[];
  replyToMessageId?: string;
  revision: number;
  editedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ConversationDraft {
  replyMarkup?: TelegramReplyMarkup;
  _id: string;
  leadId: string;
  userId: string;
  channel: 'telegram' | 'whatsapp';
  composerMode: 'message' | 'note';
  text: string;
  mentionedUserIds: string[];
  entities: ConversationMessageEntity[];
  inlineKeyboard: InlineKeyboard;
  linkPreviewOptions: ConversationLinkPreviewOptions;
  quote?: string;
  replyToMessageId?: string;
  protectContent: boolean;
  disableNotification?: boolean;
  messageEffectId?: string;
  expiresAt: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ConversationWorkspace {
  lead: {
    id: string;
    title: string;
    status: string;
    workFolder: string;
    source?: string;
    country?: string;
    budget?: string;
    plannedPurchasePeriod?: string;
    manager: { id: string; name: string; email: string } | null;
    car: {
      brand?: string;
      model?: string;
      year?: number;
      vin?: string;
      price?: number;
      mileage?: number;
      description?: string;
    } | null;
  };
  variables: Record<string, string>;
  variableKeys: string[];
}
