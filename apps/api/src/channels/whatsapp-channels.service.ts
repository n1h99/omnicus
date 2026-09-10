import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelSecretsService, type EncryptedSecretEnvelope } from '@omnicus/channel-secrets';
import {
  WhatsAppCloudApi,
  WhatsAppApiError,
  whatsAppTemplateDisabledReason,
  buildWhatsAppTemplate,
  WhatsAppTemplateValidationError,
  type WhatsAppTemplateDraft,
} from '@omnicus/channel-whatsapp';
import { prepareMediaForWhatsApp } from '@omnicus/media-core';
import type { ApiEnvironment } from '@omnicus/config/server';
import { Prisma } from '@omnicus/database';

import { AuditService } from '../audit/audit.service';
import type { RequestSecurityContext } from '../auth/auth.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import type {
  CompleteWhatsAppSetupDto,
  CreateTelegramChannelDto,
  TestTelegramMessageDto,
  UpdateTelegramChannelDto,
} from './dto';
import { WhatsAppOutboundQueueService } from './whatsapp-outbound-queue.service';

type WhatsAppMetadata = {
  displayPhoneNumber?: string;
  graphApiVersion?: string;
  maskedToken?: string;
  name?: string;
  setupMode?: 'EMBEDDED_SIGNUP' | 'MANUAL';
  verifiedName?: string;
  webhookStatus?: 'CONNECTED' | 'NOT_CONNECTED';
  webhookUrl?: string;
};

export interface SafeWhatsAppChannel {
  businessAccountId: string | null;
  configured: boolean;
  createdAt: Date;
  displayPhoneNumber: string | null;
  graphApiVersion: string | null;
  id: string;
  lastErrorAt: Date | null;
  lastWebhookAt: Date | null;
  maskedToken: string | null;
  missingConfiguration: string[];
  name: string;
  phoneNumberId: string | null;
  projectId: string;
  setupMode: 'EMBEDDED_SIGNUP' | 'MANUAL';
  setupReady: boolean;
  status: string;
  type: 'WHATSAPP';
  updatedAt: Date;
  verifiedName: string | null;
  webhookStatus: 'CONNECTED' | 'NOT_CONNECTED';
  webhookUrl: string;
}

