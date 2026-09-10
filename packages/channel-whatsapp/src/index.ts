import { createHash } from 'node:crypto';

import type { ChannelAdapterDescriptor } from '@omnicus/channel-core';
export * from './template-management';
export * from './pricing';

export const WHATSAPP_INBOUND_QUEUE_NAME = 'whatsapp-inbound';
export const WHATSAPP_INBOUND_JOB_NAME = 'process-inbox-record';
export const WHATSAPP_OUTBOUND_QUEUE_NAME = 'whatsapp-outbound';
export const WHATSAPP_OUTBOUND_JOB_NAME = 'deliver-outbox-record';

export interface WhatsAppInboundJob {
  inboxRecordId: string;
}

export interface WhatsAppOutboundJob {
  outboxRecordId: string;
}

export function whatsappInboundJobIdFor(id: string): string {
  return `whatsapp-inbound-${id}`;
}

export function whatsappOutboundJobIdFor(id: string): string {
  return `whatsapp-outbound-${id}`;
}

export const whatsappDescriptor: ChannelAdapterDescriptor = {
  channel: 'whatsapp',
  version: 'cloud-api-configured',
  capabilities: {
    broadcasts: true,
    deliveryStatuses: true,
    incoming: {
      audio: true,
      contact: true,
      document: true,
      image: true,
      interactive: true,
      location: true,
      reaction: true,
      sticker: true,
      text: true,
      video: true,
    },
    outgoing: {
      audio: true,
      contact: true,
      document: true,
      image: true,
      interactive: true,
      location: true,
      reaction: true,
      templates: true,
      text: true,
      video: true,
      voice: true,
    },
    readStatuses: true,
  },
};

export type WhatsAppInboundItemKind = 'message' | 'status';

export interface WhatsAppWebhookItem {
  externalEventId: string;
  kind: WhatsAppInboundItemKind;
  payload: Record<string, unknown>;
  phoneNumberId: string;
  wabaId: string;
}

export class WhatsAppWebhookEnvelopeError extends Error {
  constructor(readonly code: 'whatsapp_webhook_envelope_oversized') {
    super(code);
    this.name = 'WhatsAppWebhookEnvelopeError';
  }
}

const maximumWebhookEntries = 100;
const maximumWebhookChangesPerEntry = 100;
const maximumWebhookItems = 500;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as JsonObject)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function splitWhatsAppWebhookEnvelope(input: unknown): WhatsAppWebhookItem[] {
  const envelope = object(input);
  if (envelope?.object !== 'whatsapp_business_account' || !Array.isArray(envelope.entry)) return [];
  if (envelope.entry.length > maximumWebhookEntries)
    throw new WhatsAppWebhookEnvelopeError('whatsapp_webhook_envelope_oversized');
  const items: WhatsAppWebhookItem[] = [];
  for (const rawEntry of envelope.entry) {
    const entry = object(rawEntry);
    const wabaId = string(entry?.id);
    if (!wabaId || !Array.isArray(entry?.changes)) continue;
    if (entry.changes.length > maximumWebhookChangesPerEntry)
      throw new WhatsAppWebhookEnvelopeError('whatsapp_webhook_envelope_oversized');
    for (const rawChange of entry.changes) {
      const change = object(rawChange);
      const value = object(change?.value);
      const metadata = object(value?.metadata);
      const phoneNumberId = string(metadata?.phone_number_id);
      if (change?.field !== 'messages' || !value || !phoneNumberId) continue;
      const displayPhoneNumber = string(metadata?.display_phone_number);
      const baseValue = {
        messaging_product: 'whatsapp',
        metadata: {
          ...(displayPhoneNumber ? { display_phone_number: displayPhoneNumber } : {}),
          phone_number_id: phoneNumberId,
        },
      };
      if (Array.isArray(value.messages)) {
        for (const rawMessage of value.messages) {
          if (items.length >= maximumWebhookItems)
            throw new WhatsAppWebhookEnvelopeError('whatsapp_webhook_envelope_oversized');
          const message = object(rawMessage);
          if (!message) continue;
          const messageId = string(message.id);
          const externalEventId = messageId
            ? `message:${messageId}`
            : `message:unknown:${digest(message)}`;
          const contacts = Array.isArray(value.contacts)
            ? value.contacts
                .filter((contact) => object(contact)?.wa_id === message.from)
                .slice(0, 1)
            : [];
          items.push({
            externalEventId,
            kind: 'message',
            phoneNumberId,
            wabaId,
            payload: {
              entry: [
                {
                  changes: [
                    {
                      field: 'messages',
                      value: {
                        ...baseValue,
                        ...(contacts.length ? { contacts } : {}),
                        messages: [message],
                      },
                    },
                  ],
                  id: wabaId,
                },
              ],
              object: 'whatsapp_business_account',
            },
          });
        }
      }
      if (Array.isArray(value.statuses)) {
        for (const rawStatus of value.statuses) {
          if (items.length >= maximumWebhookItems)
            throw new WhatsAppWebhookEnvelopeError('whatsapp_webhook_envelope_oversized');
          const status = object(rawStatus);
          if (!status) continue;
          const providerMessageId = string(status.id) ?? 'unknown';
          const statusName = string(status.status) ?? 'unknown';
          const timestamp = string(status.timestamp) ?? 'unknown';
          items.push({
            externalEventId: `status:${providerMessageId}:${statusName}:${timestamp}`,
            kind: 'status',
            phoneNumberId,
            wabaId,
            payload: {
              entry: [
                {
                  changes: [{ field: 'messages', value: { ...baseValue, statuses: [status] } }],
                  id: wabaId,
                },
              ],
              object: 'whatsapp_business_account',
            },
          });
        }
      }
    }
  }
  return items;
}

