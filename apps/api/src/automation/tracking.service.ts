import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@omnicus/database';
import { createHash } from 'node:crypto';

import { DatabaseService } from '../database/database.service';

export interface TrackClickInput {
  ip?: string;
  referrer?: string;
  userAgent?: string;
}

@Injectable()
export class TrackingService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async target(token: string): Promise<string> {
    const link = await this.database.client.trackedLink.findUnique({
      select: { targetUrl: true },
      where: { token },
    });
    if (!link) throw new NotFoundException('tracked_link_not_found');
    return this.safeTarget(link.targetUrl);
  }

  async click(token: string, input: TrackClickInput): Promise<string> {
    return this.database.client.$transaction(async (transaction) => {
      const link = await transaction.trackedLink.findUnique({ where: { token } });
      if (!link) throw new NotFoundException('tracked_link_not_found');
      const now = new Date();
      const userAgent = input.userAgent?.slice(0, 1_000);
      const isLikelyBot = this.likelyBot(userAgent);
      await transaction.trackedLinkClick.create({
        data: {
          contactId: link.contactId,
          ...(input.ip ? { ipHash: createHash('sha256').update(input.ip).digest('hex') } : {}),
          isLikelyBot,
          projectId: link.projectId,
          ...(input.referrer ? { referrer: input.referrer.slice(0, 2_000) } : {}),
          trackedLinkId: link.id,
          ...(userAgent ? { userAgent } : {}),
        },
      });
      await transaction.trackedLink.update({
        data: { clickCount: { increment: 1 }, lastClickedAt: now },
        where: { id: link.id },
      });
      if (!isLikelyBot) {
        const first = await transaction.trackedLink.updateMany({
          data: { firstClickedAt: now },
          where: { firstClickedAt: null, id: link.id },
        });
        if (first.count === 1) await this.queueCrmClick(transaction, link, now, userAgent);
      }
      return this.safeTarget(link.targetUrl);
    });
  }

  private async queueCrmClick(
    transaction: Prisma.TransactionClient,
    link: {
      contactId: string;
      id: string;
      nodeId: string;
      projectId: string;
      scenarioExecutionId: string;
      targetUrl: string;
    },
    clickedAt: Date,
    userAgent: string | undefined,
  ): Promise<void> {
    const crmConfig = await transaction.crmProjectConfig.findUnique({
      select: { enabled: true, status: true },
      where: { projectId: link.projectId },
    });
    if (!crmConfig?.enabled || crmConfig.status !== 'ACTIVE') return;
    const payload = {
      clickedAt: clickedAt.toISOString(),
      contactId: link.contactId,
      nodeId: link.nodeId,
      scenarioExecutionId: link.scenarioExecutionId,
      targetUrl: link.targetUrl,
      trackedLinkId: link.id,
      ...(userAgent ? { userAgent } : {}),
    };
    const outbox = await transaction.outboxRecord.create({
      data: {
        idempotencyKey: `tracked-link:first-click:${link.id}`,
        kind: 'CRM',
        maxAttempts: 12,
        nextAttemptAt: new Date(),
        payload,
        projectId: link.projectId,
      },
    });
    await transaction.crmOperation.create({
      data: {
        contactId: link.contactId,
        inputSafe: payload,
        outboxRecordId: outbox.id,
        projectId: link.projectId,
        type: 'FORWARD_TRACKED_LINK_CLICK',
      },
    });
  }

  private likelyBot(userAgent: string | undefined): boolean {
    return (
      !userAgent ||
      /bot|crawler|spider|preview|facebookexternalhit|whatsapp|telegrambot|slackbot|discordbot/i.test(
        userAgent,
      )
    );
  }

  private safeTarget(value: string): string {
    const target = new URL(value);
    if (!['http:', 'https:'].includes(target.protocol))
      throw new NotFoundException('tracked_link_invalid');
    return target.toString();
  }
}
