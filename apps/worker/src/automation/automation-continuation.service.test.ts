import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import { AutomationContinuationService } from './automation-continuation.service';

describe('AutomationContinuationService', () => {
  it('resumes only due durable delays and waits', async () => {
    const resumeDelayedAction = vi.fn().mockResolvedValue(undefined);
    const timeoutWait = vi.fn().mockResolvedValue(undefined);
    const delayedAction = { findMany: vi.fn().mockResolvedValue([{ id: 'delay-a' }]) };
    const waitState = { findMany: vi.fn().mockResolvedValue([{ id: 'wait-a' }]) };
    const service = new AutomationContinuationService(
      new ConfigService({
        AUTOMATION_CONTINUATION_BATCH_SIZE: 10,
        AUTOMATION_CONTINUATION_INTERVAL_MS: 10_000,
      }) as never,
      { client: { delayedAction, waitState } } as never,
      { resumeDelayedAction, timeoutWait } as never,
    );

    await service.scanOnce(new Date('2026-07-27T00:00:00.000Z'));

    expect(resumeDelayedAction).toHaveBeenCalledWith('delay-a');
    expect(timeoutWait).toHaveBeenCalledWith('wait-a');
    expect(delayedAction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { nextAttemptAt: { lte: expect.any(Date) }, status: 'PENDING' },
      }),
    );
  });

  it('continues scanning after one continuation fails', async () => {
    const resumeDelayedAction = vi
      .fn()
      .mockRejectedValueOnce(new Error('automation_delay_resume_failed'))
      .mockResolvedValueOnce(undefined);
    const timeoutWait = vi.fn().mockResolvedValue(undefined);
    const delayedAction = {
      findMany: vi.fn().mockResolvedValue([{ id: 'delay-bad' }, { id: 'delay-good' }]),
    };
    const waitState = { findMany: vi.fn().mockResolvedValue([{ id: 'wait-good' }]) };
    const service = new AutomationContinuationService(
      new ConfigService({
        AUTOMATION_CONTINUATION_BATCH_SIZE: 10,
        AUTOMATION_CONTINUATION_INTERVAL_MS: 10_000,
      }) as never,
      { client: { delayedAction, waitState } } as never,
      { resumeDelayedAction, timeoutWait } as never,
    );

    await service.scanOnce(new Date('2026-07-27T00:00:00.000Z'));

    expect(resumeDelayedAction).toHaveBeenNthCalledWith(1, 'delay-bad');
    expect(resumeDelayedAction).toHaveBeenNthCalledWith(2, 'delay-good');
    expect(timeoutWait).toHaveBeenCalledWith('wait-good');
  });
});
