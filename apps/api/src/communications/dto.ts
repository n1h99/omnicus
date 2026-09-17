import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const communicationChannels = ['TELEGRAM', 'WHATSAPP'] as const;
const mediaKinds = [
  'PHOTO',
  'DOCUMENT',
  'VIDEO',
  'AUDIO',
  'VOICE',
  'VIDEO_NOTE',
  'ANIMATION',
  'STICKER',
] as const;

export class CommunicationsContactsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 40;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  search?: string;
}

export class CommunicationMessagesQueryDto {
  @IsUUID()
  identityId!: string;

  @IsOptional()
  @IsUUID()
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

export class CommunicationTemplatesQueryDto {
  @IsUUID()
  connectionId!: string;
}

export class CommunicationMediaDto {
  @IsIn(mediaKinds)
  kind!: (typeof mediaKinds)[number];

  @IsUUID()
  mediaAssetId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(86_400)
  durationSeconds?: number;
}

export class SendCommunicationMessageDto {
  @IsUUID()
  clientRequestId!: string;

  @IsIn(communicationChannels)
  channel!: (typeof communicationChannels)[number];

  @IsOptional()
  @IsUUID()
  identityId?: string;

  @IsOptional()
  @IsUUID()
  connectionId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 4096)
  text?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CommunicationMediaDto)
  media?: CommunicationMediaDto;

  @IsOptional()
  @IsObject()
  template?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  interactive?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  structured?: Record<string, unknown>;

  @IsOptional()
  @IsUUID()
  replyToMessageId?: string;

  @IsOptional()
  @IsArray()
  inlineKeyboard?: unknown[];

  @IsOptional()
  @IsObject()
  replyMarkup?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  richMessage?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  linkPreviewOptions?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  disableNotification?: boolean;

  @IsOptional()
  @IsBoolean()
  protectContent?: boolean;

  @IsOptional()
  @IsBoolean()
  hasSpoiler?: boolean;
}
