import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

export class CrmEmailScopeDto {
  @IsString() @Length(1, 128) crmProjectId!: string;
  @IsString() @Length(1, 128) omnicusProjectId!: string;
  @IsString() @Length(1, 128) crmLeadId!: string;
  @IsString() @Length(1, 128) crmUserId!: string;
  @IsOptional() @Matches(/^[1-9][0-9]{0,3}$/) page?: string;
  @IsOptional() @IsUUID() before?: string;
}

export class CrmSendEmailDto extends CrmEmailScopeDto {
  @IsUUID() requestId!: string;
  @IsUUID() mailboxId!: string;
  @IsEmail() @MaxLength(254) to!: string;
  // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted email headers.
  @IsString() @Length(1, 200) @Matches(/^[^\r\n\x00]+$/) subject!: string;
  @IsString() @MaxLength(100000) text!: string;
  @IsOptional() @IsUUID() threadId?: string;
  @IsOptional() @IsUUID() replyToMessageId?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  assetIds?: string[];
}

export class CrmEmailUploadDto extends CrmEmailScopeDto {
  @IsUUID() requestId!: string;
  @IsUUID() mailboxId!: string;
}

export class CrmEmailReadDto extends CrmEmailScopeDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  messageIds!: string[];
}

export class CrmEmailUnreadSummaryDto {
  @IsString() @Length(1, 128) crmProjectId!: string;
  @IsString() @Length(1, 128) omnicusProjectId!: string;
  @IsString() @Length(1, 128) crmUserId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsString({ each: true })
  @Length(1, 128, { each: true })
  crmLeadIds!: string[];
}
