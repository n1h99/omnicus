import { createHash } from 'node:crypto';

import { z } from 'zod';

export interface CrmCallContext {
  correlationId: string;
  crmProjectId: string;
  idempotencyKey: string;
  projectId: string;
}

export interface CrmIdentityInput {
  channel: 'telegram' | 'whatsapp';
  channelIdentityId: string;
  connectionId: string;
  externalChatId?: string;
  externalUserId?: string;
}

export interface CrmTagInput {
  id: string;
  name: string;
}

export interface CrmMediaInput {
  assetId: string;
  availability?: 'available' | 'unavailable';
  downloadUrl?: string;
  downloadUrlExpiresAt?: string;
  emoji?: string;
  fileName?: string;
  kind: 'ANIMATION' | 'AUDIO' | 'DOCUMENT' | 'PHOTO' | 'STICKER' | 'VIDEO' | 'VIDEO_NOTE' | 'VOICE';
  mimeType?: string;
  hasSpoiler?: boolean;
  mediaGroupId?: string;
  setName?: string;
  size?: number;
  type: 'audio' | 'file' | 'image' | 'sticker' | 'video';
  unavailableReason?: string;
}

export type CrmInteractiveInput =
  | {
      callbackQueryId: string;
      data?: string;
      displayText?: string;
      sourceMessageId?: string;
      type: 'callback_query';
    }
  | {
      description?: string;
      id: string;
      sourceMessageId?: string;
      title: string;
      type: 'button_reply' | 'list_reply';
    };

export interface CrmWhatsAppInteractiveInput {
  action: { buttons: Array<{ id: string; title: string }> };
  body: { text: string };
  footer?: { text: string };
  header?:
    { text: string; type: 'text' } | { mediaAssetId: string; type: 'document' | 'image' | 'video' };
  type: 'button';
}

export interface CrmLocationInput {
  address?: string;
  latitude: number;
  longitude: number;
  name?: string;
  url?: string;
}

export interface CrmWhatsAppContactInput {
  emails: Array<{ email: string; type?: string }>;
  name: { firstName?: string; formattedName: string; lastName?: string };
  phones: Array<{ phone: string; type?: string; waId?: string }>;
}

export interface CrmWhatsAppContactsInput {
  contacts: CrmWhatsAppContactInput[];
}

export interface CrmWhatsAppEligibilityInput {
  activeForMailing: boolean;
  consentSource?: string;
  consentStatus: 'UNKNOWN' | 'GRANTED' | 'REVOKED';
  lastCheckedAt?: string;
  lastErrorCode?: string;
  reachability: 'UNKNOWN' | 'PENDING' | 'AVAILABLE' | 'UNAVAILABLE' | 'BLOCKED';
}

export interface CrmInlineKeyboardButtonInput {
  callbackData?: string;
  text: string;
  url?: string;
}

export type CrmInlineKeyboardInput = CrmInlineKeyboardButtonInput[][];

export interface CrmMessageEntityInput {
  customEmojiId?: string;
  language?: string;
  length: number;
  offset: number;
  type: string;
  url?: string;
}

export interface CrmLinkPreviewOptionsInput {
  isDisabled?: boolean;
  preferLargeMedia?: boolean;
  preferSmallMedia?: boolean;
  showAboveText?: boolean;
  url?: string;
}

export type CrmReactionInput =
  | { emoji: string; type: 'emoji' }
  | { customEmojiId: string; type: 'custom_emoji' }
  | { type: 'paid' };

export interface CrmReactionActorInput {
  displayName: string;
  externalUserId: string;
  type: 'user';
  username?: string;
}

export interface CreateOrUpdateLeadInput {
  contactId: string;
  contactStatus?: string;
  customFields: Record<string, unknown>;
  displayName?: string;
  email?: string;
  identity?: CrmIdentityInput;
  phone?: string;
  tags: CrmTagInput[];
  username?: string;
  whatsApp?: CrmWhatsAppEligibilityInput;
}

