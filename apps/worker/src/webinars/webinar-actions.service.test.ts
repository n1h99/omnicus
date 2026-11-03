import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { CrmClientError } from '@omnicus/crm-core';
import type { DatabaseService } from '../database/database.service';
import type { AutomationRuntimeService } from '../automation/automation-runtime.service';
import type { ProjectCrmClient } from '../crm/project-crm.client';
import { WebinarActionsService } from './webinar-actions.service';
function fixture() {
  const row = {
    id: 'action',
    projectId: 'project',
    contactId: 'contact',
    kind: 'CRM',
    eventType: 'WEBINAR_ACTIVITY',
    state: 'PENDING',
    attempts: 0,
    dueAt: new Date(0),
    lockedBy: null as string | null,
    payload: {
      attendanceId: 'attendance',
      version: 2,
      webinar: {},
      status: 'ATTENDED',
      attended: true,
    },
    createdAt: new Date('2026-11-03T10:00:00Z'),
  };
  const route = {
    id: 'crm',
    enabled: true,
    status: 'ACTIVE',
    crmProjectId: 'crm-project',
    capabilities: { webinarContractVersion: 'webinars/v1' },
  };
  const event = {
    cancelledAt: null,
    imports: [] as Array<{ id: string }>,
    endsAt: new Date(Date.now() + 60000),
    scheduledAt: new Date(Date.now() + 30000),
  };
  const db = {
    webinarAction: {
      findUnique: vi.fn(async () => ({ ...row })),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { lockedBy?: string };
          data: Record<string, unknown>;
        }) => {
          if (where.lockedBy && where.lockedBy !== row.lockedBy) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
    },
    webinarConnection: { findUnique: vi.fn(async () => ({ enabled: true, connected: true })) },
    webinarEvent: { findFirst: vi.fn(async () => event) },
    webinarInvitation: { findFirst: vi.fn(async () => null) },
    crmProjectConfig: { findUnique: vi.fn(async () => route) },
    contact: { findUnique: vi.fn(async () => ({ crmLeadId: 'lead' })) },
  };
  const crm = {
    reconcile: vi.fn(async () => ({ status: 'NOT_FOUND' })),
    forwardWebinarActivity: vi.fn(async () => ({ operationId: 'op' })),
  };
  const automation = { triggerWebinar: vi.fn(async () => {}) };
  const service = new WebinarActionsService(
    { client: db } as unknown as DatabaseService,
    automation as unknown as AutomationRuntimeService,
    crm as unknown as ProjectCrmClient,
  );
  return { service, row, route, db, crm, automation, event };
}
describe('webinar delivery outbox', () => {
  it('delivers through the paired project with one stable operation key', async () => {
    const f = fixture();
    await f.service.process('action');
    expect(f.crm.forwardWebinarActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        crmProjectId: 'crm-project',
        idempotencyKey: 'webinar:action',
      }),
      expect.objectContaining({ contactId: 'contact', activityId: 'attendance', version: 2 }),
    );
    expect(f.row.state).toBe('SUCCEEDED');
    await f.service.process('action');
    expect(f.crm.forwardWebinarActivity).toHaveBeenCalledTimes(1);
  });
  it('reconciles an uncertain outcome before considering another write', async () => {
    const f = fixture();
    f.crm.forwardWebinarActivity.mockRejectedValueOnce(
      new CrmClientError('UNKNOWN', 'network_outcome_unknown'),
    );
    await f.service.process('action');
    expect(f.row.state).toBe('UNKNOWN');
    f.row.dueAt = new Date(0);
    f.crm.reconcile.mockResolvedValue({ status: 'SUCCEEDED' });
    await f.service.process('action');
    expect(f.row.state).toBe('SUCCEEDED');
    expect(f.crm.forwardWebinarActivity).toHaveBeenCalledTimes(1);
  });
  it('keeps UNKNOWN while CRM reports processing, without a blind retry', async () => {
    const f = fixture();
    f.row.state = 'UNKNOWN';
    f.crm.reconcile.mockResolvedValue({ status: 'PROCESSING' });
    await f.service.process('action');
    expect(f.row.state).toBe('UNKNOWN');
    expect(f.crm.forwardWebinarActivity).not.toHaveBeenCalled();
  });
  it('requires the versioned CRM capability before sending', async () => {
    const f = fixture();
    f.route.capabilities.webinarContractVersion = 'unsupported';
    await f.service.process('action');
    expect(f.row.state).toBe('FAILED');
    expect(f.crm.forwardWebinarActivity).not.toHaveBeenCalled();
  });
  it('dispatches automation through the existing transaction-aware runtime', async () => {
    const f = fixture();
    f.row.kind = 'AUTOMATION';
    await f.service.process('action');
    expect(f.automation.triggerWebinar).toHaveBeenCalledWith('action', expect.any(String));
    expect(f.crm.forwardWebinarActivity).not.toHaveBeenCalled();
  });
});
