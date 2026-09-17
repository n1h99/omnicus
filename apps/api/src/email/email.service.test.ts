import { describe, expect, it, vi } from 'vitest';

import { EmailService } from './email.service';

describe('EmailService audience groups', () => {
  it('applies manual contact-group membership when estimating a campaign', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        displayName: 'Contact A',
        email: 'a@example.test',
        id: 'contact-a',
        normalizedEmail: 'a@example.test',
      },
      {
        displayName: 'Contact B',
        email: 'b@example.test',
        id: 'contact-b',
        normalizedEmail: 'b@example.test',
      },
    ]);
    const instance = new EmailService(
      {
        client: {
          contact: { findMany },
          emailCampaign: {
            findUnique: vi.fn().mockResolvedValue({
              audience: { mode: 'SEGMENT', segmentId: 'segment-a' },
              id: 'campaign-a',
              projectId: 'project-a',
            }),
          },
          emailSuppression: { findMany: vi.fn().mockResolvedValue([]) },
          segment: {
            findFirst: vi.fn().mockResolvedValue({
              filter: { contactIds: ['contact-a', 'contact-b'] },
              id: 'segment-a',
            }),
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(instance.estimateCampaign('project-a', 'campaign-a')).resolves.toEqual({
      duplicateAddresses: 0,
      eligibleRecipients: 2,
      excludedSuppressed: 0,
      totalMatched: 2,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['contact-a', 'contact-b'] },
          projectId: 'project-a',
          status: 'ACTIVE',
        }),
      }),
    );
  });
});