export type WhatsAppNormalizedInbound =
  | {
      kind: 'message';
      message: JsonObject;
      profileName?: string;
      senderId: string;
    }
  | { kind: 'status'; status: JsonObject };

export function normalizeWhatsAppWebhookItem(input: unknown): WhatsAppNormalizedInbound {
  const envelope = object(input);
  const entry = Array.isArray(envelope?.entry) ? object(envelope.entry[0]) : undefined;
  const change = Array.isArray(entry?.changes) ? object(entry.changes[0]) : undefined;
  const value = object(change?.value);
  if (!value) throw new Error('whatsapp_webhook_item_invalid');
  if (Array.isArray(value.messages) && value.messages.length === 1) {
    const message = object(value.messages[0]);
    const senderId = string(message?.from);
    if (!message || !senderId || !string(message.id) || !string(message.type))
      throw new Error('whatsapp_message_invalid');
    const contact = Array.isArray(value.contacts) ? object(value.contacts[0]) : undefined;
    const profile = object(contact?.profile);
    const profileName = string(profile?.name);
    return {
      kind: 'message',
      message,
      ...(profileName ? { profileName } : {}),
      senderId,
    };
  }
  if (Array.isArray(value.statuses) && value.statuses.length === 1) {
    const status = object(value.statuses[0]);
    if (!status || !string(status.id) || !string(status.status) || !string(status.timestamp))
      throw new Error('whatsapp_status_invalid');
    return { kind: 'status', status };
  }
  throw new Error('whatsapp_webhook_item_invalid');
}

export type WhatsAppInteractive =
  | {
      action: { buttons: Array<{ id: string; title: string }> };
      body: { text: string };
      footer?: { text: string };
      header?:
        { text: string; type: 'text' } | { mediaId: string; type: 'document' | 'image' | 'video' };
      type: 'button';
    }
  | {
      action: {
        button: string;
        sections: Array<{
          rows: Array<{ description?: string; id: string; title: string }>;
          title?: string;
        }>;
      };
      body: { text: string };
      footer?: { text: string };
      header?: { text: string; type: 'text' };
      type: 'list';
    };

export type WhatsAppTemplateParameter =
  | { text: string; type: 'text' }
  | { amount1000: number; code: string; fallbackValue: string; type: 'currency' }
  | { fallbackValue: string; type: 'date_time' }
  | { mediaId: string; type: 'document' | 'image' | 'video' }
  | { payload: string; type: 'payload' };

export interface WhatsAppTemplateSend {
  components?: Array<
    | { parameters: WhatsAppTemplateParameter[]; type: 'body' | 'header' }
    | {
        index: number;
        parameters: WhatsAppTemplateParameter[];
        subType: 'quick_reply' | 'url';
        type: 'button';
      }
  >;
  languageCode: string;
  name: string;
}

export function assertWhatsAppReactionEmoji(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 32)
    throw new Error('whatsapp_reaction_emoji_invalid');
  if (value === '') return;
  const segments = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)];
  if (
    segments.length !== 1 ||
    !/(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3)/u.test(segments[0]!.segment)
  )
    throw new Error('whatsapp_reaction_emoji_invalid');
}

export type WhatsAppTemplateDisabledReason =
  | 'WHATSAPP_AUTHENTICATION_TEMPLATE_UNSUPPORTED'
  | 'WHATSAPP_TEMPLATE_CATEGORY_UNSUPPORTED'
  | 'WHATSAPP_TEMPLATE_COMPONENT_UNSUPPORTED'
  | 'WHATSAPP_TEMPLATE_LOCATION_HEADER_UNSUPPORTED'
  | 'WHATSAPP_TEMPLATE_NAMED_VARIABLES_UNSUPPORTED'
  | 'WHATSAPP_TEMPLATE_NOT_APPROVED'
  | 'WHATSAPP_TEMPLATE_PARAMETER_STYLE_UNSUPPORTED';

