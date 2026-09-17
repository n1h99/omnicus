import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class ConnectEmailDomainDto {
  @IsUUID() providerDomainId!: string;
}

export class CreateEmailMailboxDto {
  @IsUUID() domainId!: string;
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/)
  localPart!: string;
  @IsString() @MinLength(1) @MaxLength(120) @Matches(/^[^\r\n<>]+$/) displayName!: string;
  @IsOptional() @IsString() @MaxLength(5000) signature?: string;
  @IsOptional() @IsIn(['TWO_WAY', 'SEND_ONLY']) mode?: 'TWO_WAY' | 'SEND_ONLY';
  @IsOptional() @IsBoolean() shared?: boolean;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  memberUserIds?: string[];
}

export class UpdateEmailMailboxDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(/^[^\r\n<>]+$/)
  displayName?: string;
  @IsOptional() @IsString() @MaxLength(5000) signature?: string;
  @IsOptional() @IsIn(['TWO_WAY', 'SEND_ONLY']) mode?: 'TWO_WAY' | 'SEND_ONLY';
  @IsOptional() @IsIn(['ACTIVE', 'DISABLED']) status?: 'ACTIVE' | 'DISABLED';
  @IsOptional() @IsBoolean() shared?: boolean;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  memberUserIds?: string[];
}

export class SendInboxEmailDto {
  @IsUUID() requestId!: string;
  @IsUUID() mailboxId!: string;
  @IsEmail() @MaxLength(254) to!: string;
  // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted email headers.
  @IsString() @MinLength(1) @MaxLength(200) @Matches(/^[^\r\n\x00]+$/) subject!: string;
  @IsString() @MaxLength(100000) text!: string;
  @IsOptional() @IsUUID() threadId?: string;
  @IsOptional() @IsUUID() replyToMessageId?: string;
  @IsOptional() @IsUUID() draftId?: string;
  @IsOptional() @IsInt() @Min(1) draftRevision?: number;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  assetIds?: string[];
}

export class SaveEmailDraftDto {
  @IsUUID() mailboxId!: string;
  @IsInt() @Min(0) @Max(2147483646) revision!: number;
  @IsOptional() @IsUUID() threadId?: string;
  @IsString() @MaxLength(254) to!: string;
  @IsString() @MaxLength(200) subject!: string;
  @IsString() @MaxLength(100000) text!: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  assetIds?: string[];
}

export class UpdateEmailThreadStateDto {
  @IsOptional() @IsBoolean() read?: boolean;
  @IsOptional() @IsBoolean() starred?: boolean;
  @IsOptional() @IsBoolean() archived?: boolean;
}

export class DeleteEmailDraftDto {
  @IsInt() @Min(1) @Max(2147483647) revision!: number;
}
