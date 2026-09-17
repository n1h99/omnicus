import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { REQUIRED_PROJECT_PERMISSION } from '../access/access.decorators';
import { CommunicationsController } from './communications.controller';
import {
  CommunicationMessagesQueryDto,
  CommunicationsContactsQueryDto,
  SendCommunicationMessageDto,
} from './dto';

function parameterTypes(method: keyof CommunicationsController): unknown[] {
  return Reflect.getMetadata(
    'design:paramtypes',
    CommunicationsController.prototype,
    method,
  ) as unknown[];
}

describe('CommunicationsController contract', () => {
  it('keeps pagination and message query DTOs available to runtime validation', () => {
    expect(parameterTypes('contacts')[1]).toBe(CommunicationsContactsQueryDto);
    expect(parameterTypes('messages')[2]).toBe(CommunicationMessagesQueryDto);
    expect(plainToInstance(CommunicationsContactsQueryDto, {})).toMatchObject({
      page: 1,
      pageSize: 40,
    });
  });

  it('allows only Telegram and WhatsApp on the operator send endpoint', () => {
    const valid = plainToInstance(SendCommunicationMessageDto, {
      channel: 'WHATSAPP',
      clientRequestId: '0b6f94fc-e1d4-4370-bd12-61350b1dcf22',
      text: 'Hello',
    });
    const invalid = plainToInstance(SendCommunicationMessageDto, {
      channel: 'EMAIL',
      clientRequestId: '0b6f94fc-e1d4-4370-bd12-61350b1dcf22',
      text: 'Hello',
    });
    expect(validateSync(valid)).toHaveLength(0);
    expect(validateSync(invalid).some((error) => error.property === 'channel')).toBe(true);
  });

  it('separates read and send permissions', () => {
    expect(
      Reflect.getMetadata(REQUIRED_PROJECT_PERMISSION, CommunicationsController.prototype.contacts),
    ).toBe('communications:read');
    expect(
      Reflect.getMetadata(REQUIRED_PROJECT_PERMISSION, CommunicationsController.prototype.send),
    ).toBe('communications:send');
    expect(
      Reflect.getMetadata(
        REQUIRED_PROJECT_PERMISSION,
        CommunicationsController.prototype.uploadMedia,
      ),
    ).toBe('communications:send');
  });
});
