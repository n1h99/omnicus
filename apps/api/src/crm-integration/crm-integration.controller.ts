import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Patch,
  Post,
  Put,
  Query,
  Param,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { MediaService } from '../media/media.service';
import {
  CrmIntegrationAuthGuard,
  type AuthenticatedCrmIntegrationRequest,
} from './crm-integration-auth.guard';
import { CrmContactSyncService } from './crm-contact-sync.service';
import { CrmOutboundService } from './crm-outbound.service';
import { CrmTelegramV3Service } from './crm-telegram-v3.service';
import { CrmWhatsAppV4Service } from './crm-whatsapp-v4.service';
import {
  CrmAutomationStateDto,
  CrmAutomationStateQueryDto,
  CrmBotInterfaceDto,
  CrmBotInterfaceQueryDto,
  CrmCapabilitiesQueryDto,
  CrmChatActionDto,
  CrmContactUpsertDto,
  CrmDraftDto,
  CrmMediaUploadDto,
  CrmMediaGroupDto,
  CrmMessageMutationDto,
  CrmOperationQueryDto,
  CrmOutboundMessageDto,
  CrmPinMessageDto,
  CrmReactionDto,
  CrmRetryOperationDto,
  CrmScheduledMessageDto,
  CrmScheduledMessageQueryDto,
  CrmScheduledMessageUpdateDto,
  CrmTelegramScopeDto,
  CrmWhatsAppTemplateQueryDto,
  CrmWhatsAppConnectionsQueryDto,
  CrmWhatsAppConnectDto,
} from './dto';

@ApiTags('crm integration')
@ApiBearerAuth()
@ApiExtraModels(
  CrmAutomationStateDto,
  CrmAutomationStateQueryDto,
  CrmBotInterfaceDto,
  CrmBotInterfaceQueryDto,
  CrmCapabilitiesQueryDto,
  CrmChatActionDto,
  CrmContactUpsertDto,
  CrmDraftDto,
  CrmMediaUploadDto,
  CrmMediaGroupDto,
  CrmMessageMutationDto,
  CrmOutboundMessageDto,
  CrmPinMessageDto,
  CrmReactionDto,
  CrmRetryOperationDto,
  CrmScheduledMessageDto,
  CrmScheduledMessageQueryDto,
  CrmScheduledMessageUpdateDto,
  CrmTelegramScopeDto,
  CrmWhatsAppTemplateQueryDto,
)
@UseGuards(CrmIntegrationAuthGuard)
@Controller('integrations/v1/crm')
export class CrmIntegrationController {
  constructor(
    @Inject(CrmOutboundService) private readonly outbound: CrmOutboundService,
    @Inject(CrmContactSyncService) private readonly contactSync: CrmContactSyncService,
    @Inject(MediaService) private readonly media: MediaService,
    @Inject(CrmTelegramV3Service) private readonly telegramV3: CrmTelegramV3Service,
    @Inject(CrmWhatsAppV4Service) private readonly whatsappV4: CrmWhatsAppV4Service,
  ) {}

  @Post('contacts/upsert')
  @HttpCode(200)
  @ApiBody({ type: CrmContactUpsertDto })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-Id', required: true })
  @ApiOkResponse({ description: 'CRM lead profile idempotently synchronized to a contact' })
  upsertContact(
    @Body() dto: CrmContactUpsertDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    this.assertHeaders(idempotencyKey, correlationId);
    return this.contactSync.upsert(
      dto,
      idempotencyKey!,
      correlationId!,
      request.crmIntegration?.projectId,
    );
  }

  @Get('contacts/whatsapp/connections')
  whatsAppConnections(
    @Query() query: CrmWhatsAppConnectionsQueryDto,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    return this.contactSync.whatsAppConnections(query, request.crmIntegration?.projectId);
  }

  @Post('contacts/whatsapp/connect')
  @HttpCode(200)
  connectWhatsApp(
    @Body() dto: CrmWhatsAppConnectDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    this.assertHeaders(idempotencyKey, correlationId);
    return this.contactSync.connectWhatsApp(
      dto,
      idempotencyKey!,
      correlationId!,
      request.crmIntegration?.projectId,
    );
  }

  @Get('capabilities')
  @ApiOkResponse({ description: 'Connection-scoped channel capability matrix' })
  capabilities(
    @Query() query: CrmCapabilitiesQueryDto,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    return query.channel === 'whatsapp'
      ? this.whatsappV4.capabilities(query, request.crmIntegration?.projectId)
      : this.telegramV3.capabilities(query, request.crmIntegration?.projectId);
  }