export function whatsAppTemplateDisabledReason(input: {
  category?: unknown;
  components?: unknown;
  status?: unknown;
}): WhatsAppTemplateDisabledReason | undefined {
  if (input.status !== undefined && input.status !== 'APPROVED')
    return 'WHATSAPP_TEMPLATE_NOT_APPROVED';
  if (input.category === 'AUTHENTICATION') return 'WHATSAPP_AUTHENTICATION_TEMPLATE_UNSUPPORTED';
  if (input.category !== undefined && !['MARKETING', 'UTILITY'].includes(String(input.category)))
    return 'WHATSAPP_TEMPLATE_CATEGORY_UNSUPPORTED';
  const definitions = Array.isArray(input.components) ? input.components : [];
  for (const candidate of definitions) {
    const component = object(candidate);
    const componentType = string(component?.type)?.toUpperCase();
    const format = string(component?.format)?.toUpperCase();
    if (componentType === 'HEADER' && format === 'LOCATION')
      return 'WHATSAPP_TEMPLATE_LOCATION_HEADER_UNSUPPORTED';
    const unsupportedReason = string(component?.unsupportedReason);
    if (
      unsupportedReason === 'WHATSAPP_TEMPLATE_LOCATION_HEADER_UNSUPPORTED' ||
      unsupportedReason === 'WHATSAPP_TEMPLATE_COMPONENT_UNSUPPORTED' ||
      unsupportedReason === 'WHATSAPP_TEMPLATE_NAMED_VARIABLES_UNSUPPORTED' ||
      unsupportedReason === 'WHATSAPP_TEMPLATE_PARAMETER_STYLE_UNSUPPORTED'
    )
      return unsupportedReason;
    const parameterStyle = string(component?.parameterStyle);
    if (parameterStyle === 'named' || parameterStyle === 'mixed')
      return 'WHATSAPP_TEMPLATE_NAMED_VARIABLES_UNSUPPORTED';
    if (
      typeof component?.text === 'string' &&
      [...component.text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].some(
        (match) => !/^\d+$/.test(match[1]!.trim()),
      )
    )
      return 'WHATSAPP_TEMPLATE_NAMED_VARIABLES_UNSUPPORTED';
    if (componentType !== 'BUTTONS' || !Array.isArray(component?.buttons)) continue;
    for (const candidateButton of component.buttons) {
      const button = object(candidateButton);
      const buttonReason = string(button?.unsupportedReason);
      if (buttonReason === 'WHATSAPP_TEMPLATE_NAMED_VARIABLES_UNSUPPORTED') return buttonReason;
      if (button?.type === 'URL' && button.dynamic === true) {
        if (button.parameterStyle === 'named' || button.parameterStyle === 'mixed')
          return 'WHATSAPP_TEMPLATE_NAMED_VARIABLES_UNSUPPORTED';
        if (button.parameterStyle !== 'positional')
          return 'WHATSAPP_TEMPLATE_PARAMETER_STYLE_UNSUPPORTED';
      }
    }
  }
  return undefined;
}

