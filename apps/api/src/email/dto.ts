import {
  IsEmail,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateEmailCampaignDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;
  @IsString()
  @MaxLength(200)
  subject!: string;
  @IsOptional()
  @IsString()
  @MaxLength(300)
  preheader?: string;
  @IsObject()
  design!: Record<string, unknown>;
  @IsObject()
  audience!: Record<string, unknown>;
  @IsOptional()
  @IsUUID()
  sourceTemplateVersionId?: string;
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;
}

export class UpdateEmailCampaignDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;
  @IsOptional()
  @IsString()
  @MaxLength(300)
  preheader?: string | null;
  @IsOptional()
  @IsObject()
  design?: Record<string, unknown>;
  @IsOptional()
  @IsObject()
  audience?: Record<string, unknown>;
  @IsOptional()
  @IsUUID()
  sourceTemplateVersionId?: string | null;
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string | null;
}

export class CreateEmailTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
  @IsString()
  @MaxLength(200)
  subject!: string;
  @IsOptional()
  @IsString()
  @MaxLength(300)
  preheader?: string;
  @IsObject()
  design!: Record<string, unknown>;
}

export class UpdateEmailTemplateDraftDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;
  @IsString()
  @MaxLength(200)
  subject!: string;
  @IsOptional()
  @IsString()
  @MaxLength(300)
  preheader?: string | null;
  @IsObject()
  design!: Record<string, unknown>;
}

export class TestEmailDto {
  @IsEmail()
  @MaxLength(320)
  to!: string;
  @IsString()
  @MaxLength(200)
  subject!: string;
  @IsOptional()
  @IsString()
  @MaxLength(300)
  preheader?: string;
  @IsObject()
  design!: Record<string, unknown>;
}

export class CreateEmailSuppressionDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;
  @IsOptional()
  @IsString()
  @MaxLength(500)
  detail?: string;
  @IsOptional()
  @IsIn(['MANUAL', 'UNSUBSCRIBED'])
  reason?: 'MANUAL' | 'UNSUBSCRIBED';
}
