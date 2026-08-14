import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';
import { AutomationRuntimeService } from './automation-runtime.service';

@Injectable()
export class LeadCaptureProcessorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeadCaptureProcessorService.name);
  private timer?: NodeJS.Timeout;
  private draining = false;
  private readonly workerId = `lead-capture:${process.pid}`;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AutomationRuntimeService) private readonly runtime: AutomationRuntimeService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.drain(), 1_000);
    this.timer.unref();
    void this.drain();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const now = new Date();
      const stale = new Date(now.getTime() - 5 * 60 * 1_000);
      const events = await this.database.client.leadCaptureEvent.findMany({
        orderBy: { createdAt: 'asc' },
        take: 20,
        where: {
          nextAttemptAt: { lte: now },
          OR: [
            { status: { in: ['PENDING', 'RETRY'] } },
            { lockedAt: { lt: stale }, status: 'PROCESSING' },
          ],
        },
      });
      for (const event of events) await this.process(event.id);
    } finally {
      this.draining = false;
    }
  }

  private async process(eventId: string): Promise<void> {
    const stale = new Date(Date.now() - 5 * 60 * 1_000);
    const claimed = await this.database.client.leadCaptureEvent.updateMany({
      data: { attempts: { increment: 1 }, lockedAt: new Date(), lockedBy: this.workerId, status: 'PROCESSING' },
      where: {
        id: eventId,
        OR: [
          { status: { in: ['PENDING', 'RETRY'] } },
          { lockedAt: { lt: stale }, status: 'PROCESSING' },
        ],
      },
    });
    if (claimed.count !== 1) return;
    try {
      await this.runtime.triggerLeadCapture(eventId);
    } catch (error) {
      const current = await this.database.client.leadCaptureEvent.findUnique({ where: { id: eventId } });
      if (!current) return;
      const exhausted = current.attempts >= current.maxAttempts;
      await this.database.client.leadCaptureEvent.update({
        data: {
          lastError: error instanceof Error ? error.message.slice(0, 200) : 'lead_capture_processing_failed',
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: new Date(Date.now() + Math.min(300_000, 1_000 * 2 ** Math.min(current.attempts, 8))),
          status: exhausted ? 'FAILED' : 'RETRY',
        },
        where: { id: eventId },
      });
      if (exhausted) this.logger.error(`Lead capture ${eventId} exhausted retries`);
    }
  }
}