  @Get('conversations/automation-state')
  @ApiOkResponse({ description: 'Effective channel conversation automation mode' })
  automationState(
    @Query() query: CrmAutomationStateQueryDto,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    return query.channel === 'whatsapp'
      ? this.whatsappV4.automationState(query, request.crmIntegration?.projectId)
      : this.telegramV3.automationState(query, request.crmIntegration?.projectId);
  }

  @Get('bot-interface')
  botInterface(
    @Query() query: CrmBotInterfaceQueryDto,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    return this.telegramV3.botInterface(query, request.crmIntegration?.projectId);
  }

  @Put('bot-interface')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-Id', required: true })
  setBotInterface(
    @Body() dto: CrmBotInterfaceDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    this.assertHeaders(idempotencyKey, correlationId);
    return this.telegramV3.setBotInterface(
      dto,
      idempotencyKey!,
      correlationId!,
      request.crmIntegration?.projectId,
    );
  }

  @Put('conversations/automation-state')
  @HttpCode(200)
  @ApiBody({ type: CrmAutomationStateDto })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-Id', required: true })
  @ApiOkResponse({ description: 'Channel conversation automation mode updated' })
  setAutomationState(
    @Body() dto: CrmAutomationStateDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    this.assertHeaders(idempotencyKey, correlationId);
    return dto.identity.channel === 'whatsapp'
      ? this.whatsappV4.setAutomationState(
          dto,
          idempotencyKey!,
          correlationId!,
          request.crmIntegration?.projectId,
        )
      : this.telegramV3.setAutomationState(
          dto,
          idempotencyKey!,
          correlationId!,
          request.crmIntegration?.projectId,
        );
  }

  @Get('connection')
  @ApiOkResponse({ description: 'Authenticated CRM connection metadata' })
  async connection(@Req() request: AuthenticatedCrmIntegrationRequest) {
    return this.outbound.connectionStatus(request.crmIntegration?.projectId);
  }

  @Post('media')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-Id', required: true })
  @ApiBody({
    schema: {
      properties: {
        channel: { default: 'telegram', enum: ['telegram', 'whatsapp'], type: 'string' },
        crmProjectId: { type: 'string' },
        file: { format: 'binary', type: 'string' },
        kind: {
          enum: [
            'PHOTO',
            'DOCUMENT',
            'VIDEO',
            'AUDIO',
            'VOICE',
            'VIDEO_NOTE',
            'ANIMATION',
            'STICKER',
          ],
          type: 'string',
        },
        omnicusProjectId: { type: 'string' },
      },
      required: ['crmProjectId', 'omnicusProjectId', 'kind', 'file'],
      type: 'object',
    },
  })
  async uploadMedia(
    @Body() dto: CrmMediaUploadDto,
    @UploadedFile()
    file:
      | {
          buffer: Buffer;
          mimetype: string;
          originalname: string;
          size: number;
        }
      | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    this.assertHeaders(idempotencyKey, correlationId);
    await this.outbound.assertProjectRoute(
      dto.crmProjectId,
      dto.omnicusProjectId,
      request.crmIntegration?.projectId,
    );
    const asset = await this.media.uploadFromService(
      dto.omnicusProjectId,
      dto.kind,
      file,
      idempotencyKey!,
      correlationId!,
      dto.channel ?? 'telegram',
    );
    return {
      kind: asset.kind,
      mediaAssetId: asset.id,
      sizeBytes: asset.sizeBytes,
      status: asset.status,
      validationChannel: asset.validationChannel,
    };
  }

  @Post('messages/outbound')
  @HttpCode(200)
  @ApiBody({ type: CrmOutboundMessageDto })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-Id', required: true })
  @ApiOkResponse({ description: 'Message durably queued for channel delivery' })
  async message(
    @Body() dto: CrmOutboundMessageDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    this.assertHeaders(idempotencyKey, correlationId);
    return dto.identity.channel === 'whatsapp'
      ? this.whatsappV4.queue(
          dto,
          idempotencyKey!,
          correlationId!,
          request.crmIntegration?.projectId,
        )
      : this.outbound.queue(
          dto,
          idempotencyKey!,
          correlationId!,
          request.crmIntegration?.projectId,
        );
  }

