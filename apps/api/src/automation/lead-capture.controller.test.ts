import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { PublicLeadCaptureController } from './lead-capture.controller';
import { CaptureLeadDto } from './lead-capture.dto';

describe('PublicLeadCaptureController validation', () => {
  it('preserves the lead capture DTO as runtime body metadata', async () => {
    const parameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      PublicLeadCaptureController.prototype,
      'capture',
    ) as unknown[] | undefined;

    expect(parameterTypes?.[4]).toBe(CaptureLeadDto);

    const body = await new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }).transform(
      {
        consentSource: 'qa_closed_window',
        consents: { whatsApp: true },
        phone: '+994505003055',
      },
      { metatype: parameterTypes?.[4] as typeof CaptureLeadDto, type: 'body' },
    );

    expect(body).toBeInstanceOf(CaptureLeadDto);
    expect(body).toMatchObject({
      consentSource: 'qa_closed_window',
      consents: { whatsApp: true },
      phone: '+994505003055',
    });
  });
});
