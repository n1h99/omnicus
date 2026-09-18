import { createHash } from 'node:crypto';

import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@omnicus/database';

import { DatabaseService } from '../database/database.service';
import { ensureWhatsAppContactIdentity } from '../channels/whatsapp-contact-identity';
import type {
  CrmContactUpsertDto,
  CrmWhatsAppConnectDto,
  CrmWhatsAppConnectionsQueryDto,
} from './dto';
import { CrmOutboundService } from './crm-outbound.service';

type SyncResult = {
  applied: boolean;
  contactId: string;
  created: boolean;
  sourceUpdatedAt: string;
};

@Injectable()
export class CrmContactSyncService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CrmOutboundService) private readonly outbound: CrmOutboundService,
  ) {}

  async whatsAppConnections(
    input: CrmWhatsAppConnectionsQueryDto,
    authenticatedProjectId?: string,
  ) {
    await this.outbound.assertProjectRoute(
      input.crmProjectId,
      input.omnicusProjectId,
      authenticatedProjectId,
    );
    const connections = await this.database.client.channelConnection.findMany({
      where: { projectId: input.omnicusProjectId, type: 'WHATSAPP', status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    return {
      connections: connections.map((connection) => {
        const metadata = this.object(connection.webhookMetadata);
        const name = typeof metadata?.name === 'string' ? metadata.name : 'WhatsApp Business';
        const phone =
          typeof metadata?.displayPhoneNumber === 'string' ? metadata.displayPhoneNumber : null;
        return { id: connection.id, name, phone };
      }),
    };
  }

  async connectWhatsApp(
    input: CrmWhatsAppConnectDto,
    idempotencyKey: string,
    correlationId: string,
    authenticatedProjectId?: string,
  ) {
    const synced = await this.upsert(input, idempotencyKey, correlationId, authenticatedProjectId);
    const identity = await this.database.client.$transaction((transaction) =>
      ensureWhatsAppContactIdentity(
        transaction,
        input.omnicusProjectId,
        synced.contactId,
        input.connectionId,
        'crm',
      ),
    );
    return {
      contactId: synced.contactId,
      connectionId: identity.connectionId,
      channelIdentityId: identity.id,
      externalUserId: identity.externalUserId,
    };
  }

  async upsert(
    input: CrmContactUpsertDto,
    idempotencyKey: string,
    correlationId: string,
    authenticatedProjectId?: string,
  ): Promise<SyncResult> {
    await this.outbound.assertProjectRoute(
      input.crmProjectId,
      input.omnicusProjectId,
      authenticatedProjectId,
    );
    const requestHash = this.requestHash(input);
    return this.database.client.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.omnicusProjectId}), hashtext(${`crm-contact:${input.crmLeadId}`}))`;
      const existingRequest = await transaction.idempotencyRecord.findUnique({
        where: {
          projectId_scope_key: {
            key: idempotencyKey,
            projectId: input.omnicusProjectId,
            scope: 'crm-contact-upsert',
          },
        },
      });
      if (existingRequest) return this.replay(existingRequest.resultSafe, requestHash);

      const sourceUpdatedAt = new Date(input.sourceUpdatedAt);
      const existing = await transaction.contact.findFirst({
        orderBy: { createdAt: 'asc' },
        where: {
          crmLeadId: input.crmLeadId,
          projectId: input.omnicusProjectId,
          status: { not: 'MERGED' },
        },
      });
      const displayName = input.displayName?.trim() || `CRM lead ${input.crmLeadId}`;
      const email = input.email?.trim().toLowerCase() || null;
      const phone = input.phone?.trim() || null;
      const username = input.username?.trim().replace(/^@/, '') || null;
      const stale = Boolean(
        existing?.crmSourceUpdatedAt && existing.crmSourceUpdatedAt > sourceUpdatedAt,
      );
      const contact = stale
        ? existing!
        : existing
          ? await transaction.contact.update({
              data: {
                archivedAt:
                  input.status === 'ARCHIVED'
                    ? (existing.archivedAt ?? sourceUpdatedAt)
                    : existing.status === 'ARCHIVED'
                      ? null
                      : existing.archivedAt,
                crmSourceUpdatedAt: sourceUpdatedAt,
                displayName,
                email,
                normalizedEmail: email,
                normalizedPhone: phone ? phone.replace(/\D/g, '') || null : null,
                phone,
                status:
                  existing.status === 'BLOCKED' || existing.status === 'UNSUBSCRIBED'
                    ? existing.status
                    : input.status === 'ARCHIVED'
                      ? 'ARCHIVED'
                      : existing.status === 'ARCHIVED'
                        ? 'ACTIVE'
                        : existing.status,
                username,
              },
              where: {
                projectId_id: { id: existing.id, projectId: input.omnicusProjectId },
              },
            })
          : await transaction.contact.create({
              data: {
                archivedAt: input.status === 'ARCHIVED' ? sourceUpdatedAt : null,
                crmLeadId: input.crmLeadId,
                crmSourceUpdatedAt: sourceUpdatedAt,
                displayName,
                email,
                normalizedEmail: email,
                normalizedPhone: phone ? phone.replace(/\D/g, '') || null : null,
                phone,
                projectId: input.omnicusProjectId,
                status: input.status ?? 'ACTIVE',
                username,
              },
            });
      const result: SyncResult = {
        applied: !stale,
        contactId: contact.id,
        created: !existing,
        sourceUpdatedAt: (contact.crmSourceUpdatedAt ?? sourceUpdatedAt).toISOString(),
      };
      await transaction.idempotencyRecord.create({
        data: {
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
          key: idempotencyKey,
          projectId: input.omnicusProjectId,
          resultSafe: { ...result, requestHash },
          scope: 'crm-contact-upsert',
        },
      });
      await transaction.auditLog.create({
        data: {
          action: 'crm.contact.synced',
          actorType: 'SERVICE',
          afterSafeJson: {
            applied: result.applied,
            created: result.created,
            crmLeadId: input.crmLeadId,
            source: 'crm',
          },
          correlationId,
          entityId: contact.id,
          entityType: 'Contact',
          projectId: input.omnicusProjectId,
          purgeAfter: new Date(Date.now() + 180 * 24 * 60 * 60 * 1_000),
        },
      });
      return result;
    });
  }

  private replay(value: Prisma.JsonValue | null, requestHash: string): SyncResult {
    const result = this.object(value);
    if (
      result?.requestHash !== requestHash ||
      typeof result.contactId !== 'string' ||
      typeof result.applied !== 'boolean' ||
      typeof result.created !== 'boolean' ||
      typeof result.sourceUpdatedAt !== 'string'
    )
      throw new ConflictException({ code: 'CRM_CONTACT_SYNC_IDEMPOTENCY_CONFLICT' });
    return {
      applied: result.applied,
      contactId: result.contactId,
      created: result.created,
      sourceUpdatedAt: result.sourceUpdatedAt,
    };
  }

  private requestHash(input: CrmContactUpsertDto): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          crmLeadId: input.crmLeadId,
          crmProjectId: input.crmProjectId,
          displayName: input.displayName ?? null,
          email: input.email ?? null,
          omnicusProjectId: input.omnicusProjectId,
          phone: input.phone ?? null,
          sourceUpdatedAt: input.sourceUpdatedAt,
          status: input.status ?? 'ACTIVE',
          username: input.username ?? null,
        }),
      )
      .digest('hex');
  }

  private object(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }
}