  @Post('messages/scheduled')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-Id', required: true })
  scheduleMessage(
    @Body() dto: CrmScheduledMessageDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    this.assertHeaders(idempotencyKey, correlationId);
    return this.outbound.queue(
      dto,
      idempotencyKey!,
      correlationId!,
      request.crmIntegration?.projectId,
    );
  }

  @Get('message-templates')
  @ApiOkResponse({ description: 'Connection-scoped normalized WhatsApp templates' })
  messageTemplates(
    @Query() query: CrmWhatsAppTemplateQueryDto,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    return this.whatsappV4.templates(query, request.crmIntegration?.projectId);
  }

  @Post('messages/media-group')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-Id', required: true })
  mediaGroup(
    @Body() dto: CrmMediaGroupDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    this.assertHeaders(idempotencyKey, correlationId);
    return this.telegramV3.mediaGroup(
      dto,
      idempotencyKey!,
      correlationId!,
      request.crmIntegration?.projectId,
    );
  }

  @Get('messages/scheduled')
  scheduledMessages(
    @Query() query: CrmScheduledMessageQueryDto,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    return this.outbound.scheduledList(query, request.crmIntegration?.projectId);
  }

  @Get('messages/scheduled/:scheduleId')
  scheduledMessage(
    @Param('scheduleId') scheduleId: string,
    @Query() query: CrmScheduledMessageQueryDto,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    return this.outbound.scheduled(scheduleId, query, request.crmIntegration?.projectId);
  }

  @Patch('messages/scheduled/:scheduleId')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-Id', required: true })
  updateScheduledMessage(
    @Param('scheduleId') scheduleId: string,
    @Query() query: CrmScheduledMessageQueryDto,
    @Body() dto: CrmScheduledMessageUpdateDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    this.assertHeaders(idempotencyKey, correlationId);
    return this.outbound.updateScheduled(
      scheduleId,
      dto,
      query,
      idempotencyKey!,
      correlationId!,
      request.crmIntegration?.projectId,
    );
  }

  @Delete('messages/scheduled/:scheduleId')
  cancelScheduledMessage(
    @Param('scheduleId') scheduleId: string,
    @Query() query: CrmScheduledMessageQueryDto,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    return this.outbound.cancelScheduled(scheduleId, query, request.crmIntegration?.projectId);
  }

  @Post('chat-actions')
  @HttpCode(200)
  @ApiBody({ type: CrmChatActionDto })
  @ApiOkResponse({ description: 'Ephemeral Telegram chat action accepted' })
  chatAction(@Body() dto: CrmChatActionDto, @Req() request: AuthenticatedCrmIntegrationRequest) {
    return this.telegramV3.chatAction(dto, request.crmIntegration?.projectId);
  }

  @Post('drafts')
  @HttpCode(200)
  @ApiBody({ type: CrmDraftDto })
  @ApiOkResponse({ description: 'Ephemeral 30-second Telegram draft preview updated' })
  draft(@Body() dto: CrmDraftDto, @Req() request: AuthenticatedCrmIntegrationRequest) {
    return this.telegramV3.draft(dto, request.crmIntegration?.projectId);
  }

  @Patch('messages/:messageId')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-Id', required: true })
  editMessage(
    @Param('messageId') messageId: string,
    @Body() dto: CrmMessageMutationDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    this.assertHeaders(idempotencyKey, correlationId);
    return this.telegramV3.edit(
      messageId,
      dto,
      idempotencyKey!,
      correlationId!,
      request.crmIntegration?.projectId,
    );
  }

  @Delete('messages/:messageId')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-Id', required: true })
  deleteMessage(
    @Param('messageId') messageId: string,
    @Body() dto: CrmTelegramScopeDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    this.assertHeaders(idempotencyKey, correlationId);
    return this.telegramV3.delete(
      messageId,
      dto,
      idempotencyKey!,
      correlationId!,
      request.crmIntegration?.projectId,
    );
  }

  @Put('messages/:messageId/reaction')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-Id', required: true })
  setReaction(
    @Param('messageId') messageId: string,
    @Body() dto: CrmReactionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    this.assertHeaders(idempotencyKey, correlationId);
    if (
      dto.identity.channel === 'whatsapp'
        ? !dto.emoji || dto.type !== undefined || dto.value !== undefined || dto.isBig !== undefined
        : !dto.type || !dto.value || dto.emoji !== undefined
    )
      throw new BadRequestException({ code: 'CRM_REACTION_INVALID' });
    return dto.identity.channel === 'whatsapp'
      ? this.whatsappV4.reaction(
          messageId,
          dto,
          idempotencyKey!,
          correlationId!,
          request.crmIntegration?.projectId,
        )
      : this.telegramV3.reaction(
          messageId,
          dto,
          idempotencyKey!,
          correlationId!,
          request.crmIntegration?.projectId,
        );
  }