export interface ForwardTrackedLinkClickInput {
  clickedAt: string;
  contactId: string;
  nodeId: string;
  scenarioExecutionId: string;
  targetUrl: string;
  trackedLinkId: string;
  userAgent?: string;
}

export interface MergeContactsInput {
  primaryContactId: string;
  primaryCrmLeadId?: string;
  secondaryContactId: string;
  secondaryCrmLeadId?: string;
}

export interface ForwardInboundMessageInput {
  contactId: string;
  identity: CrmIdentityInput;
  interactive?: CrmInteractiveInput;
  location?: CrmLocationInput;
  media?: CrmMediaInput;
  messageId?: string;
  normalizedEventId?: string;
  occurredAt: string;
  replyToMessageId?: string;
  senderName?: string;
  text?: string;
  whatsAppContacts?: CrmWhatsAppContactsInput;
}

export interface ForwardOutboundMessageInput {
  broadcastId?: string;
  contactId: string;
  deliveryStatus: 'SENT';
  identity: CrmIdentityInput;
  interactive?: CrmWhatsAppInteractiveInput;
  inlineKeyboard?: CrmInlineKeyboardInput;
  entities?: CrmMessageEntityInput[];
  hasSpoiler?: boolean;
  linkPreviewOptions?: CrmLinkPreviewOptionsInput;
  media?: CrmMediaInput;
  messageId: string;
  messageEffectId?: string;
  occurredAt: string;
  protectContent?: boolean;
  providerMessageId: string;
  quote?: string;
  quotePosition?: number;
  replyToMessageId?: string;
  scenarioExecutionId?: string;
  senderName?: string;
  source: 'AUTOMATION' | 'BROADCAST' | 'SYSTEM';
  sourceContext?: {
    type: 'scenario' | 'broadcast' | 'system';
    id: string;
    displayName: string;
    webUrl?: string;
  };
  text?: string;
}

export interface ForwardReactionEventInput {
  actor: CrmReactionActorInput;
  contactId: string;
  identity: CrmIdentityInput;
  messageId: string;
  newReactions: CrmReactionInput[];
  normalizedEventId: string;
  occurredAt: string;
  oldReactions: CrmReactionInput[];
}

export interface ForwardMessageEditInput {
  caption?: string;
  contactId: string;
  editedAt: string;
  entities?: CrmMessageEntityInput[];
  identity: CrmIdentityInput;
  messageId: string;
  normalizedEventId: string;
  text?: string;
}

export interface ForwardContactShareInput {
  contactId: string;
  identity: CrmIdentityInput;
  messageId: string;
  normalizedEventId: string;
  occurredAt: string;
  sharedContact: {
    firstName: string;
    lastName?: string;
    phoneNumber: string;
    telegramUserId?: string;
    vcard?: string;
  };
}

export interface ForwardAutomationStateInput {
  changedAt: string;
  contactId: string;
  conversationId: string;
  identity: CrmIdentityInput;
  mode: 'AUTO' | 'MANUAL' | 'PAUSED';
  reasonCode?: string;
  resumeAt?: string;
  revision: number;
}

export interface ForwardMessageStatusInput {
  contactId: string;
  errorCode?: string;
  identity: CrmIdentityInput;
  messageId: string;
  normalizedEventId: string;
  occurredAt: string;
  providerMessageId?: string;
  status: 'DELETED' | 'DELIVERED' | 'FAILED' | 'READ' | 'SENT' | 'UNKNOWN';
}

export interface CrmResult {
  mode: string;
  operationId: string;
  providerReference: string;
}

export type CrmReconciliationResult =
  | { status: 'NOT_FOUND' }
  | {
      errorCode?: string;
      operationId: string;
      result?: Record<string, unknown>;
      status: 'FAILED' | 'PROCESSING' | 'SUCCEEDED';
    };