@Injectable()
export class WhatsAppChannelsService {
  private readonly api = new WhatsAppCloudApi();
  private readonly logger = new Logger(WhatsAppChannelsService.name);
  private readonly secrets: ChannelSecretsService;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<ApiEnvironment, true>,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(WhatsAppOutboundQueueService) private readonly queue: WhatsAppOutboundQueueService,
  ) {
    this.secrets = new ChannelSecretsService(config.get('CHANNEL_SECRETS_KEY', { infer: true }));
  }

  setup() {
    const missingConfiguration = this.globalMissingConfiguration();
    return {
      appId: this.config.get('WHATSAPP_META_APP_ID', { infer: true }) ?? null,
      callbackUrl: this.webhookUrl(),
      configurationId: this.config.get('WHATSAPP_META_CONFIGURATION_ID', { infer: true }) ?? null,
      configured: missingConfiguration.length === 0,
      graphApiVersion: this.config.get('WHATSAPP_GRAPH_API_VERSION', { infer: true }) ?? null,
      missingConfiguration,
    };
  }

  async list(projectId: string): Promise<SafeWhatsAppChannel[]> {
    const rows = await this.database.client.channelConnection.findMany({
      orderBy: { createdAt: 'desc' },
      where: { projectId, type: 'WHATSAPP' },
    });
    return rows.map((row) => this.safe(row));
  }

  async get(projectId: string, id: string): Promise<SafeWhatsAppChannel> {
    return this.safe(await this.connection(projectId, id));
  }

  async createManual(
    projectId: string,
    dto: CreateTelegramChannelDto,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ): Promise<SafeWhatsAppChannel> {
    if (dto.botToken !== undefined || (dto.type !== undefined && dto.type !== 'WHATSAPP'))
      throw new BadRequestException({ code: 'WHATSAPP_CONFIGURATION_INVALID' });
    const name = this.requiredText(dto.name, 'name');
    const accessToken = this.optionalText(dto.accessToken);
    const businessAccountId = this.optionalText(dto.businessAccountId);
    const phoneNumberId = this.optionalText(dto.phoneNumberId);
    const graphApiVersion = this.optionalText(dto.graphApiVersion);
    const id = crypto.randomUUID();
    const tokenEnvelope = accessToken ? this.encrypt(projectId, id, accessToken) : undefined;
    let row;
    try {
      row = await this.database.client.channelConnection.create({
        data: {
          credentialsEncrypted: tokenEnvelope
            ? ({ accessToken: tokenEnvelope } as unknown as Prisma.InputJsonValue)
            : {},
          id,
          projectId,
          providerAccountId: businessAccountId ?? null,
          providerIdentityId: phoneNumberId ?? null,
          status: 'DRAFT',
          type: 'WHATSAPP',
          webhookMetadata: {
            ...(graphApiVersion ? { graphApiVersion } : {}),
            ...(accessToken ? { maskedToken: this.mask(accessToken) } : {}),
            name,
            setupMode: 'MANUAL',
            webhookStatus: 'NOT_CONNECTED',
            webhookUrl: this.webhookUrl(),
          },
          webhookSecretEncrypted: Prisma.DbNull,
        },
      });
    } catch (error) {
      if (this.isUniqueConstraint(error)) throw this.phoneIdentityConflict();
      throw error;
    }
    await this.record('channel.create', row.id, projectId, actor, context, {
      status: row.status,
      type: 'WHATSAPP',
    });
    return this.safe(row);
  }

  async complete(
    projectId: string,
    dto: CompleteWhatsAppSetupDto,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ): Promise<SafeWhatsAppChannel> {
    const missing = this.globalMissingConfiguration();
    if (missing.length > 0)
      throw new ConflictException({
        code: 'WHATSAPP_META_CONFIGURATION_REQUIRED',
        details: { missingConfiguration: missing },
        message: 'WhatsApp Meta App configuration is required',
      });
    const wabaId = this.requiredText(dto.wabaId, 'wabaId');
    const phoneNumberId = this.requiredText(dto.phoneNumberId, 'phoneNumberId');
    const name = this.requiredText(dto.name, 'name');
    const target = dto.connectionId
      ? await this.database.client.channelConnection.findUnique({
          where: { projectId_id: { id: dto.connectionId, projectId } },
        })
      : undefined;
    if (dto.connectionId && (!target || target.type !== 'WHATSAPP'))
      throw new NotFoundException({
        code: 'CHANNEL_NOT_FOUND',
        message: 'WhatsApp connection was not found',
      });
    if (target?.status === 'ACTIVE') {
      if (target.providerAccountId === wabaId && target.providerIdentityId === phoneNumberId)
        return this.safe(target);
      throw new ConflictException({
        code: 'WHATSAPP_SETUP_TARGET_MISMATCH',
        message: 'This WhatsApp connection is already active with a different phone number',
      });
    }
    if (target && target.status !== 'DRAFT')
      throw new ConflictException({
        code: 'WHATSAPP_SETUP_STATE_CHANGED',
        message: 'This WhatsApp draft can no longer be completed',
      });
    if (
      target &&
      ((target.providerAccountId && target.providerAccountId !== wabaId) ||
        (target.providerIdentityId && target.providerIdentityId !== phoneNumberId))
    )
      throw new ConflictException({
        code: 'WHATSAPP_SETUP_TARGET_MISMATCH',
        message: 'The Meta account does not match the selected WhatsApp draft',
      });
    const existing = await this.database.client.channelConnection.findUnique({
      where: { type_providerIdentityId: { providerIdentityId: phoneNumberId, type: 'WHATSAPP' } },
    });
    if (existing && existing.id !== target?.id) {
      if (
        !target &&
        existing.projectId === projectId &&
        existing.providerAccountId === wabaId &&
        existing.status === 'ACTIVE'
      )
        return this.safe(existing);
      throw this.phoneIdentityConflict();
    }
    const graphApiVersion = this.config.get('WHATSAPP_GRAPH_API_VERSION', { infer: true })!;
    let token: string;
    let phone: { displayPhoneNumber?: string; id: string; verifiedName?: string };
    try {
      token = await this.api.exchangeEmbeddedSignupCode({
        appId: this.config.get('WHATSAPP_META_APP_ID', { infer: true })!,
        appSecret: this.config.get('WHATSAPP_META_APP_SECRET', { infer: true })!,
        code: this.requiredText(dto.code, 'code'),
        graphApiVersion,
      });
      phone = await this.api.wabaPhoneNumber(token, graphApiVersion, wabaId, phoneNumberId);
      await this.api.registerPhoneNumber(token, graphApiVersion, phoneNumberId, dto.pin.trim());
      await this.api.subscribeWaba(token, graphApiVersion, wabaId);
    } catch {
      throw new BadRequestException({
        code: 'WHATSAPP_EMBEDDED_SIGNUP_FAILED',
        message: 'WhatsApp signup could not be completed',
      });
    }
    const id = target?.id ?? crypto.randomUUID();
    let row;
    try {
      const data = {
        credentialsEncrypted: {
          accessToken: this.encrypt(projectId, id, token),
        } as unknown as Prisma.InputJsonValue,
        providerAccountId: wabaId,
        providerIdentityId: phoneNumberId,
        status: 'ACTIVE',
        webhookMetadata: {
          ...(phone.displayPhoneNumber ? { displayPhoneNumber: phone.displayPhoneNumber } : {}),
          graphApiVersion,
          maskedToken: this.mask(token),
          name,
          setupMode: 'EMBEDDED_SIGNUP',
          ...(phone.verifiedName ? { verifiedName: phone.verifiedName } : {}),
          webhookStatus: 'CONNECTED',
          webhookUrl: this.webhookUrl(),
        },
        webhookSecretEncrypted: Prisma.DbNull,
      } as const;
      if (target) {
        const activated = await this.database.client.channelConnection.updateMany({
          data,
          where: {
            id,
            projectId,
            status: 'DRAFT',
            type: 'WHATSAPP',
            AND: [
              { OR: [{ providerAccountId: null }, { providerAccountId: wabaId }] },
              { OR: [{ providerIdentityId: null }, { providerIdentityId: phoneNumberId }] },
            ],
          },
        });
        if (activated.count !== 1) {
          const replay = await this.database.client.channelConnection.findUnique({
            where: { projectId_id: { id, projectId } },
          });
          if (
            replay?.type === 'WHATSAPP' &&
            replay.status === 'ACTIVE' &&
            replay.providerAccountId === wabaId &&
            replay.providerIdentityId === phoneNumberId
          )
            return this.safe(replay);
          throw new ConflictException({
            code: 'WHATSAPP_SETUP_STATE_CHANGED',
            message: 'This WhatsApp draft changed while setup was being completed',
          });
        }
        row = await this.database.client.channelConnection.findUniqueOrThrow({
          where: { projectId_id: { id, projectId } },
        });
      } else {
        row = await this.database.client.channelConnection.create({
          data: { ...data, id, projectId, type: 'WHATSAPP' },
        });
      }
    } catch (error) {
      if (this.isUniqueConstraint(error)) {
        const replay = await this.database.client.channelConnection.findUnique({
          where: {
            type_providerIdentityId: { providerIdentityId: phoneNumberId, type: 'WHATSAPP' },
          },
        });
        if (
          replay?.projectId === projectId &&
          (!target || replay.id === target.id) &&
          replay.providerAccountId === wabaId &&
          replay.status === 'ACTIVE'
        )
          return this.safe(replay);
        throw this.phoneIdentityConflict();
      }
      throw error;
    }
    await this.record('channel.whatsapp.signup.complete', row.id, projectId, actor, context, {
      phoneNumberConfigured: true,
      status: 'ACTIVE',
    });
    return this.safe(row);
  }

  async update(
    projectId: string,
    id: string,
    dto: UpdateTelegramChannelDto,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ): Promise<SafeWhatsAppChannel> {
    if (dto.botToken !== undefined || (dto.type !== undefined && dto.type !== 'WHATSAPP'))
      throw new BadRequestException({ code: 'WHATSAPP_CONFIGURATION_INVALID' });
    const row = await this.connection(projectId, id);
    const metadata = this.metadata(row.webhookMetadata);
    const credentials = this.credentialContainer(row.credentialsEncrypted);
    const configurationChanged =
      dto.accessToken !== undefined ||
      dto.businessAccountId !== undefined ||
      dto.phoneNumberId !== undefined ||
      dto.graphApiVersion !== undefined;
    let updated;
    try {
      updated = await this.database.client.channelConnection.update({
        data: {
          ...(dto.accessToken
            ? {
                credentialsEncrypted: {
                  ...credentials,
                  accessToken: this.encrypt(
                    projectId,
                    id,
                    this.requiredText(dto.accessToken, 'accessToken'),
                  ),
                } as unknown as Prisma.InputJsonValue,
              }
            : {}),
          ...(dto.businessAccountId !== undefined
            ? { providerAccountId: this.requiredText(dto.businessAccountId, 'businessAccountId') }
            : {}),
          ...(dto.phoneNumberId !== undefined
            ? { providerIdentityId: this.requiredText(dto.phoneNumberId, 'phoneNumberId') }
            : {}),
          ...(configurationChanged ? { status: 'DRAFT' } : {}),
          webhookMetadata: {
            ...metadata,
            ...(dto.graphApiVersion
              ? { graphApiVersion: this.requiredText(dto.graphApiVersion, 'graphApiVersion') }
              : {}),
            ...(dto.accessToken
              ? { maskedToken: this.mask(this.requiredText(dto.accessToken, 'accessToken')) }
              : {}),
            ...(dto.name ? { name: this.requiredText(dto.name, 'name') } : {}),
            ...(configurationChanged ? { webhookStatus: 'NOT_CONNECTED' } : {}),
          },
        },
        where: { projectId_id: { id, projectId } },
      });
    } catch (error) {
      if (this.isUniqueConstraint(error)) throw this.phoneIdentityConflict();
      throw error;
    }
    await this.record('channel.update', id, projectId, actor, context, {
      configurationChanged,
      tokenReplaced: dto.accessToken !== undefined,
    });
    return this.safe(updated);
  }

  async connect(
    projectId: string,
    id: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ): Promise<SafeWhatsAppChannel> {
    const row = await this.connection(projectId, id);
    const missing = this.missing(row);
    if (missing.length > 0)
      throw new ConflictException({
        code: 'WHATSAPP_CONFIGURATION_INCOMPLETE',
        details: { missingConfiguration: missing },
        message: 'WhatsApp channel configuration is incomplete',
      });
    const token = this.decrypt(row);
    const metadata = this.metadata(row.webhookMetadata);
    try {
      const phone = await this.api.wabaPhoneNumber(
        token,
        metadata.graphApiVersion!,
        row.providerAccountId!,
        row.providerIdentityId!,
      );
      await this.api.subscribeWaba(token, metadata.graphApiVersion!, row.providerAccountId!);
      const updated = await this.database.client.channelConnection.update({
        data: {
          lastErrorAt: null,
          status: 'ACTIVE',
          webhookMetadata: {
            ...metadata,
            displayPhoneNumber: phone.displayPhoneNumber,
            verifiedName: phone.verifiedName,
            webhookStatus: 'CONNECTED',
            webhookUrl: this.webhookUrl(),
          },
        },
        where: { projectId_id: { id, projectId } },
      });
      await this.record('channel.webhook.connect', id, projectId, actor, context);
      return this.safe(updated);
    } catch {
      await this.database.client.channelConnection.update({
        data: { lastErrorAt: new Date(), status: 'ERROR' },
        where: { projectId_id: { id, projectId } },
      });
      throw new BadRequestException({
        code: 'WHATSAPP_CONNECTION_FAILED',
        message: 'WhatsApp connection could not be completed',
      });
    }
  }

  async test(
    projectId: string,
    id: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ): Promise<SafeWhatsAppChannel> {
    const row = await this.connection(projectId, id);
    const missing = this.missing(row);
    if (missing.length > 0)
      throw new ConflictException({ code: 'WHATSAPP_CONFIGURATION_INCOMPLETE' });
    try {
      await this.api.wabaPhoneNumber(
        this.decrypt(row),
        this.metadata(row.webhookMetadata).graphApiVersion!,
        row.providerAccountId!,
        row.providerIdentityId!,
      );
      const updated = await this.database.client.channelConnection.update({
        data: { lastErrorAt: null },
        where: { projectId_id: { id, projectId } },
      });
      await this.record('channel.test', id, projectId, actor, context);
      return this.safe(updated);
    } catch {
      await this.database.client.channelConnection.update({
        data: { lastErrorAt: new Date(), status: 'ERROR' },
        where: { projectId_id: { id, projectId } },
      });
      throw new BadRequestException({
        code: 'WHATSAPP_CONNECTION_TEST_FAILED',
        message: 'WhatsApp connection test failed',
      });
    }
  }

  async disable(
    projectId: string,
    id: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ): Promise<SafeWhatsAppChannel> {
    const row = await this.connection(projectId, id);
    const metadata = this.metadata(row.webhookMetadata);
    // WABA subscription is shared by every phone number under the app. Keep it
    // registered and disable this tenant route locally.
    const updated = await this.database.client.channelConnection.update({
      data: {
        status: 'DISABLED',
        webhookMetadata: { ...metadata, webhookStatus: 'NOT_CONNECTED' },
      },
      where: { projectId_id: { id, projectId } },
    });
    await this.record('channel.disable', id, projectId, actor, context);
    return this.safe(updated);
  }

  async createTestMessage(
    projectId: string,
    connectionId: string,
    dto: TestTelegramMessageDto,
  ): Promise<{ messageId: string; outboxRecordId: string }> {
    if ((dto.contactId === undefined) === (dto.channelIdentityId === undefined))
      throw new BadRequestException({ code: 'OUTBOUND_RECIPIENT_REQUIRED' });
    const row = await this.connection(projectId, connectionId);
    if (row.status !== 'ACTIVE') throw new ConflictException({ code: 'CHANNEL_NOT_ACTIVE' });
    const identity = await this.database.client.channelIdentity.findFirst({
      where: {
        channel: 'WHATSAPP',
        connectionId,
        projectId,
        ...(dto.channelIdentityId ? { id: dto.channelIdentityId } : { contactId: dto.contactId! }),
      },
    });
    if (!identity) throw new NotFoundException({ code: 'CHANNEL_IDENTITY_NOT_FOUND' });
    const existing = await this.database.client.outboxRecord.findUnique({
      where: { projectId_idempotencyKey: { idempotencyKey: dto.idempotencyKey, projectId } },
    });
    if (existing)
      return {
        messageId: String((existing.payload as { messageId?: unknown }).messageId),
        outboxRecordId: existing.id,
      };
    const result = await this.database.client.$transaction(async (transaction) => {
      const conversation = await transaction.conversation.upsert({
        create: {
          connectionId,
          contactId: identity.contactId,
          externalChatId: identity.externalUserId,
          projectId,
        },
        update: {},
        where: {
          projectId_connectionId_externalChatId: {
            connectionId,
            externalChatId: identity.externalUserId,
            projectId,
          },
        },
      });
      if (!conversation.serviceWindowExpiresAt || conversation.serviceWindowExpiresAt <= new Date())
        throw new ConflictException({
          code: 'WHATSAPP_TEMPLATE_REQUIRED',
          message: 'An approved WhatsApp template is required outside the service window',
        });
      const message = await transaction.message.create({
        data: {
          connectionId,
          contactId: identity.contactId,
          content: { text: dto.text },
          conversationId: conversation.id,
          direction: 'OUTBOUND',
          projectId,
          status: 'QUEUED',
          type: 'TEXT',
        },
      });
      const outbox = await transaction.outboxRecord.create({
        data: {
          connectionId,
          idempotencyKey: dto.idempotencyKey,
          kind: 'WHATSAPP',
          nextAttemptAt: new Date(),
          payload: { channelIdentityId: identity.id, messageId: message.id },
          projectId,
        },
      });
      return { messageId: message.id, outboxRecordId: outbox.id };
    });
    try {
      await this.queue.enqueue(result.outboxRecordId);
    } catch {
      this.logger.warn({
        message: 'WhatsApp outbound enqueue failed; durable intent remains pending',
        outboxRecordId: result.outboxRecordId,
      });
    }
    return result;
  }

  async templates(projectId: string, connectionId: string) {
    await this.connection(projectId, connectionId);
    const templates = await this.database.client.whatsAppMessageTemplate.findMany({
      orderBy: [{ name: 'asc' }, { languageCode: 'asc' }],
      select: {
        category: true,
        components: true,
        id: true,
        languageCode: true,
        lastSyncedAt: true,
        name: true,
        quality: true,
        rejectionReasonCode: true,
        status: true,
      },
      where: { connectionId, projectId },
    });
    return templates.map((template) => {
      const disabledReason = this.templateDisabledReason(template);
      return {
        ...template,
        ...(disabledReason ? { disabledReason } : {}),
        sendable: !disabledReason,
      };
    });
  }

  async managementContext(projectId: string, connectionId: string) {
    const row = await this.connection(projectId, connectionId);
    if (this.missing(row).length)
      throw new ConflictException({ code: 'WHATSAPP_CONFIGURATION_INCOMPLETE' });
    return {
      row,
      token: this.decrypt(row),
      version: this.metadata(row.webhookMetadata).graphApiVersion!,
      wabaId: row.providerAccountId!,
      phoneNumberId: row.providerIdentityId!,
    };
  }

  async saveTemplate(
    projectId: string,
    connectionId: string,
    draft: WhatsAppTemplateDraft,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
    templateId?: string,
  ) {
    const { row, token, version, wabaId } = await this.managementContext(projectId, connectionId);
    if (row.status !== 'ACTIVE') throw new ConflictException({ code: 'CHANNEL_NOT_ACTIVE' });
    let payload: ReturnType<typeof buildWhatsAppTemplate>;
    try {
      payload = buildWhatsAppTemplate(draft);
    } catch (error) {
      if (error instanceof WhatsAppTemplateValidationError)
        throw new BadRequestException({
          code: 'WHATSAPP_TEMPLATE_INVALID',
          details: { field: error.field, reason: error.message },
        });
      throw error;
    }
    const current = templateId
      ? await this.database.client.whatsAppMessageTemplate.findFirst({
          where: { projectId, connectionId, id: templateId },
        })
      : null;
    if (templateId && !current)
      throw new NotFoundException({ code: 'WHATSAPP_TEMPLATE_NOT_FOUND' });
    if (
      current &&
      (current.name !== payload.name ||
        current.languageCode !== payload.language ||
        current.category !== payload.category)
    )
      throw new ConflictException({ code: 'WHATSAPP_TEMPLATE_IDENTITY_IMMUTABLE' });
    if (current && !['APPROVED', 'REJECTED', 'PAUSED'].includes(current.status))
      throw new ConflictException({ code: 'WHATSAPP_TEMPLATE_NOT_EDITABLE' });
    if (current && this.templateDisabledReason({ ...current, status: 'APPROVED' }))
      throw new ConflictException({ code: 'WHATSAPP_TEMPLATE_NOT_EDITABLE' });
    let provider: Record<string, unknown>;
    try {
      if (current) {
        await this.api.editTemplate(token, version, current.providerTemplateId, payload.components);
        provider = { ...payload, id: current.providerTemplateId, status: 'PENDING' };
      } else {
        const result = await this.api.createTemplate(token, version, wabaId, payload);
        provider = { ...payload, ...result };
      }
    } catch (error) {
      throw this.managementError(error, 'WHATSAPP_TEMPLATE_SAVE_FAILED');
    }
    const normalized = this.normalizeTemplate(provider);
    if (!normalized) throw new BadRequestException({ code: 'WHATSAPP_TEMPLATE_SAVE_FAILED' });
    // All phone numbers on the same WABA share templates. Keep existing local IDs stable.
    const connections = await this.database.client.channelConnection.findMany({
      select: { id: true },
      where: { projectId, type: 'WHATSAPP', providerAccountId: wabaId },
    });
    await this.database.client.$transaction(async (transaction) => {
      for (const connection of connections) {
        await transaction.whatsAppMessageTemplate.upsert({
          create: {
            ...normalized,
            projectId,
            connectionId: connection.id,
            lastSyncedAt: new Date(),
          },
          update: { ...normalized, lastSyncedAt: new Date() },
          where: {
            projectId_connectionId_name_languageCode: {
              projectId,
              connectionId: connection.id,
              name: normalized.name,
              languageCode: normalized.languageCode,
            },
          },
        });
      }
    });
    await this.record(
      current ? 'whatsapp.template.edit' : 'whatsapp.template.create',
      connectionId,
      projectId,
      actor,
      context,
      { name: normalized.name, languageCode: normalized.languageCode, status: normalized.status },
    );
    return this.templates(projectId, connectionId);
  }

  async deleteTemplate(
    projectId: string,
    connectionId: string,
    templateId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const { token, version, wabaId } = await this.managementContext(projectId, connectionId);
    const template = await this.database.client.whatsAppMessageTemplate.findFirst({
      where: { projectId, connectionId, id: templateId },
    });
    if (!template) throw new NotFoundException({ code: 'WHATSAPP_TEMPLATE_NOT_FOUND' });
    try {
      await this.api.deleteTemplate(
        token,
        version,
        wabaId,
        template.providerTemplateId,
        template.name,
      );
    } catch (error) {
      throw this.managementError(error, 'WHATSAPP_TEMPLATE_DELETE_FAILED');
    }
    await this.database.client.whatsAppMessageTemplate.deleteMany({
      where: {
        projectId,
        providerTemplateId: template.providerTemplateId,
        connection: { providerAccountId: wabaId, type: 'WHATSAPP' },
      },
    });
    await this.record('whatsapp.template.delete', connectionId, projectId, actor, context, {
      name: template.name,
      languageCode: template.languageCode,
    });
    return this.templates(projectId, connectionId);
  }

  async uploadTemplateSample(
    projectId: string,
    connectionId: string,
    file: { buffer: Buffer; mimetype: string; originalname: string } | undefined,
  ) {
    const { token, version } = await this.managementContext(projectId, connectionId);
    const appId = this.config.get('WHATSAPP_META_APP_ID', { infer: true });
    if (!appId) throw new ConflictException({ code: 'WHATSAPP_META_CONFIGURATION_REQUIRED' });
    if (
      !file ||
      !['image/jpeg', 'image/png', 'video/mp4', 'application/pdf'].includes(file.mimetype)
    )
      throw new BadRequestException({ code: 'WHATSAPP_TEMPLATE_SAMPLE_INVALID' });
    try {
      const prepared = await prepareMediaForWhatsApp({
        bytes: file.buffer,
        declaredMimeType: file.mimetype,
        filename: file.originalname,
        kind: file.mimetype.startsWith('image/')
          ? 'PHOTO'
          : file.mimetype === 'video/mp4'
            ? 'VIDEO'
            : 'DOCUMENT',
        maximumBytes: 16 * 1024 * 1024,
      });
      const handle = await this.api.uploadTemplateSample({
        token,
        version,
        appId,
        bytes: prepared.bytes,
        filename: file.originalname,
        contentType: file.mimetype,
      });
      return {
        handle,
        format: file.mimetype.startsWith('image/')
          ? 'IMAGE'
          : file.mimetype === 'video/mp4'
            ? 'VIDEO'
            : 'DOCUMENT',
      };
    } catch (error) {
      throw this.managementError(error, 'WHATSAPP_TEMPLATE_SAMPLE_INVALID');
    }
  }

  private managementError(error: unknown, code: string) {
    return new BadRequestException({
      code,
      details:
        error instanceof WhatsAppApiError
          ? {
              providerCode: error.providerCode ?? null,
              providerSubcode: error.providerSubcode ?? null,
            }
          : {},
    });
  }

  async syncTemplates(projectId: string, connectionId: string) {
    const row = await this.connection(projectId, connectionId);
    const missing = this.missing(row);
    if (missing.length > 0)
      throw new ConflictException({ code: 'WHATSAPP_CONFIGURATION_INCOMPLETE' });
    let providerTemplates: Record<string, unknown>[];
    try {
      providerTemplates = await this.api.templates(
        this.decrypt(row),
        this.metadata(row.webhookMetadata).graphApiVersion!,
        row.providerAccountId!,
      );
    } catch {
      throw new BadRequestException({
        code: 'WHATSAPP_TEMPLATE_SYNC_FAILED',
        message: 'WhatsApp templates could not be synchronized',
      });
    }
    const syncedAt = new Date();
    await this.database.client.$transaction(async (transaction) => {
      await transaction.whatsAppMessageTemplate.updateMany({
        data: { status: 'UNKNOWN' },
        where: { connectionId, projectId },
      });
      for (const provider of providerTemplates) {
        const normalized = this.normalizeTemplate(provider);
        if (!normalized) continue;
        await transaction.whatsAppMessageTemplate.upsert({
          create: { ...normalized, connectionId, lastSyncedAt: syncedAt, projectId },
          update: { ...normalized, lastSyncedAt: syncedAt },
          where: {
            projectId_connectionId_name_languageCode: {
              connectionId,
              projectId,
              name: normalized.name,
              languageCode: normalized.languageCode,
            },
          },
        });
      }
    });
    return this.templates(projectId, connectionId);
  }

  private normalizeTemplate(provider: Record<string, unknown>) {
    const providerTemplateId = this.text(provider.id);
    const name = this.text(provider.name);
    const languageCode = this.text(provider.language);
    if (!providerTemplateId || !name || !languageCode) return null;
    const status = ['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED'].includes(
      String(provider.status),
    )
      ? (String(provider.status) as 'APPROVED' | 'DISABLED' | 'PAUSED' | 'PENDING' | 'REJECTED')
      : ('UNKNOWN' as const);
    const category = ['AUTHENTICATION', 'MARKETING', 'UTILITY'].includes(String(provider.category))
      ? (String(provider.category) as 'AUTHENTICATION' | 'MARKETING' | 'UTILITY')
      : ('UNKNOWN' as const);
    const qualityValue =
      typeof provider.quality_score === 'object' && provider.quality_score
        ? (provider.quality_score as Record<string, unknown>).score
        : provider.quality_score;
    const quality = ['GREEN', 'YELLOW', 'RED'].includes(String(qualityValue))
      ? (String(qualityValue) as 'GREEN' | 'RED' | 'YELLOW')
      : ('UNKNOWN' as const);
    return {
      category,
      components: this.normalizeComponents(provider.components),
      languageCode,
      name,
      providerTemplateId,
      quality,
      rejectionReasonCode:
        status === 'REJECTED'
          ? (this.text(provider.rejected_reason)?.slice(0, 1024) ?? 'META_REJECTED')
          : null,
      status,
    };
  }

  private normalizeComponents(value: unknown): Prisma.InputJsonValue {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 32).flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
      const component = candidate as Record<string, unknown>;
      const type = this.text(component.type)?.toUpperCase();
      if (!type || !['HEADER', 'BODY', 'FOOTER', 'BUTTONS'].includes(type))
        return [{ type: 'BODY', unsupportedReason: 'WHATSAPP_TEMPLATE_COMPONENT_UNSUPPORTED' }];
      const format = this.text(component.format)?.toUpperCase();
      const componentText = this.text(component.text);
      const parameterStyle = this.parameterStyle(componentText);
      let unsupportedReason =
        type === 'HEADER' && format === 'LOCATION'
          ? 'WHATSAPP_TEMPLATE_LOCATION_HEADER_UNSUPPORTED'
          : parameterStyle === 'named' || parameterStyle === 'mixed'
            ? 'WHATSAPP_TEMPLATE_NAMED_VARIABLES_UNSUPPORTED'
            : undefined;
      const buttons = Array.isArray(component.buttons)
        ? component.buttons.slice(0, 10).flatMap((raw) => {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
            const button = raw as Record<string, unknown>;
            const buttonType = this.text(button.type)?.toUpperCase();
            const text = this.text(button.text);
            const url = this.text(button.url);
            const buttonParameterStyle = this.parameterStyle(url);
            if (buttonParameterStyle === 'named' || buttonParameterStyle === 'mixed')
              unsupportedReason = 'WHATSAPP_TEMPLATE_NAMED_VARIABLES_UNSUPPORTED';
            if (
              !buttonType ||
              !text ||
              !['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].includes(buttonType)
            )
              unsupportedReason = 'WHATSAPP_TEMPLATE_COMPONENT_UNSUPPORTED';
            return buttonType && text && ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].includes(buttonType)
              ? [
                  {
                    ...(buttonType === 'URL'
                      ? {
                          dynamic: buttonParameterStyle !== 'none',
                          parameterStyle: buttonParameterStyle,
                          ...(buttonParameterStyle === 'named' || buttonParameterStyle === 'mixed'
                            ? {
                                unsupportedReason: 'WHATSAPP_TEMPLATE_NAMED_VARIABLES_UNSUPPORTED',
                              }
                            : {}),
                        }
                      : {}),
                    text: text.slice(0, 80),
                    type: buttonType,
                    ...(url ? { url: url.slice(0, 2000) } : {}),
                    ...(this.text(button.phone_number)
                      ? { phoneNumber: this.text(button.phone_number)!.slice(0, 32) }
                      : {}),
                    ...(Array.isArray(button.example)
                      ? {
                          examples: button.example
                            .filter((value): value is string => typeof value === 'string')
                            .slice(0, 1)
                            .map((value) => value.slice(0, 2000)),
                        }
                      : {}),
                  },
                ]
              : [];
          })
        : undefined;
      if (
        type === 'HEADER' &&
        !['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'].includes(format ?? '')
      )
        unsupportedReason = 'WHATSAPP_TEMPLATE_COMPONENT_UNSUPPORTED';
      return [
        {
          ...(buttons?.length ? { buttons } : {}),
          ...(format && ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'].includes(format)
            ? { format }
            : {}),
          ...(componentText ? { text: componentText.slice(0, 4_096) } : {}),
          ...(component.example &&
          typeof component.example === 'object' &&
          !Array.isArray(component.example)
            ? { example: this.templateExamples(component.example as Record<string, unknown>) }
            : {}),
          ...(type === 'BODY' || type === 'HEADER' ? { parameterStyle } : {}),
          ...(unsupportedReason ? { unsupportedReason } : {}),
          type,
        },
      ];
    }) as Prisma.InputJsonValue;
  }

  private templateExamples(value: Record<string, unknown>): Prisma.InputJsonValue {
    const strings = (input: unknown) =>
      Array.isArray(input)
        ? input
            .filter((v): v is string => typeof v === 'string')
            .slice(0, 100)
            .map((v) => v.slice(0, 1024))
        : [];
    return {
      ...(Array.isArray(value.header_text) ? { header_text: strings(value.header_text) } : {}),
      ...(Array.isArray(value.body_text)
        ? { body_text: value.body_text.slice(0, 1).map(strings) }
        : {}),
    };
  }

  private parameterStyle(value: string | undefined): 'mixed' | 'named' | 'none' | 'positional' {
    if (!value) return 'none';
    const placeholders = [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((match) =>
      match[1]!.trim(),
    );
    if (placeholders.length === 0) return 'none';
    const positional = placeholders.some((placeholder) => /^\d+$/.test(placeholder));
    const named = placeholders.some((placeholder) => !/^\d+$/.test(placeholder));
    return positional && named ? 'mixed' : positional ? 'positional' : 'named';
  }

  private templateDisabledReason(template: {
    category: string;
    components: Prisma.JsonValue;
    status: string;
  }): string | undefined {
    return whatsAppTemplateDisabledReason(template);
  }

  private async connection(projectId: string, id: string) {
    const row = await this.database.client.channelConnection.findUnique({
      where: { projectId_id: { id, projectId } },
    });
    if (!row || row.type !== 'WHATSAPP')
      throw new NotFoundException({ code: 'CHANNEL_NOT_FOUND', message: 'Channel was not found' });
    return row;
  }

  private missing(row: {
    credentialsEncrypted: Prisma.JsonValue;
    providerAccountId: string | null;
    providerIdentityId: string | null;
    webhookMetadata: Prisma.JsonValue | null;
  }): string[] {
    const metadata = this.metadata(row.webhookMetadata);
    return [
      ...(!this.credentialContainer(row.credentialsEncrypted).accessToken ? ['accessToken'] : []),
      ...(!row.providerAccountId ? ['businessAccountId'] : []),
      ...(!row.providerIdentityId ? ['phoneNumberId'] : []),
      ...(!metadata.graphApiVersion ? ['graphApiVersion'] : []),
      ...(!this.config.get('WHATSAPP_META_APP_SECRET', { infer: true }) ? ['metaAppSecret'] : []),
      ...(!this.config.get('WHATSAPP_META_WEBHOOK_VERIFY_TOKEN', { infer: true })
        ? ['webhookVerifyToken']
        : []),
    ];
  }

  private globalMissingConfiguration(): string[] {
    return [
      ...(!this.config.get('WHATSAPP_META_APP_ID', { infer: true }) ? ['metaAppId'] : []),
      ...(!this.config.get('WHATSAPP_META_APP_SECRET', { infer: true }) ? ['metaAppSecret'] : []),
      ...(!this.config.get('WHATSAPP_META_CONFIGURATION_ID', { infer: true })
        ? ['configurationId']
        : []),
      ...(!this.config.get('WHATSAPP_META_WEBHOOK_VERIFY_TOKEN', { infer: true })
        ? ['webhookVerifyToken']
        : []),
      ...(!this.config.get('WHATSAPP_GRAPH_API_VERSION', { infer: true })
        ? ['graphApiVersion']
        : []),
    ];
  }

  private safe(row: {
    createdAt: Date;
    credentialsEncrypted: Prisma.JsonValue;
    id: string;
    lastErrorAt: Date | null;
    lastWebhookAt: Date | null;
    projectId: string;
    providerAccountId: string | null;
    providerIdentityId: string | null;
    status: string;
    updatedAt: Date;
    webhookMetadata: Prisma.JsonValue | null;
  }): SafeWhatsAppChannel {
    const metadata = this.metadata(row.webhookMetadata);
    const missingConfiguration = this.missing(row);
    return {
      businessAccountId: row.providerAccountId,
      configured: missingConfiguration.length === 0,
      createdAt: row.createdAt,
      displayPhoneNumber: metadata.displayPhoneNumber ?? null,
      graphApiVersion: metadata.graphApiVersion ?? null,
      id: row.id,
      lastErrorAt: row.lastErrorAt,
      lastWebhookAt: row.lastWebhookAt,
      maskedToken: metadata.maskedToken ?? null,
      missingConfiguration,
      name: metadata.name ?? 'WhatsApp',
      phoneNumberId: row.providerIdentityId,
      projectId: row.projectId,
      setupMode: metadata.setupMode ?? 'MANUAL',
      setupReady: missingConfiguration.length === 0,
      status: row.status,
      type: 'WHATSAPP',
      updatedAt: row.updatedAt,
      verifiedName: metadata.verifiedName ?? null,
      webhookStatus: metadata.webhookStatus ?? 'NOT_CONNECTED',
      webhookUrl: metadata.webhookUrl ?? this.webhookUrl(),
    };
  }

  private metadata(value: Prisma.JsonValue | null): WhatsAppMetadata {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as WhatsAppMetadata)
      : {};
  }

  private credentialContainer(value: Prisma.JsonValue): { accessToken?: EncryptedSecretEnvelope } {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as unknown as { accessToken?: EncryptedSecretEnvelope })
      : {};
  }

  private encrypt(projectId: string, connectionId: string, plaintext: string) {
    return this.secrets.encryptSecret({
      channelConnectionId: connectionId,
      channelType: 'whatsapp',
      field: 'accessToken',
      plaintext,
      projectId,
    });
  }

  private decrypt(row: { credentialsEncrypted: Prisma.JsonValue; id: string; projectId: string }) {
    const envelope = this.credentialContainer(row.credentialsEncrypted).accessToken;
    if (!envelope) throw new Error('whatsapp_access_token_unavailable');
    return this.secrets.decryptSecret({
      channelConnectionId: row.id,
      channelType: 'whatsapp',
      envelope,
      field: 'accessToken',
      projectId: row.projectId,
    });
  }

  private mask(token: string): string {
    return `••••${token.slice(-4)}`;
  }

  private optionalText(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
  }

  private requiredText(value: string, field: string): string {
    const normalized = value.trim();
    if (!normalized)
      throw new BadRequestException({
        code: 'WHATSAPP_CONFIGURATION_INVALID',
        details: { field },
        message: 'WhatsApp configuration contains an empty value',
      });
    return normalized;
  }

  private isUniqueConstraint(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  private phoneIdentityConflict(): ConflictException {
    return new ConflictException({
      code: 'WHATSAPP_PHONE_IDENTITY_CONFLICT',
      message: 'This WhatsApp phone number is already connected',
    });
  }

  private webhookUrl(): string {
    return `${this.config.get('API_PUBLIC_URL', { infer: true })}/webhooks/whatsapp`;
  }

  private text(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private async record(
    action: string,
    entityId: string,
    projectId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
    afterSafeJson?: Prisma.InputJsonValue,
  ) {
    await this.audit.record({
      action,
      actorUserId: actor.userId,
      afterSafeJson,
      correlationId: context.correlationId,
      entityId,
      entityType: 'ChannelConnection',
      ip: context.ip,
      projectId,
      userAgent: context.userAgent,
    });
  }
}
