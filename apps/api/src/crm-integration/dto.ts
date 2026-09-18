import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsInt,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class CrmContactUpsertDto {
  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  crmProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  omnicusProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  crmLeadId!: string;

  @ApiProperty({ format: 'date-time', type: String })
  @IsDateString()
  sourceUpdatedAt!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @IsString()
  @Length(0, 200)
  displayName?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @IsString()
  @Length(0, 64)
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @IsEmail()
  email?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @IsString()
  @Length(0, 128)
  username?: string | null;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'ARCHIVED'])
  status?: 'ACTIVE' | 'ARCHIVED';
}

export class CrmWhatsAppConnectionsQueryDto {
  @IsString()
  @Length(1, 128)
  crmProjectId!: string;

  @IsString()
  @Length(1, 128)
  omnicusProjectId!: string;
}

export class CrmWhatsAppConnectDto extends CrmContactUpsertDto {
  @IsUUID()
  connectionId!: string;
}

export class CrmOutboundIdentityDto {
  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  channelIdentityId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  connectionId!: string;

  @ApiProperty({ enum: ['telegram', 'whatsapp'] })
  @IsIn(['telegram', 'whatsapp'])
  channel!: 'telegram' | 'whatsapp';
}

const crmOutboundMediaKinds = [
  'PHOTO',
  'DOCUMENT',
  'VIDEO',
  'AUDIO',
  'VOICE',
  'VIDEO_NOTE',
  'ANIMATION',
  'STICKER',
] as const;

export class CrmOutboundMediaDto {
  @ApiProperty({ enum: crmOutboundMediaKinds })
  @IsIn(crmOutboundMediaKinds)
  kind!: (typeof crmOutboundMediaKinds)[number];

  @ApiProperty({ format: 'uuid', type: String })
  @IsUUID()
  mediaAssetId!: string;

  @ApiPropertyOptional({ maximum: 86_400, minimum: 1, type: Number })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(86_400)
  durationSeconds?: number;
}

export class CrmMediaUploadDto {
  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  crmProjectId!: string;

  @ApiPropertyOptional({
    default: 'telegram',
    description: 'Required by contract 4.0.0; omission preserves Telegram v3 compatibility',
    enum: ['telegram', 'whatsapp'],
  })
  @IsOptional()
  @IsIn(['telegram', 'whatsapp'])
  channel?: 'telegram' | 'whatsapp';

  @ApiProperty({ enum: crmOutboundMediaKinds })
  @IsIn(crmOutboundMediaKinds)
  kind!: (typeof crmOutboundMediaKinds)[number];

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  omnicusProjectId!: string;
}

export class CrmOutboundMessageDto {
  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  crmProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  omnicusProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  omnicusContactId!: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  crmLeadId?: string;

  @ApiProperty({ type: CrmOutboundIdentityDto })
  @Type(() => CrmOutboundIdentityDto)
  @ValidateNested()
  identity!: CrmOutboundIdentityDto;

  @ApiPropertyOptional({ maxLength: 4096, type: String })
  @IsOptional()
  @IsString()
  @Length(1, 4096)
  text?: string;

  @ApiPropertyOptional({ type: CrmOutboundMediaDto })
  @IsOptional()
  @Type(() => CrmOutboundMediaDto)
  @ValidateNested()
  media?: CrmOutboundMediaDto;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  hasSpoiler?: boolean;

  @ApiPropertyOptional({
    description: 'Rows of provider-independent Telegram inline keyboard buttons',
    isArray: true,
    type: 'array',
  })
  @IsOptional()
  @IsArray()
  inlineKeyboard?: unknown[];

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  replyMarkup?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  richMessage?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  disableNotification?: boolean;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  protectContent?: boolean;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  messageEffectId?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  linkPreviewOptions?: Record<string, unknown>;

  @ApiPropertyOptional({ isArray: true, type: Object })
  @IsOptional()
  @IsArray()
  entities?: unknown[];

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @Length(1, 1024)
  quote?: string;

