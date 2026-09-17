import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';

import { CrmIntegrationController } from './crm-integration.controller';
import { CrmContactUpsertDto, CrmMediaUploadDto } from './dto';

describe('CrmIntegrationController DTO metadata', () => {
  it('validates a complete CRM contact snapshot', () => {
    expect(
      validateSync(
        plainToInstance(CrmContactUpsertDto, {
          crmLeadId: 'lead-a',
          crmProjectId: 'crm-a',
          displayName: null,
          email: null,
          omnicusProjectId: 'project-a',
          phone: null,
          sourceUpdatedAt: '2026-09-17T09:00:00.000Z',
          status: 'ACTIVE',
          username: null,
        }),
      ),
    ).toHaveLength(0);
  });

  it('preserves the multipart media DTO as a runtime class', () => {
    const parameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      CrmIntegrationController.prototype,
      'uploadMedia',
    ) as unknown[];

    expect(parameterTypes[0]).toBe(CrmMediaUploadDto);
    expect(
      validateSync(
        plainToInstance(CrmMediaUploadDto, {
          crmProjectId: 'cyber-pulse-staging',
          kind: 'DOCUMENT',
          omnicusProjectId: '5389d6fd-ad17-44d6-a430-a4e0c1cb6d3f',
        }),
      ),
    ).toHaveLength(0);
  });

  it('dispatches explicit retry to the WhatsApp worker for a WhatsApp operation', async () => {
    const outbound = { operationKind: vi.fn().mockResolvedValue('WHATSAPP') };
    const telegram = { retry: vi.fn() };
    const whatsapp = { retry: vi.fn().mockResolvedValue({ status: 'QUEUED' }) };
    const controller = new CrmIntegrationController(
      outbound as never,
      {} as never,
      {} as never,
      telegram as never,
      whatsapp as never,
    );
    await expect(
      controller.retryOperation(
        'operation-a',
        {
          crmProjectId: 'cyber-pulse-staging',
          omnicusProjectId: 'project-a',
          retryRequestId: 'retry-a',
        },
        'correlation-a',
        { crmIntegration: { projectId: 'project-a' } } as never,
      ),
    ).resolves.toEqual({ status: 'QUEUED' });
    expect(whatsapp.retry).toHaveBeenCalledWith(
      'operation-a',
      expect.objectContaining({ retryRequestId: 'retry-a' }),
      'correlation-a',
      'project-a',
    );
    expect(telegram.retry).not.toHaveBeenCalled();
  });
});
