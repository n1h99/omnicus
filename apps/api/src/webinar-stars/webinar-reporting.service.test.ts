import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@omnicus/database';
import type { DatabaseService } from '../database/database.service';
import { WebinarReportingService } from './webinar-reporting.service';

function fixture() {
  const tx = {
    webinarReportImport: {
      findFirst: vi.fn(async (): Promise<Record<string, unknown> | null> => ({
        id: 'report-a',
        externalReportId: '17',
        state: 'COMPLETED',
        historical: false,
        event: { id: 'event-a' },
      })),
    },
    $queryRaw: vi
      .fn<(query: Prisma.Sql) => Promise<unknown[]>>()
      .mockResolvedValueOnce([
        {
          participants: 2n,
          attended: 1n,
          missed: 1n,
          completed: 0n,
          partial: 1n,
          ctaClicked: 0n,
          replay: 0n,
          unmatched: 1n,
          ignored: 1n,
          comments: 0n,
        },
      ])
      .mockResolvedValueOnce([{ total: 1n }])
      .mockResolvedValueOnce([{ id: 'viewer-a', result: { ctaClicked: null } }]),
    webinarInvitation: { count: vi.fn(async () => 3) },
    webinarAction: { count: vi.fn(async () => 1) },
  };
  const client = { $transaction: vi.fn(async (run: (value: typeof tx) => unknown) => run(tx)) };
  return {
    tx,
    client,
    service: new WebinarReportingService({ client } as unknown as DatabaseService),
  };
}
describe('Saved webinar reporting', () => {
  it('scopes every query to the project and report, parameterizes search and uses a consistent snapshot', async () => {
    const { service, tx, client } = fixture();
    const malicious = "%' OR true --";
    const result = await service.report('project-a', {
      importId: 'report-a',
      search: malicious,
      cta: 'unknown',
      page: '2',
      pageSize: '20',
    });
    expect(tx.webinarReportImport.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: 'project-a', id: 'report-a' } }),
    );
    expect(client.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
    for (const [sql] of tx.$queryRaw.mock.calls) {
      expect(sql.values).toContain('project-a');
      expect(sql.values).toContain('report-a');
      expect(sql.text).not.toContain(malicious);
    }
    const pageQuery = tx.$queryRaw.mock.calls[2]![0];
    expect(pageQuery.values).toContain(malicious);
    expect(pageQuery.values.slice(-2)).toEqual([20, 20]);
    expect(result).toMatchObject({
      total: 1,
      page: 2,
      summary: { registered: 3, participants: 2, unmatched: 1, ignored: 1, deliveryErrors: 1 },
      items: [{ result: { ctaClicked: null } }],
    });
  });
  it.each([
    { page: '0' },
    { pageSize: '1000' },
    { page: '1.5' },
    { cta: 'false' },
    { replay: 'maybe' },
    { status: 'raw-provider-status' },
    { match: 'ANY' },
    { sort: 'DROP TABLE contacts' },
    { search: 'a'.repeat(121) },
    { search: ['a', 'b'] },
  ])('rejects malformed filters before accessing the database: %j', async (query) => {
    const { service, client } = fixture();
    await expect(
      service.report('project-a', query as Record<string, string>),
    ).rejects.toMatchObject({ status: 400 });
    expect(client.$transaction).not.toHaveBeenCalled();
  });
  it('does not disclose whether another project owns an explicitly requested import', async () => {
    const { service, tx } = fixture();
    tx.webinarReportImport.findFirst.mockResolvedValue(null);
    await expect(service.report('project-b', { importId: 'report-a' })).rejects.toMatchObject({
      status: 404,
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('returns an empty workspace before any report has been imported', async () => {
    const { service, tx } = fixture();
    tx.webinarReportImport.findFirst.mockResolvedValue(null);
    expect(await service.report('project-a', {})).toEqual({
      report: null,
      summary: null,
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
  });
});