  @ApiPropertyOptional({ maximum: 4096, minimum: 0, type: Number })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4096)
  quotePosition?: number;

  @ApiPropertyOptional({ format: 'uuid', type: String })
  @IsOptional()
  @IsUUID()
  replyToMessageId?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  structured?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  interactive?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  template?: Record<string, unknown>;
}

export class CrmScheduledMessageDto extends CrmOutboundMessageDto {
  @ApiProperty({ format: 'date-time', type: String })
  @IsDateString()
  scheduledAt!: string;

  @ApiProperty({ example: 'Europe/Berlin', type: String })
  @IsString()
  @Length(1, 64)
  timezone!: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  recurrence?: Record<string, unknown>;
}

export class CrmScheduledMessageUpdateDto {
  @ApiProperty({ minimum: 1, type: Number })
  @IsInt()
  @Min(1)
  expectedRevision!: number;

  @ApiPropertyOptional({ format: 'date-time', type: String })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  recurrence?: Record<string, unknown> | null;
}

export class CrmScheduledMessageQueryDto {
  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  crmProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  omnicusProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  connectionId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  omnicusContactId!: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  channelIdentityId?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  crmLeadId?: string;
}

export class CrmMediaGroupItemDto {
  @ApiProperty({ enum: ['PHOTO', 'VIDEO', 'AUDIO', 'DOCUMENT'] })
  @IsIn(['PHOTO', 'VIDEO', 'AUDIO', 'DOCUMENT'])
  kind!: 'AUDIO' | 'DOCUMENT' | 'PHOTO' | 'VIDEO';

  @ApiProperty({ format: 'uuid', type: String })
  @IsUUID()
  mediaAssetId!: string;

  @ApiPropertyOptional({ maxLength: 1024, type: String })
  @IsOptional()
  @IsString()
  @Length(0, 1024)
  caption?: string;

  @ApiPropertyOptional({ isArray: true, type: Object })
  @IsOptional()
  @IsArray()
  entities?: unknown[];

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  hasSpoiler?: boolean;
}

export class CrmTelegramScopeDto {
  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  crmProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  omnicusProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  omnicusContactId!: string;

  @ApiProperty({ type: CrmOutboundIdentityDto })
  @Type(() => CrmOutboundIdentityDto)
  @ValidateNested()
  identity!: CrmOutboundIdentityDto;
}

export class CrmMediaGroupDto extends CrmTelegramScopeDto {
  @ApiProperty({ isArray: true, type: CrmMediaGroupItemDto })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(10)
  @Type(() => CrmMediaGroupItemDto)
  @ValidateNested({ each: true })
  items!: CrmMediaGroupItemDto[];

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  disableNotification?: boolean;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  protectContent?: boolean;
}

export class CrmBotInterfaceDto {
  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  crmProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  omnicusProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  connectionId!: string;

  @ApiProperty({ minimum: 0, type: Number })
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiProperty({ isArray: true, type: Object })
  @IsArray()
  @ArrayMaxSize(100)
  commands!: unknown[];

  @ApiProperty({ type: Object })
  @IsObject()
  scope!: Record<string, unknown>;

  @ApiProperty({ type: Object })
  @IsObject()
  menuButton!: Record<string, unknown>;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @Length(0, 2)
  languageCode?: string;
}

export class CrmBotInterfaceQueryDto {
  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  crmProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  omnicusProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  connectionId!: string;
}

export class CrmCapabilitiesQueryDto {
  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  crmProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  omnicusProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  connectionId!: string;

  @ApiPropertyOptional({ default: 'telegram', enum: ['telegram', 'whatsapp'] })
  @IsOptional()
  @IsIn(['telegram', 'whatsapp'])
  channel?: 'telegram' | 'whatsapp';

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  omnicusContactId?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  channelIdentityId?: string;
}

const crmChatActions = [
  'TYPING',
  'RECORD_VOICE',
  'UPLOAD_PHOTO',
  'UPLOAD_VIDEO',
  'UPLOAD_DOCUMENT',
  'RECORD_VIDEO_NOTE',
] as const;

