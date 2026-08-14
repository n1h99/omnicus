import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import {
  CreateEmailCampaignDto,
  CreateEmailSuppressionDto,
  CreateEmailTemplateDto,
  TestEmailDto,
  UpdateEmailCampaignDto,
  UpdateEmailTemplateDraftDto,
} from './dto';
import { EmailController } from './email.controller';

function parameterTypes(method: keyof EmailController): unknown[] | undefined {
  return Reflect.getMetadata(
    'design:paramtypes',
    EmailController.prototype,
    method,
  ) as unknown[] | undefined;
}

describe('EmailController DTO metadata', () => {
  it('preserves every request body DTO as a runtime class', () => {
    expect(parameterTypes('createCampaign')?.[1]).toBe(CreateEmailCampaignDto);
    expect(parameterTypes('updateCampaign')?.[2]).toBe(UpdateEmailCampaignDto);
    expect(parameterTypes('testSend')?.[1]).toBe(TestEmailDto);
    expect(parameterTypes('createTemplate')?.[1]).toBe(CreateEmailTemplateDto);
    expect(parameterTypes('updateTemplate')?.[2]).toBe(UpdateEmailTemplateDraftDto);
    expect(parameterTypes('suppress')?.[1]).toBe(CreateEmailSuppressionDto);
  });

  it('accepts the initial campaign payload with the production validation pipe', async () => {
    const body = await new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }).transform(
      {
        audience: { mode: 'ALL_ACTIVE' },
        design: {
          blocks: [],
          settings: {},
          version: 1,
        },
        name: 'Email campaign Aug 14, 11:32:42',
        preheader: null,
        sourceTemplateVersionId: null,
        subject: 'A message from Omnicus',
      },
      { metatype: parameterTypes('createCampaign')?.[1] as typeof CreateEmailCampaignDto, type: 'body' },
    );

    expect(body).toMatchObject({
      audience: { mode: 'ALL_ACTIVE' },
      name: 'Email campaign Aug 14, 11:32:42',
      subject: 'A message from Omnicus',
    });
  });
});
