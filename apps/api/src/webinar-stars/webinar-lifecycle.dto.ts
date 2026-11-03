import {
  IsArray,
  IsBoolean,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
  ArrayMaxSize,
} from 'class-validator';
export class WebinarEventDto {
  @Matches(/^\d{1,30}$/) providerWebinarId!: string;
  @IsString() @MaxLength(200) title!: string;
  @IsString() @MaxLength(2048) roomUrl!: string;
  @IsString() @MaxLength(100) timezone!: string;
  @IsISO8601() scheduledAt!: string;
  @IsISO8601() endsAt!: string;
  @IsOptional() @IsObject() settings?: Record<string, unknown>;
}
export class WebinarEnableDto {
  @IsBoolean() enabled!: boolean;
}
export class WebinarImportDto {
  @Matches(/^\d{1,30}$/) reportId!: string;
  @IsOptional() @IsUUID() eventId?: string;
  @IsBoolean() historical = true;
}
export class WebinarInviteDto {
  @IsArray() @ArrayMaxSize(100) @IsUUID(undefined, { each: true }) contactIds!: string[];
  @IsOptional() @IsObject() attribution?: Record<string, unknown>;
}
export class WebinarMatchDto {
  @IsOptional() @IsUUID() contactId?: string;
  @IsOptional() @IsBoolean() ignore?: boolean;
}