export class CrmChatActionDto extends CrmTelegramScopeDto {
  @ApiProperty({ enum: crmChatActions })
  @IsIn(crmChatActions)
  action!: (typeof crmChatActions)[number];
}

export class CrmReactionDto extends CrmTelegramScopeDto {
  @ApiPropertyOptional({ enum: ['emoji', 'custom_emoji'] })
  @IsOptional()
  @IsIn(['emoji', 'custom_emoji'])
  type?: 'custom_emoji' | 'emoji';

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  value?: string;

  @ApiPropertyOptional({ description: 'WhatsApp standard emoji', type: String })
  @IsOptional()
  @IsString()
  @Length(1, 32)
  emoji?: string;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  isBig?: boolean;
}

export class CrmMessageMutationDto extends CrmTelegramScopeDto {
  @ApiPropertyOptional({ maxLength: 4096, type: String })
  @IsOptional()
  @IsString()
  @Length(1, 4096)
  text?: string;

  @ApiPropertyOptional({ maxLength: 1024, type: String })
  @IsOptional()
  @IsString()
  @Length(0, 1024)
  caption?: string;

  @ApiPropertyOptional({ isArray: true, type: Object })
  @IsOptional()
  @IsArray()
  inlineKeyboard?: unknown[];

  @ApiPropertyOptional({ isArray: true, type: Object })
  @IsOptional()
  @IsArray()
  entities?: unknown[];

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  linkPreviewOptions?: Record<string, unknown>;
}

export class CrmPinMessageDto extends CrmTelegramScopeDto {
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  disableNotification?: boolean;
}

export class CrmDraftDto extends CrmTelegramScopeDto {
  @ApiProperty({ type: Number })
  @IsInt()
  @Min(1)
  draftId!: number;

  @ApiPropertyOptional({ maxLength: 4096, type: String })
  @IsOptional()
  @IsString()
  @Length(0, 4096)
  text?: string;

  @ApiPropertyOptional({ isArray: true, type: Object })
  @IsOptional()
  @IsArray()
  entities?: unknown[];

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  richMessage?: Record<string, unknown>;
}

export class CrmRetryOperationDto {
  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  crmProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  omnicusProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  retryRequestId!: string;
}

export class CrmAutomationStateQueryDto {
  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  crmProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  omnicusProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  omnicusContactId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  connectionId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  channelIdentityId!: string;

  @ApiPropertyOptional({ default: 'telegram', enum: ['telegram', 'whatsapp'] })
  @IsOptional()
  @IsIn(['telegram', 'whatsapp'])
  channel?: 'telegram' | 'whatsapp';
}

export class CrmAutomationStateDto extends CrmTelegramScopeDto {
  @ApiProperty({ enum: ['AUTO', 'MANUAL', 'PAUSED'] })
  @IsIn(['AUTO', 'MANUAL', 'PAUSED'])
  mode!: 'AUTO' | 'MANUAL' | 'PAUSED';

  @ApiProperty({ minimum: 0, type: Number })
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiPropertyOptional({ format: 'date-time', type: String })
  @IsOptional()
  @IsDateString()
  resumeAt?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  reasonCode?: string;
}

export class CrmOperationQueryDto {
  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  crmProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  omnicusProjectId!: string;
}

export class CrmWhatsAppTemplateQueryDto {
  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  crmProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  omnicusProjectId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  connectionId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  omnicusContactId!: string;

  @ApiProperty({ type: String })
  @IsString()
  @Length(1, 128)
  channelIdentityId!: string;

  @ApiProperty({ enum: ['whatsapp'] })
  @IsIn(['whatsapp'])
  channel!: 'whatsapp';

  @ApiPropertyOptional({
    enum: ['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'UNKNOWN'],
  })
  @IsOptional()
  @IsIn(['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'UNKNOWN'])
  status?: 'APPROVED' | 'DISABLED' | 'PAUSED' | 'PENDING' | 'REJECTED' | 'UNKNOWN';
}
