import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SaveMetaLeadConfigDto {
  @Matches(/^\d{1,30}$/) pageId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @Matches(/^\d{1,30}$/, { each: true })
  formIds!: string[];
  @Matches(/^v\d{1,3}\.\d{1,2}$/) graphVersion = 'v26.0';
  @IsOptional() @IsString() @MinLength(20) @MaxLength(4096) pageToken?: string;
  @IsOptional() @IsString() @MinLength(16) @MaxLength(512) appSecret?: string;
  @IsOptional() @IsString() @MinLength(32) @MaxLength(256) verifyToken?: string;
}

export class StartMetaLeadsDto {
  @IsISO8601() liveFrom!: string;
  @IsBoolean() deliveryEnabled = false;
}

export class MetaLeadHistoryDto {
  @IsISO8601() from!: string;
  @IsISO8601() until!: string;
}

export class ApproveMetaLeadDto {
  @IsBoolean() confirmHistoricalImport = false;
}