export interface CrmClient {
  createOrUpdateLead(context: CrmCallContext, input: CreateOrUpdateLeadInput): Promise<CrmResult>;
  mergeContacts(context: CrmCallContext, input: MergeContactsInput): Promise<CrmResult>;
  forwardInboundMessage(
    context: CrmCallContext,
    input: ForwardInboundMessageInput,
  ): Promise<CrmResult>;
  forwardOutboundMessage(
    context: CrmCallContext,
    input: ForwardOutboundMessageInput,
  ): Promise<CrmResult>;
  forwardReactionEvent(
    context: CrmCallContext,
    input: ForwardReactionEventInput,
  ): Promise<CrmResult>;
  forwardMessageEdit?(context: CrmCallContext, input: ForwardMessageEditInput): Promise<CrmResult>;
  forwardContactShare?(
    context: CrmCallContext,
    input: ForwardContactShareInput,
  ): Promise<CrmResult>;
  forwardAutomationState?(
    context: CrmCallContext,
    input: ForwardAutomationStateInput,
  ): Promise<CrmResult>;
  forwardMessageStatus?(
    context: CrmCallContext,
    input: ForwardMessageStatusInput,
  ): Promise<CrmResult>;
  forwardTrackedLinkClick(
    context: CrmCallContext,
    input: ForwardTrackedLinkClickInput,
  ): Promise<CrmResult>;
  reconcile(context: CrmCallContext): Promise<CrmReconciliationResult>;
}

export type CrmFailureOutcome = 'PERMANENT_FAILURE' | 'RETRYABLE_FAILURE' | 'UNKNOWN';

export class CrmClientError extends Error {
  constructor(
    public readonly outcome: CrmFailureOutcome,
    public readonly safeCode: string,
    public readonly retryAfterMs?: number,
  ) {
    super(safeCode);
    this.name = 'CrmClientError';
  }
}

const leadResultSchema = z.object({
  crmLeadId: z.string().min(1),
  mode: z.enum(['created', 'updated']),
  operationId: z.string().min(1),
});

const mergeResultSchema = z.object({
  leadId: z.string().min(1).optional(),
  mode: z.enum(['merged', 'noop']),
  operationId: z.string().min(1),
});

const messageResultSchema = z.object({
  crmLeadId: z.string().min(1),
  crmMessageId: z.string().min(1),
  mode: z.enum(['created', 'duplicate']),
  operationId: z.string().min(1),
});

const reactionResultSchema = z
  .object({
    applied: z.boolean(),
    crmLeadId: z.string().min(1),
    crmMessageId: z.string().min(1).optional(),
    mode: z.enum(['created', 'duplicate']),
    operationId: z.string().min(1),
  })
  .refine((result) => !result.applied || result.crmMessageId !== undefined, {
    message: 'Applied reaction result requires crmMessageId',
    path: ['crmMessageId'],
  });

const operationSchema = z.object({
  errorCode: z.string().optional(),
  operationId: z.string().min(1),
  result: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(['PROCESSING', 'SUCCEEDED', 'FAILED']),
});

const errorSchema = z.object({
  error: z.object({
    code: z.string().optional(),
    retryable: z.boolean().optional(),
  }),
});

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HttpCrmClientOptions {
  authToken: string;
  baseUrl: string;
  fetchImplementation?: FetchImplementation;
  timeoutMs: number;
}

export class HttpCrmClient implements CrmClient {
  private readonly baseUrl: string;
  private readonly fetchImplementation: FetchImplementation;

