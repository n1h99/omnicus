import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@omnicus/database';
import { DatabaseService } from '../database/database.service';

const statuses = [
  'ATTENDED',
  'MISSED',
  'PARTIALLY_WATCHED',
  'COMPLETED',
  'REPLAY_VIEWED',
  'UNKNOWN',
];
const matches = ['MATCHED', 'MANUAL', 'UNMATCHED', 'IGNORED'];
export interface ReportParticipant {
  id: string;
  contactId: string | null;
  contactName: string | null;
  crmLeadId: string | null;
  matchState: string;
  matchReason: string | null;
  result: Record<string, unknown>;
}
type Counts = Record<
  | 'participants'
  | 'attended'
  | 'missed'
  | 'completed'
  | 'partial'
  | 'ctaClicked'
  | 'replay'
  | 'unmatched'
  | 'ignored'
  | 'comments',
  bigint
>;

@Injectable()
export class WebinarReportingService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async report(projectId: string, query: Record<string, string | undefined>) {
    if (Object.values(query).some((value) => value !== undefined && typeof value !== 'string'))
      throw new BadRequestException({
        code: 'WEBINAR_REPORT_FILTER_INVALID',
        message: 'Invalid report filter',
      });
    const page = Number(query.page ?? 1),
      pageSize = Number(query.pageSize ?? 20);
    const search = query.search?.trim() ?? '';
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100000 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100 ||
      search.length > 120 ||
      (query.status && !statuses.includes(query.status)) ||
      (query.match && !matches.includes(query.match)) ||
      (query.cta && !['yes', 'no', 'unknown'].includes(query.cta)) ||
      (query.replay && !['yes', 'no', 'unknown'].includes(query.replay)) ||
      (query.sort && !['name', 'watched'].includes(query.sort))
    )
      throw new BadRequestException({
        code: 'WEBINAR_REPORT_FILTER_INVALID',
        message: 'Invalid report filter',
      });
    return this.database.client.$transaction(
      async (tx) => {
        const report = await tx.webinarReportImport.findFirst({
          where: { projectId, ...(query.importId ? { id: query.importId } : {}) },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            externalReportId: true,
            state: true,
            historical: true,
            summary: true,
            lastError: true,
            processedAt: true,
            event: {
              select: { id: true, title: true, timezone: true, scheduledAt: true, endsAt: true },
            },
          },
        });
        if (!report) {
          if (query.importId) throw new NotFoundException();
          return { report: null, summary: null, items: [], total: 0, page, pageSize };
        }
        const scope = Prisma.sql`a."projectId" = ${projectId} AND a."importId" = ${report.id}`;
        const conditions = [
          scope,
          query.match
            ? Prisma.sql`a."matchState" = ${query.match}`
            : Prisma.sql`a."matchState" <> 'IGNORED'`,
        ];
        if (query.status) conditions.push(Prisma.sql`a.result->>'status' = ${query.status}`);
        for (const [name, key] of [
          ['cta', 'ctaClicked'],
          ['replay', 'isReplay'],
        ] as const) {
          const value = query[name];
          if (value === 'unknown') conditions.push(Prisma.sql`(a.result->>${key}) IS NULL`);
          else if (value)
            conditions.push(Prisma.sql`a.result->>${key} = ${value === 'yes' ? 'true' : 'false'}`);
        }
        if (search)
          conditions.push(
            Prisma.sql`strpos(lower(concat_ws(' ', a.result->>'name', a.result->>'email', a.result->>'phone', c."displayName", c."crmLeadId", a.result->>'distributorId', a.result->'utm'->>'utm_source', a.result->'utm'->>'utm_campaign')), lower(${search})) > 0`,
          );
        const filter = Prisma.join(conditions, ' AND ');
        const [counts] = await tx.$queryRaw<Counts[]>(Prisma.sql`
        SELECT count(*) FILTER (WHERE "matchState" <> 'IGNORED') AS participants,
          count(*) FILTER (WHERE "matchState" <> 'IGNORED' AND result->>'attended' = 'true') AS attended,
          count(*) FILTER (WHERE "matchState" <> 'IGNORED' AND result->>'status' = 'MISSED') AS missed,
          count(*) FILTER (WHERE "matchState" <> 'IGNORED' AND result->>'completed' = 'true') AS completed,
          count(*) FILTER (WHERE "matchState" <> 'IGNORED' AND result->>'status' = 'PARTIALLY_WATCHED') AS partial,
          count(*) FILTER (WHERE "matchState" <> 'IGNORED' AND result->>'ctaClicked' = 'true') AS "ctaClicked",
          count(*) FILTER (WHERE "matchState" <> 'IGNORED' AND result->>'isReplay' = 'true') AS replay,
          count(*) FILTER (WHERE "matchState" = 'UNMATCHED') AS unmatched,
          count(*) FILTER (WHERE "matchState" = 'IGNORED') AS ignored,
          COALESCE(sum(CASE WHEN "matchState" <> 'IGNORED' AND jsonb_typeof(result->'commentsCount') = 'number' THEN (result->>'commentsCount')::bigint ELSE 0 END), 0)::bigint AS comments
        FROM webinar_attendances a WHERE ${scope}`);
        const joined = Prisma.sql`FROM webinar_attendances a LEFT JOIN contacts c ON c."projectId" = a."projectId" AND c.id = a."contactId" WHERE ${filter}`;
        const [total] = await tx.$queryRaw<Array<{ total: bigint }>>(
          Prisma.sql`SELECT count(*) AS total ${joined}`,
        );
        const order =
          query.sort === 'watched'
            ? Prisma.sql`CASE WHEN jsonb_typeof(a.result->'watchedSeconds') = 'number' THEN (a.result->>'watchedSeconds')::numeric END DESC NULLS LAST, a.id`
            : Prisma.sql`lower(COALESCE(c."displayName", a.result->>'name', '')), a.id`;
        const items = await tx.$queryRaw<ReportParticipant[]>(Prisma.sql`
        SELECT a.id, a."contactId", c."displayName" AS "contactName", c."crmLeadId", a."matchState", a."matchReason", a.result - 'trackingToken' AS result
        ${joined} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
        const registered = report.event
          ? await tx.webinarInvitation.count({
              where: { projectId, eventId: report.event.id, cancelledAt: null },
            })
          : null;
        const deliveryErrors = await tx.webinarAction.count({
          where: {
            projectId,
            state: { in: ['FAILED', 'UNKNOWN'] },
            payload: { path: ['webinar', 'id'], equals: report.externalReportId },
          },
        });
        return {
          report,
          summary: {
            ...Object.fromEntries(
              Object.entries(counts!).map(([key, value]) => [key, Number(value)]),
            ),
            registered,
            deliveryErrors,
          },
          items,
          total: Number(total!.total),
          page,
          pageSize,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
