import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

export class TelegramWorkspaceWriteDto {
  @IsString()
  @Length(1, 300)
  resource!: string;

  @IsIn(['POST', 'PUT', 'PATCH', 'DELETE'])
  method!: 'POST' | 'PUT' | 'PATCH' | 'DELETE';

  @IsObject()
  payload!: Record<string, unknown>;
}

export class CommunicationDraftDto {
  @IsIn(['message', 'note']) composerMode!: 'message' | 'note';
  @IsString() @Length(0, 20_000) text!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) mentionedUserIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) entities?: unknown[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) inlineKeyboard?: unknown[];
  @IsOptional() @IsObject() replyMarkup?: Record<string, unknown>;
  @IsOptional() @IsObject() linkPreviewOptions?: Record<string, unknown>;
  @IsOptional() @IsBoolean() protectContent?: boolean;
  @IsOptional() @IsBoolean() disableNotification?: boolean;
  @IsOptional() @IsString() @Length(0, 128) messageEffectId?: string;
  @IsOptional() @IsString() @Length(0, 128) replyToMessageId?: string;
  @IsOptional() @IsString() @Length(0, 1024) quote?: string;
}