  constructor(private readonly options: HttpCrmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async createOrUpdateLead(
    context: CrmCallContext,
    input: CreateOrUpdateLeadInput,
  ): Promise<CrmResult> {
    const payload = {
      contactStatus: input.contactStatus,
      crmProjectId: context.crmProjectId,
      customFields: input.customFields,
      email: input.email,
      identity: input.identity,
      name: input.displayName,
      omnicusContactId: input.contactId,
      omnicusProjectId: context.projectId,
      phone: input.phone,
      tags: input.tags,
      username: input.username,
      whatsApp: input.whatsApp,
    };
    const result = await this.postAndReconcile(
      '/integrations/v1/omnicus/leads/upsert',
      context,
      payload,
      leadResultSchema,
    );
    return {
      mode: result.mode,
      operationId: result.operationId,
      providerReference: result.crmLeadId,
    };
  }

  async mergeContacts(context: CrmCallContext, input: MergeContactsInput): Promise<CrmResult> {
    const result = await this.postAndReconcile(
      '/integrations/v1/omnicus/contacts/merge',
      context,
      {
        crmProjectId: context.crmProjectId,
        omnicusProjectId: context.projectId,
        primaryCrmLeadId: input.primaryCrmLeadId,
        primaryOmnicusContactId: input.primaryContactId,
        secondaryCrmLeadId: input.secondaryCrmLeadId,
        secondaryOmnicusContactId: input.secondaryContactId,
      },
      mergeResultSchema,
    );
    return {
      mode: result.mode,
      operationId: result.operationId,
      providerReference: result.leadId ?? '',
    };
  }

  async forwardInboundMessage(
    context: CrmCallContext,
    input: ForwardInboundMessageInput,
  ): Promise<CrmResult> {
    const payload = {
      crmProjectId: context.crmProjectId,
      identity: input.identity,
      interactive: input.interactive,
      media: input.media,
      messageId: input.messageId,
      normalizedEventId: input.normalizedEventId,
      occurredAt: input.occurredAt,
      omnicusContactId: input.contactId,
      omnicusProjectId: context.projectId,
      replyToMessageId: input.replyToMessageId,
      senderName: input.senderName,
      text: input.text,
    };
    const result = await this.postAndReconcile(
      '/integrations/v1/omnicus/messages/inbound',
      context,
      payload,
      messageResultSchema,
    );
    return {
      mode: result.mode,
      operationId: result.operationId,
      providerReference: result.crmMessageId,
    };
  }

  async forwardOutboundMessage(
    context: CrmCallContext,
    input: ForwardOutboundMessageInput,
  ): Promise<CrmResult> {
    const payload = {
      broadcastId: input.broadcastId,
      crmProjectId: context.crmProjectId,
      deliveryStatus: input.deliveryStatus,
      identity: input.identity,
      interactive: input.interactive,
      inlineKeyboard: input.inlineKeyboard,
      entities: input.entities,
      hasSpoiler: input.hasSpoiler,
      linkPreviewOptions: input.linkPreviewOptions,
      media: input.media,
      messageId: input.messageId,
      messageEffectId: input.messageEffectId,
      occurredAt: input.occurredAt,
      omnicusContactId: input.contactId,
      omnicusProjectId: context.projectId,
      providerMessageId: input.providerMessageId,
      protectContent: input.protectContent,
      quote: input.quote,
      quotePosition: input.quotePosition,
      replyToMessageId: input.replyToMessageId,
      scenarioExecutionId: input.scenarioExecutionId,
      senderName: input.senderName,
      source: input.source,
      sourceContext: input.sourceContext,
      text: input.text,
    };
    const result = await this.postAndReconcile(
      '/integrations/v1/omnicus/messages/outbound',
      context,
      payload,
      messageResultSchema,
    );
    return {
      mode: result.mode,
      operationId: result.operationId,
      providerReference: result.crmMessageId,
    };
  }

  async forwardReactionEvent(
    context: CrmCallContext,
    input: ForwardReactionEventInput,
  ): Promise<CrmResult> {
    const payload = {
      actor: input.actor,
      crmProjectId: context.crmProjectId,
      identity: input.identity,
      messageId: input.messageId,
      newReactions: input.newReactions,
      normalizedEventId: input.normalizedEventId,
      occurredAt: input.occurredAt,
      oldReactions: input.oldReactions,
      omnicusContactId: input.contactId,
      omnicusProjectId: context.projectId,
    };
    const result = await this.postAndReconcile(
      '/integrations/v1/omnicus/reactions/inbound',
      context,
      payload,
      reactionResultSchema,
    );
    return {
      mode: result.mode,
      operationId: result.operationId,
      providerReference: result.crmMessageId ?? result.operationId,
    };
  }

  async forwardMessageEdit(
    context: CrmCallContext,
    input: ForwardMessageEditInput,
  ): Promise<CrmResult> {
    const result = await this.postAndReconcile(
      '/integrations/v1/omnicus/messages/edited',
      context,
      {
        caption: input.caption,
        crmProjectId: context.crmProjectId,
        editedAt: input.editedAt,
        entities: input.entities,
        identity: input.identity,
        messageId: input.messageId,
        normalizedEventId: input.normalizedEventId,
        omnicusContactId: input.contactId,
        omnicusProjectId: context.projectId,
        text: input.text,
      },
      messageResultSchema,
    );
    return {
      mode: result.mode,
      operationId: result.operationId,
      providerReference: result.crmMessageId,
    };
  }

  async forwardContactShare(
    context: CrmCallContext,
    input: ForwardContactShareInput,
  ): Promise<CrmResult> {
    const result = await this.postAndReconcile(
      '/integrations/v1/omnicus/contacts/shared',
      context,
      {
        crmProjectId: context.crmProjectId,
        identity: input.identity,
        messageId: input.messageId,
        normalizedEventId: input.normalizedEventId,
        occurredAt: input.occurredAt,
        omnicusContactId: input.contactId,
        omnicusProjectId: context.projectId,
        sharedContact: input.sharedContact,
      },
      messageResultSchema,
    );
    return {
      mode: result.mode,
      operationId: result.operationId,
      providerReference: result.crmMessageId,
    };
  }

  async forwardAutomationState(
    context: CrmCallContext,
    input: ForwardAutomationStateInput,
  ): Promise<CrmResult> {
    const result = await this.postAndReconcile(
      '/integrations/v1/omnicus/conversations/automation-state',
      context,
      {
        changedAt: input.changedAt,
        conversationId: input.conversationId,
        crmProjectId: context.crmProjectId,
        identity: input.identity,
        mode: input.mode,
        omnicusContactId: input.contactId,
        omnicusProjectId: context.projectId,
        reasonCode: input.reasonCode,
        resumeAt: input.resumeAt,
        revision: input.revision,
      },
      messageResultSchema,
    );
    return {
      mode: result.mode,
      operationId: result.operationId,
      providerReference: result.crmMessageId,
    };
  }

  async forwardMessageStatus(
    context: CrmCallContext,
    input: ForwardMessageStatusInput,
  ): Promise<CrmResult> {
    const result = await this.postAndReconcile(
      '/integrations/v1/omnicus/messages/status',
      context,
      {
        crmProjectId: context.crmProjectId,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        identity: input.identity,
        messageId: input.messageId,
        normalizedEventId: input.normalizedEventId,
        occurredAt: input.occurredAt,
        omnicusContactId: input.contactId,
        omnicusProjectId: context.projectId,
        providerMessageId: input.providerMessageId,
        status: input.status,
      },
      messageResultSchema,
    );
    return {
      mode: result.mode,
      operationId: result.operationId,
      providerReference: result.crmMessageId,
    };
  }

  async forwardTrackedLinkClick(
    context: CrmCallContext,
    input: ForwardTrackedLinkClickInput,
  ): Promise<CrmResult> {
    const result = await this.postAndReconcile(
      '/integrations/v1/omnicus/tracking/clicked',
      context,
      {
        clickedAt: input.clickedAt,
        crmProjectId: context.crmProjectId,
        nodeId: input.nodeId,
        omnicusContactId: input.contactId,
        omnicusProjectId: context.projectId,
        scenarioExecutionId: input.scenarioExecutionId,
        targetUrl: input.targetUrl,
        trackedLinkId: input.trackedLinkId,
        ...(input.userAgent ? { userAgent: input.userAgent } : {}),
      },
      leadResultSchema,
    );
    return {
      mode: result.mode,
      operationId: result.operationId,
      providerReference: result.crmLeadId,
    };
  }

  async reconcile(context: CrmCallContext): Promise<CrmReconciliationResult> {
    const url = new URL('/integrations/v1/omnicus/operations', `${this.baseUrl}/`);
    url.searchParams.set('crmProjectId', context.crmProjectId);
    url.searchParams.set('idempotencyKey', context.idempotencyKey);
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        headers: this.headers(context, false),
        method: 'GET',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      throw new CrmClientError('UNKNOWN', 'crm_reconciliation_unavailable');
    }
    if (response.status === 404) return { status: 'NOT_FOUND' };
    if (!response.ok)
      throw this.httpError(response.status, await this.safeJson(response), response);
    const parsed = operationSchema.safeParse(await this.safeJson(response));
    if (!parsed.success) throw new CrmClientError('UNKNOWN', 'crm_reconciliation_response_invalid');
    return {
      operationId: parsed.data.operationId,
      status: parsed.data.status,
      ...(parsed.data.errorCode === undefined ? {} : { errorCode: parsed.data.errorCode }),
      ...(parsed.data.result === undefined ? {} : { result: parsed.data.result }),
    };
  }

