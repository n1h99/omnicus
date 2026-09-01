import { describe, expect, it, vi } from 'vitest';

import { ContactsService } from './contacts.service';

function service() {
  return new ContactsService({ record: vi.fn() } as never, { client: {} } as never);
}

describe('ContactsService v2', () => {
  it('returns tracked link clicks with safe scenario context in the contact timeline', async () => {
    const createdAt = new Date('2026-08-14T05:00:00.000Z');
    const occurredAt = new Date('2026-08-14T05:26:23.000Z');
    const database = {
      client: {
        auditLog: { findMany: vi.fn().mockResolvedValue([]) },
        emailEvent: { findMany: vi.fn().mockResolvedValue([]) },
        scenarioExecution: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'execution-a',
              scenario: { id: 'scenario-a', name: 'QA Tracked Link' },
              triggerType: 'INCOMING_MESSAGE',
            },
          ]),
        },
        trackedLink: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'link-a',
              nodeId: 'send-a',
              scenarioExecutionId: 'execution-a',
              targetUrl: 'https://example.com/tracked',
            },
          ]),
        },
        trackedLinkClick: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'click-a',
              isLikelyBot: false,
              occurredAt,
              trackedLinkId: 'link-a',
            },
          ]),
        },
      },
    };
    const instance = new ContactsService({ record: vi.fn() } as never, database as never);
    vi.spyOn(instance, 'get').mockResolvedValue({ createdAt } as never);

    await expect(instance.timeline('project-a', 'contact-a')).resolves.toMatchObject({
      createdAt,
      trackedLinkClicks: [
        {
          id: 'click-a',
          isLikelyBot: false,
          occurredAt,
          scenario: { id: 'scenario-a', name: 'QA Tracked Link' },
          targetUrl: 'https://example.com/tracked',
          triggerType: 'INCOMING_MESSAGE',
        },
      ],
    });
  });

  it('includes provider-tracked email clicks in the contact timeline', async () => {
    const createdAt = new Date('2026-09-01T15:22:32.000Z');
    const occurredAt = new Date('2026-09-01T15:25:25.000Z');
    const emailEventFindMany = vi.fn().mockResolvedValue([
      {
        delivery: {
          campaign: null,
          nodeId: 'send-email-a',
          scenarioExecutionId: 'execution-a',
          source: 'AUTOMATION',
        },
        id: 'email-event-a',
        occurredAt,
        providerPayload: {
          data: { click: { user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } },
        },
        targetUrl: 'https://example.com/email-link',
      },
    ]);
    const database = {
      client: {
        auditLog: { findMany: vi.fn().mockResolvedValue([]) },
        emailEvent: { findMany: emailEventFindMany },
        scenarioExecution: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'execution-a',
              scenario: { id: 'scenario-a', name: 'QA Website Registration' },
              triggerType: 'WEBSITE_REGISTRATION',
            },
          ]),
        },
        trackedLink: { findMany: vi.fn().mockResolvedValue([]) },
        trackedLinkClick: { findMany: vi.fn().mockResolvedValue([]) },
      },
    };
    const instance = new ContactsService({ record: vi.fn() } as never, database as never);
    vi.spyOn(instance, 'get').mockResolvedValue({ createdAt } as never);

    await expect(instance.timeline('project-a', 'contact-a')).resolves.toMatchObject({
      createdAt,
      trackedLinkClicks: [
        {
          id: 'email-event:email-event-a',
          isLikelyBot: false,
          nodeId: 'send-email-a',
          occurredAt,
          scenario: { id: 'scenario-a', name: 'QA Website Registration' },
          scenarioExecutionId: 'execution-a',
          targetUrl: 'https://example.com/email-link',
          trackedLinkId: 'email-event:email-event-a',
          triggerType: 'WEBSITE_REGISTRATION',
        },
      ],
    });
    expect(emailEventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          delivery: { contactId: 'contact-a', projectId: 'project-a' },
          projectId: 'project-a',
          type: 'CLICKED',
        }),
      }),
    );
  });

  it('lists archived custom fields separately and restores them safely', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const findUnique = vi.fn().mockResolvedValue({ archivedAt: new Date(), id: 'field-a' });
    const update = vi.fn().mockResolvedValue({ archivedAt: null, id: 'field-a' });
    const audit = { record: vi.fn() };
    const instance = new ContactsService(
      audit as never,
      {
        client: { customFieldDefinition: { findMany, findUnique, update } },
      } as never,
    );

    await instance.listCustomFields('project-a', true);
    await expect(
      instance.restoreCustomField('project-a', 'field-a', {
        actorEmail: 'operator@example.test',
        actorUserId: 'user-a',
        correlationId: 'test',
      }),
    ).resolves.toMatchObject({ archivedAt: null });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { archivedAt: { not: null }, projectId: 'project-a' },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'custom_field.restored' }),
    );
  });

  it('rejects a merge request where primary and secondary are identical', async () => {
    await expect(
      service().merge(
        'project-a',
        { primaryContactId: 'contact-a', secondaryContactId: 'contact-a' },
        { actorEmail: 'operator@example.test', actorUserId: 'user-a', correlationId: 'test' },
      ),
    ).rejects.toMatchObject({
      response: { code: 'CONTACT_MERGE_IDENTICAL', message: 'Contacts must be different' },
    });
  });

  it('rejects a segment filter with unsupported predicates before it reaches persistence', async () => {
    await expect(
      service().createSegment(
        'project-a',
        { filter: { arbitrarySql: 'nope' }, name: 'Unsafe' },
        { actorEmail: 'operator@example.test', actorUserId: 'user-a', correlationId: 'test' },
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'SEGMENT_FILTER_INVALID',
        message: 'Segment filter contains an unsupported predicate',
      },
    });
  });
});
