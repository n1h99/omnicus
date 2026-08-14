import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';

export class LeadCaptureConsentsDto {
  @IsOptional()
  @IsBoolean()
  email?: boolean;

  @IsOptional()
  @IsBoolean()
  sms?: boolean;

  @IsOptional()
  @IsBoolean()
  whatsApp?: boolean;
}

export class CaptureLeadDto {
  @IsOptional()
  @IsString()
  @Length(1, 160)
  externalId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 160)
  idempotencyKey?: string;

  @IsOptional()
  @IsString()
  @Length(1, 160)
  firstName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 160)
  lastName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 320)
  displayName?: string;

  @IsOptional()
  @IsEmail()
  @Length(3, 320)
  email?: string;

  @IsOptional()
  @IsString()
  @Length(5, 64)
  phone?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => LeadCaptureConsentsDto)
  consents?: LeadCaptureConsentsDto;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