  private async postAndReconcile<T extends z.ZodType>(
    path: string,
    context: CrmCallContext,
    payload: Record<string, unknown>,
    schema: T,
  ): Promise<z.infer<T>> {
    try {
      const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
        body: JSON.stringify(payload),
        headers: this.headers(context, true),
        method: 'POST',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      const body = await this.safeJson(response);
      if (!response.ok) throw this.httpError(response.status, body, response);
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new CrmClientError('UNKNOWN', 'crm_response_invalid');
      return parsed.data;
    } catch (error) {
      const classified =
        error instanceof CrmClientError
          ? error
          : new CrmClientError('UNKNOWN', 'crm_transport_outcome_unknown');
      if (classified.outcome !== 'UNKNOWN') throw classified;
      return this.resolveUnknown(context, schema, classified);
    }
  }

  private async resolveUnknown<T extends z.ZodType>(
    context: CrmCallContext,
    schema: T,
    original: CrmClientError,
  ): Promise<z.infer<T>> {
    let operation: CrmReconciliationResult;
    try {
      operation = await this.reconcile(context);
    } catch {
      throw original;
    }
    if (operation.status === 'NOT_FOUND') throw original;
    if (operation.status === 'PROCESSING')
      throw new CrmClientError('RETRYABLE_FAILURE', 'crm_operation_in_progress', 1_000);
    if (operation.status === 'FAILED')
      throw new CrmClientError('PERMANENT_FAILURE', operation.errorCode ?? 'crm_operation_failed');
    const parsed = schema.safeParse(operation.result);
    if (!parsed.success) throw new CrmClientError('UNKNOWN', 'crm_reconciliation_result_invalid');
    return parsed.data;
  }