export function assertWhatsAppTemplateComponents(definition: unknown, input: unknown): void {
  const definitions = Array.isArray(definition) ? definition : [];
  if (whatsAppTemplateDisabledReason({ components: definitions }))
    throw new Error('whatsapp_template_definition_unsupported');
  const supplied = input === undefined ? [] : Array.isArray(input) ? input : undefined;
  if (!supplied || supplied.length > 64) throw new Error('whatsapp_template_components_invalid');
  type Requirement = {
    index?: number;
    parameterCount: number;
    parameterType?: string;
    subType?: 'quick_reply' | 'url';
    type: 'body' | 'button' | 'header';
  };
  const requirements: Requirement[] = [];
  const placeholderCount = (value: unknown): number => {
    if (typeof value !== 'string') return 0;
    return new Set([...value.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((match) => match[1]!)).size;
  };
  for (const candidate of definitions) {
    const component = object(candidate);
    const componentType = string(component?.type)?.toUpperCase();
    if (componentType === 'BODY') {
      const count = placeholderCount(component?.text);
      if (count) requirements.push({ parameterCount: count, type: 'body' });
    } else if (componentType === 'HEADER') {
      const format = string(component?.format)?.toUpperCase();
      if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format ?? ''))
        requirements.push({
          parameterCount: 1,
          parameterType: format!.toLowerCase(),
          type: 'header',
        });
      else {
        const count = placeholderCount(component?.text);
        if (count) requirements.push({ parameterCount: count, type: 'header' });
      }
    } else if (componentType === 'BUTTONS' && Array.isArray(component?.buttons)) {
      component.buttons.forEach((candidateButton, index) => {
        const button = object(candidateButton);
        if (button?.type === 'QUICK_REPLY')
          requirements.push({
            index,
            parameterCount: 1,
            parameterType: 'payload',
            subType: 'quick_reply',
            type: 'button',
          });
        else if (button?.type === 'URL' && button.dynamic === true)
          requirements.push({
            index,
            parameterCount: 1,
            parameterType: 'text',
            subType: 'url',
            type: 'button',
          });
      });
    }
  }
  const keys = new Set<string>();
  const exactKeys = (value: JsonObject, allowed: readonly string[]): boolean =>
    Object.keys(value).every((key) => allowed.includes(key)) &&
    allowed.every((key) => key in value);
  for (const candidate of supplied) {
    const component = object(candidate);
    const type = string(component?.type);
    const parameters = Array.isArray(component?.parameters) ? component.parameters : undefined;
    if (!component || !type || !parameters || !['body', 'button', 'header'].includes(type))
      throw new Error('whatsapp_template_components_invalid');
    if (
      (type === 'button' && !exactKeys(component, ['index', 'parameters', 'subType', 'type'])) ||
      (type !== 'button' && !exactKeys(component, ['parameters', 'type']))
    )
      throw new Error('whatsapp_template_components_invalid');
    const index = component.index;
    const subType = string(component.subType);
    const key = type === 'button' ? `${type}:${String(index)}` : type;
    if (keys.has(key)) throw new Error('whatsapp_template_components_invalid');
    keys.add(key);
    const requirement = requirements.find(
      (candidateRequirement) =>
        candidateRequirement.type === type &&
        (type !== 'button' ||
          (candidateRequirement.index === index && candidateRequirement.subType === subType)),
    );
    if (!requirement || parameters.length !== requirement.parameterCount)
      throw new Error('whatsapp_template_components_invalid');
    for (const rawParameter of parameters) {
      const parameter = object(rawParameter);
      const parameterType = string(parameter?.type);
      if (!parameter || !parameterType) throw new Error('whatsapp_template_components_invalid');
      if (requirement.parameterType && parameterType !== requirement.parameterType)
        throw new Error('whatsapp_template_components_invalid');
      if (
        (parameterType === 'text' &&
          (!exactKeys(parameter, ['text', 'type']) ||
            typeof parameter.text !== 'string' ||
            parameter.text.length < 1 ||
            parameter.text.length > 4_096)) ||
        (parameterType === 'payload' &&
          (!exactKeys(parameter, ['payload', 'type']) ||
            typeof parameter.payload !== 'string' ||
            parameter.payload.length < 1 ||
            parameter.payload.length > 1_024)) ||
        (['image', 'video', 'document'].includes(parameterType) &&
          (!exactKeys(parameter, ['mediaAssetId', 'type']) ||
            typeof parameter.mediaAssetId !== 'string' ||
            parameter.mediaAssetId.length < 1 ||
            parameter.mediaAssetId.length > 128)) ||
        (parameterType === 'date_time' &&
          (!exactKeys(parameter, ['fallbackValue', 'type']) ||
            typeof parameter.fallbackValue !== 'string' ||
            parameter.fallbackValue.length < 1 ||
            parameter.fallbackValue.length > 128)) ||
        (parameterType === 'currency' &&
          (!exactKeys(parameter, ['amount1000', 'code', 'fallbackValue', 'type']) ||
            !Number.isSafeInteger(parameter.amount1000) ||
            typeof parameter.code !== 'string' ||
            !/^[A-Z]{3}$/.test(parameter.code) ||
            typeof parameter.fallbackValue !== 'string' ||
            parameter.fallbackValue.length < 1 ||
            parameter.fallbackValue.length > 128)) ||
        !['currency', 'date_time', 'document', 'image', 'payload', 'text', 'video'].includes(
          parameterType,
        )
      )
        throw new Error('whatsapp_template_components_invalid');
      if (!requirement.parameterType && !['currency', 'date_time', 'text'].includes(parameterType))
        throw new Error('whatsapp_template_components_invalid');
    }
  }
  if (
    requirements.some((requirement) => {
      const key =
        requirement.type === 'button'
          ? `${requirement.type}:${String(requirement.index)}`
          : requirement.type;
      return !keys.has(key);
    })
  )
    throw new Error('whatsapp_template_components_invalid');
}

export type WhatsAppOutboundMessage =
  | { previewUrl?: boolean; text: string; type: 'text' }
  | { mediaId: string; type: 'audio'; voice?: boolean }
  | { caption?: string; filename?: string; mediaId: string; type: 'document' }
  | { caption?: string; mediaId: string; type: 'image' | 'video' }
  | { mediaId: string; type: 'sticker' }
  | { template: WhatsAppTemplateSend; type: 'template' }
  | { emoji: string; messageId: string; type: 'reaction' }
  | { address?: string; latitude: number; longitude: number; name?: string; type: 'location' }
  | {
      contact: {
        emails?: Array<{ email: string; type?: string }>;
        firstName?: string;
        formattedName: string;
        lastName?: string;
        phones: Array<{ phone: string; type?: string; waId?: string }>;
      };
      type: 'contact';
    }
  | { interactive: WhatsAppInteractive; type: 'interactive' };