  @Delete('messages/:messageId/reaction')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-Id', required: true })
  removeReaction(
    @Param('messageId') messageId: string,
    @Body() dto: CrmTelegramScopeDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    this.assertHeaders(idempotencyKey, correlationId);
    return dto.identity.channel === 'whatsapp'
      ? this.whatsappV4.reaction(
          messageId,
          dto,
          idempotencyKey!,
          correlationId!,
          request.crmIntegration?.projectId,
        )
      : this.telegramV3.reaction(
          messageId,
          dto,
          idempotencyKey!,
          correlationId!,
          request.crmIntegration?.projectId,
        );
  }

  @Put('messages/:messageId/read')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-Id', required: true })
  @ApiOkResponse({ description: 'WhatsApp read intent durably queued' })
  markMessageRead(
    @Param('messageId') messageId: string,
    @Body() dto: CrmTelegramScopeDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    this.assertHeaders(idempotencyKey, correlationId);
    if (dto.identity.channel !== 'whatsapp')
      throw new BadRequestException({ code: 'MARK_READ_CHANNEL_UNSUPPORTED' });
    return this.whatsappV4.markRead(
      messageId,
      dto,
      idempotencyKey!,
      correlationId!,
      request.crmIntegration?.projectId,
    );
  }

  @Put('messages/:messageId/pin')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-Id', required: true })
  pinMessage(
    @Param('messageId') messageId: string,
    @Body() dto: CrmPinMessageDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    this.assertHeaders(idempotencyKey, correlationId);
    return this.telegramV3.pin(
      messageId,
      dto,
      true,
      idempotencyKey!,
      correlationId!,
      request.crmIntegration?.projectId,
    );
  }

  @Delete('messages/:messageId/pin')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Correlation-Id', required: true })
  unpinMessage(
    @Param('messageId') messageId: string,
    @Body() dto: CrmPinMessageDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    this.assertHeaders(idempotencyKey, correlationId);
    return this.telegramV3.pin(
      messageId,
      dto,
      false,
      idempotencyKey!,
      correlationId!,
      request.crmIntegration?.projectId,
    );
  }

  @Post('operations/:operationId/retry')
  @HttpCode(200)
  @ApiHeader({ name: 'X-Correlation-Id', required: true })
  async retryOperation(
    @Param('operationId') operationId: string,
    @Body() dto: CrmRetryOperationDto,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    if (!correlationId || correlationId.length > 128)
      throw new BadRequestException({ code: 'CRM_CORRELATION_ID_REQUIRED' });
    const kind = await this.outbound.operationKind(
      operationId,
      dto.crmProjectId,
      dto.omnicusProjectId,
      request.crmIntegration?.projectId,
    );
    return kind === 'WHATSAPP'
      ? this.whatsappV4.retry(operationId, dto, correlationId, request.crmIntegration?.projectId)
      : this.telegramV3.retry(operationId, dto, correlationId, request.crmIntegration?.projectId);
  }

  @Get('operations/:operationId')
  @ApiQuery({ type: CrmOperationQueryDto })
  @ApiOkResponse({ description: 'Current durable channel delivery status' })
  async operation(
    @Param('operationId') operationId: string,
    @Query() query: CrmOperationQueryDto,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    return this.outbound.status(
      operationId,
      query.crmProjectId,
      query.omnicusProjectId,
      request.crmIntegration?.projectId,
    );
  }

  private assertHeaders(
    idempotencyKey: string | undefined,
    correlationId: string | undefined,
  ): void {
    if (!idempotencyKey || idempotencyKey.length > 128)
      throw new BadRequestException({
        code: 'CRM_IDEMPOTENCY_KEY_REQUIRED',
        message: 'A valid Idempotency-Key header is required',
      });
    if (!correlationId || correlationId.length > 128)
      throw new BadRequestException({
        code: 'CRM_CORRELATION_ID_REQUIRED',
        message: 'A valid X-Correlation-Id header is required',
      });
  }
}