  private headers(context: CrmCallContext, contentType: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.authToken}`,
      ...(contentType ? { 'Content-Type': 'application/json' } : {}),
      'Idempotency-Key': context.idempotencyKey,
      'X-Correlation-Id': context.correlationId,
    };
  }

  private httpError(status: number, body: unknown, response: Response): CrmClientError {
    const parsed = errorSchema.safeParse(body);
    const safeCode = parsed.success
      ? (parsed.data.error.code ?? `crm_http_${status}`)
      : `crm_http_${status}`;
    const retryAfter = this.retryAfterMilliseconds(response.headers.get('retry-after'));
    if (status === 429 || status >= 500)
      return new CrmClientError('RETRYABLE_FAILURE', safeCode, retryAfter);
    return new CrmClientError('PERMANENT_FAILURE', safeCode);
  }

  private retryAfterMilliseconds(value: string | null): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(300_000, seconds * 1_000);
    const date = Date.parse(value);
    if (Number.isNaN(date)) return undefined;
    return Math.min(300_000, Math.max(0, date - Date.now()));
  }

  private async safeJson(response: Response): Promise<unknown> {
    return response.json().catch(() => undefined);
  }
}

export type MockCrmOutcome = CrmFailureOutcome | 'SUCCESS';

export class CrmMockError extends CrmClientError {
  constructor(outcome: Exclude<MockCrmOutcome, 'SUCCESS'>) {
    super(outcome, `crm_mock_${outcome.toLowerCase()}`);
    this.name = 'CrmMockError';
  }
}

export class MockCrmClient implements CrmClient {
  private readonly results = new Map<string, CrmResult>();
  private readonly resultKinds = new Map<
    string,
    'lead' | 'message' | 'outbound-message' | 'reaction'
  >();

  constructor(private readonly outcomeFor: (key: string) => MockCrmOutcome = () => 'SUCCESS') {}

  async createOrUpdateLead(
    context: CrmCallContext,
    _input: CreateOrUpdateLeadInput,
  ): Promise<CrmResult> {
    return this.perform(context, 'lead');
  }

  async mergeContacts(context: CrmCallContext, _input: MergeContactsInput): Promise<CrmResult> {
    return this.perform(context, 'lead');
  }

  async forwardInboundMessage(
    context: CrmCallContext,
    _input: ForwardInboundMessageInput,
  ): Promise<CrmResult> {
    return this.perform(context, 'message');
  }

  async forwardOutboundMessage(
    context: CrmCallContext,
    _input: ForwardOutboundMessageInput,
  ): Promise<CrmResult> {
    return this.perform(context, 'outbound-message');
  }

  async forwardReactionEvent(
    context: CrmCallContext,
    _input: ForwardReactionEventInput,
  ): Promise<CrmResult> {
    return this.perform(context, 'reaction');
  }

  async forwardMessageEdit(
    context: CrmCallContext,
    _input: ForwardMessageEditInput,
  ): Promise<CrmResult> {
    return this.perform(context, 'message');
  }

  async forwardContactShare(
    context: CrmCallContext,
    _input: ForwardContactShareInput,
  ): Promise<CrmResult> {
    return this.perform(context, 'message');
  }

  async forwardAutomationState(
    context: CrmCallContext,
    _input: ForwardAutomationStateInput,
  ): Promise<CrmResult> {
    return this.perform(context, 'message');
  }

  async forwardMessageStatus(
    context: CrmCallContext,
    _input: ForwardMessageStatusInput,
  ): Promise<CrmResult> {
    return this.perform(context, 'message');
  }

  async forwardTrackedLinkClick(
    context: CrmCallContext,
    _input: ForwardTrackedLinkClickInput,
  ): Promise<CrmResult> {
    return this.perform(context, 'lead');
  }

  async reconcile(context: CrmCallContext): Promise<CrmReconciliationResult> {
    const result = this.results.get(context.idempotencyKey);
    const kind = this.resultKinds.get(context.idempotencyKey);
    return result
      ? {
          operationId: result.operationId,
          result: {
            ...(kind === 'lead'
              ? { crmLeadId: result.providerReference }
              : kind === 'reaction'
                ? {
                    applied: true,
                    crmLeadId: 'mock-lead',
                    crmMessageId: result.providerReference,
                  }
                : { crmMessageId: result.providerReference }),
            mode: result.mode,
            operationId: result.operationId,
          },
          status: 'SUCCEEDED',
        }
      : { status: 'NOT_FOUND' };
  }

  private perform(
    context: CrmCallContext,
    kind: 'lead' | 'message' | 'outbound-message' | 'reaction',
  ): CrmResult {
    const known = this.results.get(context.idempotencyKey);
    if (known) return known;
    const outcome = this.outcomeFor(context.idempotencyKey);
    if (outcome !== 'SUCCESS') throw new CrmMockError(outcome);
    const digest = createHash('sha256')
      .update(`${context.projectId}:${context.crmProjectId}:${context.idempotencyKey}:${kind}`)
      .digest('hex')
      .slice(0, 24);
    const result = {
      mode: 'created',
      operationId: `mock-${kind}-${digest}`,
      providerReference: `mock-${digest}`,
    };
    this.results.set(context.idempotencyKey, result);
    this.resultKinds.set(context.idempotencyKey, kind);
    return result;
  }
}