export class WhatsAppApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterSeconds?: number,
    public readonly providerCode?: number,
    public readonly providerSubcode?: number,
    public readonly providerTransient?: boolean,
    public readonly providerType?: string,
    public readonly providerMessage?: string,
    public readonly providerTraceId?: string,
  ) {
    super(`whatsapp_api_${status}`);
    this.name = 'WhatsAppApiError';
  }
}

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class WhatsAppCloudApi {
  constructor(
    private readonly fetchImplementation: FetchImplementation = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async exchangeEmbeddedSignupCode(input: {
    appId: string;
    appSecret: string;
    code: string;
    graphApiVersion: string;
  }): Promise<string> {
    const url = this.graphUrl(input.graphApiVersion, 'oauth/access_token');
    url.searchParams.set('client_id', input.appId);
    url.searchParams.set('client_secret', input.appSecret);
    url.searchParams.set('code', input.code);
    const result = await this.json(url, { method: 'GET' });
    const token = string(result.access_token);
    if (!token) throw new WhatsAppApiError(502);
    return token;
  }

  async phoneNumber(
    token: string,
    graphApiVersion: string,
    phoneNumberId: string,
  ): Promise<{ displayPhoneNumber?: string; id: string; verifiedName?: string }> {
    const url = this.graphUrl(graphApiVersion, phoneNumberId);
    url.searchParams.set('fields', 'id,display_phone_number,verified_name');
    const result = await this.json(url, { headers: this.auth(token), method: 'GET' });
    if (string(result.id) !== phoneNumberId) throw new WhatsAppApiError(404);
    const displayPhoneNumber = string(result.display_phone_number);
    const verifiedName = string(result.verified_name);
    return {
      id: phoneNumberId,
      ...(displayPhoneNumber ? { displayPhoneNumber } : {}),
      ...(verifiedName ? { verifiedName } : {}),
    };
  }

  async wabaPhoneNumber(
    token: string,
    graphApiVersion: string,
    wabaId: string,
    phoneNumberId: string,
  ): Promise<{ displayPhoneNumber?: string; id: string; verifiedName?: string }> {
    let url: URL | undefined = this.graphUrl(graphApiVersion, `${wabaId}/phone_numbers`);
    url.searchParams.set('fields', 'id,display_phone_number,verified_name');
    url.searchParams.set('limit', '100');
    for (let page = 0; url && page < 10; page += 1) {
      const result = await this.json(url, { headers: this.auth(token), method: 'GET' });
      const rows = Array.isArray(result.data) ? result.data : [];
      const match = rows.map(object).find((row) => string(row?.id) === phoneNumberId);
      if (match) {
        const displayPhoneNumber = string(match.display_phone_number);
        const verifiedName = string(match.verified_name);
        return {
          id: phoneNumberId,
          ...(displayPhoneNumber ? { displayPhoneNumber } : {}),
          ...(verifiedName ? { verifiedName } : {}),
        };
      }
      const next = string(object(result.paging)?.next);
      url = next ? new URL(next) : undefined;
      if (url && (url.origin !== 'https://graph.facebook.com' || url.username || url.password))
        throw new WhatsAppApiError(502);
    }
    throw new WhatsAppApiError(404);
  }

  async subscribeWaba(token: string, graphApiVersion: string, wabaId: string): Promise<void> {
    const result = await this.json(this.graphUrl(graphApiVersion, `${wabaId}/subscribed_apps`), {
      headers: this.auth(token),
      method: 'POST',
    });
    if (result.success !== true) throw new WhatsAppApiError(502);
  }

  async registerPhoneNumber(
    token: string,
    graphApiVersion: string,
    phoneNumberId: string,
    pin: string,
  ): Promise<void> {
    if (!/^\d{6}$/.test(pin)) throw new Error('whatsapp_registration_pin_invalid');
    const result = await this.json(this.graphUrl(graphApiVersion, `${phoneNumberId}/register`), {
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
      headers: { ...this.auth(token), 'Content-Type': 'application/json' },
      method: 'POST',
    });
    if (result.success !== true) throw new WhatsAppApiError(502);
  }

  async unsubscribeWaba(token: string, graphApiVersion: string, wabaId: string): Promise<void> {
    const result = await this.json(this.graphUrl(graphApiVersion, `${wabaId}/subscribed_apps`), {
      headers: this.auth(token),
      method: 'DELETE',
    });
    if (result.success !== true) throw new WhatsAppApiError(502);
  }

  async sendMessage(input: {
    accessToken: string;
    graphApiVersion: string;
    message: WhatsAppOutboundMessage;
    phoneNumberId: string;
    replyToProviderMessageId?: string;
    to: string;
  }): Promise<{ messageId: string }> {
    const result = await this.json(
      this.graphUrl(input.graphApiVersion, `${input.phoneNumberId}/messages`),
      {
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: input.to,
          ...(input.replyToProviderMessageId
            ? { context: { message_id: input.replyToProviderMessageId } }
            : {}),
          ...this.messageBody(input.message),
        }),
        headers: { ...this.auth(input.accessToken), 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );
    const messages = Array.isArray(result.messages) ? result.messages : [];
    const messageId = string(object(messages[0])?.id);
    if (!messageId) throw new WhatsAppApiError(502);
    return { messageId };
  }

  async markMessageRead(input: {
    accessToken: string;
    graphApiVersion: string;
    messageId: string;
    phoneNumberId: string;
  }): Promise<void> {
    const result = await this.json(
      this.graphUrl(input.graphApiVersion, `${input.phoneNumberId}/messages`),
      {
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          message_id: input.messageId,
          status: 'read',
        }),
        headers: { ...this.auth(input.accessToken), 'Content-Type': 'application/json' },
        method: 'PUT',
      },
    );
    if (result.success !== true) throw new WhatsAppApiError(502);
  }

  async uploadMedia(input: {
    accessToken: string;
    bytes: Uint8Array;
    contentType: string;
    filename: string;
    graphApiVersion: string;
    phoneNumberId: string;
  }): Promise<string> {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', input.contentType);
    const uploadBytes = new Uint8Array(input.bytes.byteLength);
    uploadBytes.set(input.bytes);
    form.set('file', new Blob([uploadBytes.buffer], { type: input.contentType }), input.filename);
    const result = await this.json(
      this.graphUrl(input.graphApiVersion, `${input.phoneNumberId}/media`),
      { body: form, headers: this.auth(input.accessToken), method: 'POST' },
    );
    const id = string(result.id);
    if (!id) throw new WhatsAppApiError(502);
    return id;
  }

  async downloadMedia(input: {
    accessToken: string;
    graphApiVersion: string;
    maximumBytes: number;
    mediaId: string;
  }): Promise<{ bytes: Uint8Array; contentType?: string; fileSize?: number }> {
    const metadata = await this.json(this.graphUrl(input.graphApiVersion, input.mediaId), {
      headers: this.auth(input.accessToken),
      method: 'GET',
    });
    const urlValue = string(metadata.url);
    if (!urlValue) throw new WhatsAppApiError(502);
    const providerFileSize = metadata.file_size;
    if (
      typeof providerFileSize === 'number' &&
      Number.isFinite(providerFileSize) &&
      providerFileSize > input.maximumBytes
    )
      throw new WhatsAppApiError(413);
    const url = new URL(urlValue);
    this.assertMediaDownloadUrl(url);
    const response = await this.fetchImplementation(url, {
      headers: this.auth(input.accessToken),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) throw new WhatsAppApiError(502);
    if (response.url) this.assertMediaDownloadUrl(new URL(response.url));
    if (!response.ok) throw await this.error(response);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > input.maximumBytes) throw new WhatsAppApiError(413);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > input.maximumBytes) throw new WhatsAppApiError(413);
    const contentType = response.headers.get('content-type') ?? undefined;
    return {
      bytes,
      ...(contentType ? { contentType } : {}),
      ...(typeof providerFileSize === 'number' ? { fileSize: providerFileSize } : {}),
    };
  }

  async templates(token: string, graphApiVersion: string, wabaId: string): Promise<JsonObject[]> {
    let url: URL | undefined = this.graphUrl(graphApiVersion, `${wabaId}/message_templates`);
    url.searchParams.set(
      'fields',
      'id,name,language,status,category,components,quality_score,rejected_reason',
    );
    url.searchParams.set('limit', '250');
    const templates: JsonObject[] = [];
    for (let page = 0; url && page < 20 && templates.length < 2_000; page += 1) {
      const result = await this.json(url, { headers: this.auth(token), method: 'GET' });
      if (!Array.isArray(result.data)) throw new WhatsAppApiError(502);
      templates.push(...result.data.flatMap((item) => (object(item) ? [object(item)!] : [])));
      const next = string(object(result.paging)?.next);
      url = next ? new URL(next) : undefined;
      if (url && (url.origin !== 'https://graph.facebook.com' || url.username || url.password))
        throw new WhatsAppApiError(502);
    }
    if (url) throw new WhatsAppApiError(502);
    return templates;
  }

  async readFields(
    token: string,
    version: string,
    nodeId: string,
    fields: string,
  ): Promise<JsonObject> {
    const url = this.graphUrl(version, nodeId);
    url.searchParams.set('fields', fields);
    return this.json(url, { headers: this.auth(token), method: 'GET' });
  }

  async subscribedApps(token: string, version: string, wabaId: string): Promise<JsonObject[]> {
    let url: URL | undefined = this.graphUrl(version, `${wabaId}/subscribed_apps`);
    const apps: JsonObject[] = [];
    for (let page = 0; url && page < 20; page++) {
      const result = await this.json(url, { headers: this.auth(token), method: 'GET' });
      if (!Array.isArray(result.data)) throw new WhatsAppApiError(502);
      apps.push(...result.data.flatMap((item) => (object(item) ? [object(item)!] : [])));
      const next = string(object(result.paging)?.next);
      url = next ? new URL(next) : undefined;
      if (url && (url.origin !== 'https://graph.facebook.com' || url.username || url.password))
        throw new WhatsAppApiError(502);
    }
    if (url) throw new WhatsAppApiError(502);
    return apps;
  }

  async inspectToken(
    token: string,
    version: string,
    appId: string,
    appSecret: string,
  ): Promise<JsonObject> {
    const url = this.graphUrl(version, 'debug_token');
    url.searchParams.set('input_token', token);
    const result = await this.json(url, {
      headers: this.auth(`${appId}|${appSecret}`),
      method: 'GET',
    });
    if (!object(result.data)) throw new WhatsAppApiError(502);
    return object(result.data)!;
  }

  async createTemplate(
    token: string,
    version: string,
    wabaId: string,
    payload: JsonObject,
  ): Promise<JsonObject> {
    const result = await this.json(this.graphUrl(version, `${wabaId}/message_templates`), {
      headers: { ...this.auth(token), 'Content-Type': 'application/json' },
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!string(result.id)) throw new WhatsAppApiError(502);
    return result;
  }

  async editTemplate(
    token: string,
    version: string,
    templateId: string,
    components: JsonObject[],
  ): Promise<void> {
    const result = await this.json(this.graphUrl(version, templateId), {
      headers: { ...this.auth(token), 'Content-Type': 'application/json' },
      method: 'POST',
      body: JSON.stringify({ components }),
    });
    if (result.success !== true) throw new WhatsAppApiError(502);
  }

  async deleteTemplate(
    token: string,
    version: string,
    wabaId: string,
    templateId: string,
    name: string,
  ): Promise<void> {
    const url = this.graphUrl(version, `${wabaId}/message_templates`);
    url.searchParams.set('hsm_id', templateId);
    url.searchParams.set('name', name);
    const result = await this.json(url, { headers: this.auth(token), method: 'DELETE' });
    if (result.success !== true) throw new WhatsAppApiError(502);
  }

  async uploadTemplateSample(input: {
    token: string;
    version: string;
    appId: string;
    bytes: Uint8Array;
    filename: string;
    contentType: string;
  }): Promise<string> {
    const url = this.graphUrl(input.version, `${input.appId}/uploads`);
    url.searchParams.set('file_length', String(input.bytes.byteLength));
    url.searchParams.set('file_type', input.contentType);
    url.searchParams.set('file_name', input.filename);
    const session = await this.json(url, { headers: this.auth(input.token), method: 'POST' });
    const id = string(session.id);
    if (!id?.startsWith('upload:') || /[\r\n#]/.test(id) || id.includes('/') || id.includes('\\'))
      throw new WhatsAppApiError(502);
    // Keep the upload ID's signed query as supplied by Meta, on our fixed Graph origin.
    const result = await this.json(this.graphUrl(input.version, id), {
      headers: {
        Authorization: `OAuth ${input.token}`,
        file_offset: '0',
        'Content-Type': 'application/octet-stream',
      },
      method: 'POST',
      body: new Uint8Array(input.bytes).buffer,
    });
    const handle = string(result.h);
    if (!handle) throw new WhatsAppApiError(502);
    return handle;
  }

  private messageBody(message: WhatsAppOutboundMessage): JsonObject {
    if (message.type === 'text')
      return {
        text: { body: message.text, preview_url: message.previewUrl ?? false },
        type: 'text',
      };
    if (message.type === 'audio') {
      return {
        audio: { id: message.mediaId, ...(message.voice ? { voice: true } : {}) },
        type: 'audio',
      };
    }
    if (message.type === 'document') {
      return {
        document: {
          id: message.mediaId,
          ...(message.caption ? { caption: message.caption } : {}),
          ...(message.filename ? { filename: message.filename } : {}),
        },
        type: 'document',
      };
    }
    if (message.type === 'image' || message.type === 'video') {
      return {
        [message.type]: {
          id: message.mediaId,
          ...(message.caption ? { caption: message.caption } : {}),
        },
        type: message.type,
      };
    }
    if (message.type === 'sticker') return { sticker: { id: message.mediaId }, type: 'sticker' };
    if (message.type === 'template')
      return {
        template: {
          name: message.template.name,
          language: { code: message.template.languageCode },
          ...(message.template.components
            ? {
                components: message.template.components.map((component) =>
                  this.templateComponent(component),
                ),
              }
            : {}),
        },
        type: 'template',
      };
    if (message.type === 'reaction') {
      assertWhatsAppReactionEmoji(message.emoji);
      return {
        reaction: { emoji: message.emoji, message_id: message.messageId },
        type: 'reaction',
      };
    }
    if (message.type === 'location')
      return {
        location: {
          latitude: message.latitude,
          longitude: message.longitude,
          ...(message.name ? { name: message.name } : {}),
          ...(message.address ? { address: message.address } : {}),
        },
        type: 'location',
      };
    if (message.type === 'contact')
      return {
        contacts: [
          {
            name: {
              formatted_name: message.contact.formattedName,
              ...(message.contact.firstName ? { first_name: message.contact.firstName } : {}),
              ...(message.contact.lastName ? { last_name: message.contact.lastName } : {}),
            },
            phones: message.contact.phones.map((phone) => ({
              phone: phone.phone,
              ...(phone.type ? { type: phone.type } : {}),
              ...(phone.waId ? { wa_id: phone.waId } : {}),
            })),
            ...(message.contact.emails
              ? {
                  emails: message.contact.emails.map((email) => ({
                    email: email.email,
                    type: email.type,
                  })),
                }
              : {}),
          },
        ],
        type: 'contacts',
      };
    if (message.type === 'interactive')
      return { interactive: this.interactiveBody(message.interactive), type: 'interactive' };
    throw new Error('whatsapp_outbound_message_invalid');
  }

  private interactiveBody(input: WhatsAppInteractive): JsonObject {
    if (input.type === 'button')
      return {
        type: 'button',
        body: input.body,
        ...(input.footer ? { footer: input.footer } : {}),
        ...(input.header
          ? input.header.type === 'text'
            ? { header: input.header }
            : {
                header: {
                  type: input.header.type,
                  [input.header.type]: { id: input.header.mediaId },
                },
              }
          : {}),
        action: {
          buttons: input.action.buttons.map((button) => ({
            reply: { id: button.id, title: button.title },
            type: 'reply',
          })),
        },
      };
    return {
      type: 'list',
      body: input.body,
      ...(input.footer ? { footer: input.footer } : {}),
      ...(input.header ? { header: input.header } : {}),
      action: {
        button: input.action.button,
        sections: input.action.sections.map((section) => ({
          ...(section.title ? { title: section.title } : {}),
          rows: section.rows.map((row) => ({
            id: row.id,
            title: row.title,
            ...(row.description ? { description: row.description } : {}),
          })),
        })),
      },
    };
  }

  private templateComponent(
    component: NonNullable<WhatsAppTemplateSend['components']>[number],
  ): JsonObject {
    return {
      type: component.type,
      ...('subType' in component
        ? { sub_type: component.subType, index: String(component.index) }
        : {}),
      parameters: component.parameters.map((parameter) => {
        if (parameter.type === 'text') return { text: parameter.text, type: 'text' };
        if (parameter.type === 'currency')
          return {
            currency: {
              amount_1000: parameter.amount1000,
              code: parameter.code,
              fallback_value: parameter.fallbackValue,
            },
            type: 'currency',
          };
        if (parameter.type === 'date_time')
          return { date_time: { fallback_value: parameter.fallbackValue }, type: 'date_time' };
        if (parameter.type === 'payload') return { payload: parameter.payload, type: 'payload' };
        return { [parameter.type]: { id: parameter.mediaId }, type: parameter.type };
      }),
    };
  }

  private auth(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  private graphUrl(version: string, path: string): URL {
    if (!/^v\d+\.\d+$/.test(version)) throw new Error('whatsapp_graph_api_version_invalid');
    return new URL(`https://graph.facebook.com/${version}/${path.replace(/^\/+/, '')}`);
  }

  private async json(url: URL, init: RequestInit): Promise<JsonObject> {
    const response = await this.fetchImplementation(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw await this.error(response);
    const result = object(await response.json().catch(() => undefined));
    if (!result) throw new WhatsAppApiError(502);
    return result;
  }

  private async error(response: Response): Promise<WhatsAppApiError> {
    const retryAfter = Number(response.headers.get('retry-after'));
    const payload = object(await response.json().catch(() => undefined));
    const provider = object(payload?.error);
    const providerCode =
      typeof provider?.code === 'number' && Number.isSafeInteger(provider.code)
        ? provider.code
        : undefined;
    const providerSubcode =
      typeof provider?.error_subcode === 'number' && Number.isSafeInteger(provider.error_subcode)
        ? provider.error_subcode
        : undefined;
    const providerType = string(provider?.type);
    const providerMessage =
      typeof provider?.message === 'string' && provider.message.length > 0
        ? provider.message
        : undefined;
    const providerTraceId = string(payload?.fbtrace_id);
    const providerTransient =
      typeof provider?.is_transient === 'boolean' ? provider.is_transient : undefined;
    return new WhatsAppApiError(
      response.status,
      Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(86_400, retryAfter) : undefined,
      providerCode,
      providerSubcode,
      providerTransient,
      providerType,
      providerMessage,
      providerTraceId,
    );
  }

  private assertMediaDownloadUrl(url: URL): void {
    const hostAllowed = ['facebook.com', 'fbcdn.net', 'fbsbx.com', 'whatsapp.net'].some(
      (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
    );
    if (url.protocol !== 'https:' || !hostAllowed || url.username || url.password)
      throw new WhatsAppApiError(502);
  }
}

export const WHATSAPP_MEDIA_LIMITS = {
  audio: {
    maximumBytes: 16 * 1024 * 1024,
    mimeTypes: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'],
  },
  document: {
    maximumBytes: 100 * 1024 * 1024,
    mimeTypes: [
      'text/plain',
      'application/pdf',
      'application/msword',
      'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
  },
  image: { maximumBytes: 5 * 1024 * 1024, mimeTypes: ['image/jpeg', 'image/png'] },
  sticker: { maximumBytes: 100 * 1024, mimeTypes: ['image/webp'] },
  video: { maximumBytes: 16 * 1024 * 1024, mimeTypes: ['video/mp4', 'video/3gpp'] },
} as const;

export function assertWhatsAppMedia(
  kind: keyof typeof WHATSAPP_MEDIA_LIMITS,
  contentType: string,
  sizeBytes: number,
  bytes?: Uint8Array,
): void {
  const rule = WHATSAPP_MEDIA_LIMITS[kind];
  if (!rule.mimeTypes.includes(contentType as never))
    throw new Error('whatsapp_media_type_unsupported');
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0)
    throw new Error('whatsapp_media_size_invalid');
  if (bytes && bytes.byteLength !== sizeBytes) throw new Error('whatsapp_media_size_mismatch');
  if (sizeBytes > rule.maximumBytes) throw new Error('whatsapp_media_too_large');
  if (kind === 'audio' && contentType === 'audio/ogg') {
    const opusHead = new TextEncoder().encode('OpusHead');
    const search = bytes?.subarray(0, Math.min(bytes.byteLength, 65_536));
    let found = false;
    if (search)
      for (let offset = 0; offset <= search.byteLength - opusHead.byteLength; offset += 1) {
        if (opusHead.every((value, index) => search[offset + index] === value)) {
          found = true;
          break;
        }
      }
    if (
      !search ||
      search.byteLength < 4 ||
      new TextDecoder().decode(search.subarray(0, 4)) !== 'OggS' ||
      !found
    )
      throw new Error('whatsapp_media_ogg_opus_required');
  }
}
