import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, ScenarioExecutionStatus } from '@omnicus/database';

import { DatabaseService } from '../database/database.service';
import type { AutomationActivityQueryDto } from './dto';

const dayMs = 24 * 60 * 60 * 1_000;
const activeStatuses: ScenarioExecutionStatus[] = ['QUEUED', 'RUNNING'];
const waitingStatuses: ScenarioExecutionStatus[] = ['WAITING', 'PAUSED'];
const problemStatuses: ScenarioExecutionStatus[] = ['FAILED', 'CANCELLED'];

const statusLabels: Record<ScenarioExecutionStatus, string> = {
  CANCELLED: 'Stopped',
  COMPLETED: 'Completed',
  FAILED: 'Needs attention',
  PAUSED: 'Paused for review',
  QUEUED: 'Starting',
  RUNNING: 'In progress',
  WAITING: 'Waiting',
};

const nodeLabels: Record<string, string> = {
  ADD_TAG: 'Add tag',
  CLEAR_CUSTOM_FIELD: 'Clear custom field',
  CONDITION: 'Check a condition',
  CREATE_OR_UPDATE_LEAD: 'Update the CRM lead',
  DELAY: 'Wait for a set time',
  EXTERNAL_HTTP_REQUEST: 'Contact an external service',
  FORWARD_TO_CRM: 'Send information to CRM',
  INCOMING_MESSAGE: 'Incoming message',
  PAUSE_AUTOMATION: 'Pause automation',
  REMOVE_TAG: 'Remove tag',
  RESUME_AUTOMATION: 'Resume automation',
  SEND_MESSAGE: 'Send a message',
  SEND_TEMPLATE: 'Send a template',
  SET_CUSTOM_FIELD: 'Update a custom field',
  START_SUBFLOW: 'Start another automation',
  STOP: 'Finish',
  WAIT_FOR_REPLY: 'Wait for a reply',
};

const errorLabels: Record<string, string> = {
  automation_execution_context_missing: 'The contact or conversation is no longer available.',
  automation_graph_invalid: 'This automation version is no longer valid.',
  automation_step_budget_exhausted: 'The automation stopped to prevent an endless loop.',
  external_http_unknown_requires_review:
    'The external service result is uncertain and needs a safe review.',
  telegram_channel_identity_missing: 'No available Telegram connection was found for the contact.',
  telegram_message_content_missing: 'The message step has no content to send.',
};

interface ReasonSource {
  cancellationRequestedAt?: Date | null;
  errorSafe?: unknown;
  status: ScenarioExecutionStatus;
}

@Injectable()
export class AutomationActivityService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(projectId: string, query: AutomationActivityQueryDto) {
    const since = this.startOfDay(new Date(Date.now() - (query.periodDays - 1) * dayMs));
    const where = this.where(projectId, query, since);
    const [items, total, statuses, scenarioStatuses, trendSource] = await Promise.all([
      this.database.client.scenarioExecution.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          cancellationRequestedAt: true,
          completedAt: true,
          contact: {
            select: {
              displayName: true,
              email: true,
              firstName: true,
              id: true,
              lastName: true,
              phone: true,
              username: true,
            },
          },
          createdAt: true,
          currentNodeId: true,
          delayedActions: {
            orderBy: { createdAt: 'desc' },
            select: { nextAttemptAt: true, nodeId: true, status: true },
            take: 1,
          },
          errorSafe: true,
          failedAt: true,
          id: true,
          nodeExecutions: {
            orderBy: [{ startedAt: 'asc' }, { nodeId: 'asc' }],
            select: {
              completedAt: true,
              errorSafe: true,
              nodeId: true,
              nodeType: true,
              startedAt: true,
              status: true,
            },
          },
          scenario: { select: { id: true, name: true } },
          scenarioVersion: { select: { version: true } },
          startedAt: true,
          status: true,
          updatedAt: true,
          waitStates: {
            orderBy: { createdAt: 'desc' },
            select: { expiresAt: true, nodeId: true, status: true },
            take: 1,
          },
        },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        where,
      }),
      this.database.client.scenarioExecution.count({ where }),
      this.database.client.scenarioExecution.groupBy({
        _count: { _all: true },
        by: ['status'],
        where,
      }),
      this.database.client.scenarioExecution.groupBy({
        _count: { _all: true },
        by: ['scenarioId', 'status'],
        where,
      }),
      this.database.client.scenarioExecution.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          cancellationRequestedAt: true,
          createdAt: true,
          errorSafe: true,
          status: true,
        },
        take: 2_000,
        where,
      }),
    ]);

    const scenarioIds = [...new Set(scenarioStatuses.map((entry) => entry.scenarioId))];
    const scenarios = scenarioIds.length
      ? await this.database.client.scenario.findMany({
          select: { id: true, name: true },
          where: { id: { in: scenarioIds }, projectId },
        })
      : [];
    const scenarioNames = new Map(scenarios.map((scenario) => [scenario.id, scenario.name]));
    const summary = this.summary(statuses);
    const trackedLinks = items.length
      ? await this.database.client.trackedLink.findMany({
          orderBy: { createdAt: 'asc' },
          select: {
            firstClickedAt: true,
            nodeId: true,
            scenarioExecutionId: true,
            targetUrl: true,
          },
          where: {
            firstClickedAt: { not: null },
            scenarioExecutionId: { in: items.map((execution) => execution.id) },
          },
        })
      : [];
    const trackedLinksByExecution = new Map<string, typeof trackedLinks>();
    for (const link of trackedLinks) {
      const links = trackedLinksByExecution.get(link.scenarioExecutionId) ?? [];
      links.push(link);
      trackedLinksByExecution.set(link.scenarioExecutionId, links);
    }

    return {
      breakdown: {
        reasons: this.reasons(trendSource),
        scenarios: this.scenarios(scenarioStatuses, scenarioNames),
        statuses: statuses.map((entry) => ({
          count: entry._count._all,
          label: statusLabels[entry.status],
          status: entry.status,
        })),
      },
      items: items.map((execution) => {
        const currentNode = execution.nodeExecutions.find(
          (node) => node.nodeId === execution.currentNodeId,
        );
        const waiting = execution.waitStates[0];
        const delayed = execution.delayedActions[0];
        return {
          completedAt: execution.completedAt,
          contact: {
            displayName:
              execution.contact.displayName ??
              ([execution.contact.firstName, execution.contact.lastName]
                .filter(Boolean)
                .join(' ') ||
                null),
            email: execution.contact.email,
            id: execution.contact.id,
            phone: execution.contact.phone,
            username: execution.contact.username,
          },
          createdAt: execution.createdAt,
          currentStep: currentNode
            ? { label: this.nodeLabel(currentNode.nodeType), type: currentNode.nodeType }
            : null,
          durationMs: this.duration(
            execution.startedAt,
            execution.completedAt ?? execution.failedAt,
          ),
          id: execution.id,
          reason: this.reason(execution, waiting, delayed),
          scenario: {
            id: execution.scenario.id,
            name: execution.scenario.name,
            version: execution.scenarioVersion.version,
          },
          startedAt: execution.startedAt,
          status: execution.status,
          statusLabel: statusLabels[execution.status],
          timeline: [
            ...execution.nodeExecutions.map((node) => ({
              completedAt: node.completedAt,
              label: this.nodeLabel(node.nodeType),
              nodeId: node.nodeId,
              reason: node.status === 'FAILED' ? this.errorLabel(node.errorSafe) : null,
              startedAt: node.startedAt,
              status: node.status,
            })),
            ...(trackedLinksByExecution.get(execution.id) ?? []).map((link) => ({
              completedAt: link.firstClickedAt,
              label: 'Tracked link opened',
              nodeId: link.nodeId,
              reason: link.targetUrl,
              startedAt: link.firstClickedAt,
              status: 'COMPLETED' as const,
            })),
          ].sort(
            (left, right) =>
              (left.startedAt?.getTime() ?? 0) - (right.startedAt?.getTime() ?? 0),
          ),
          updatedAt: execution.updatedAt,
        };
      }),
      page: query.page,
      pageSize: query.pageSize,
      periodDays: query.periodDays,
      summary,
      total,
      trend: this.trend(trendSource, since, query.periodDays),
      trendSampled: total > trendSource.length,
    };
  }

  private where(
    projectId: string,
    query: AutomationActivityQueryDto,
    since: Date,
  ): Prisma.ScenarioExecutionWhereInput {
    const search = query.query?.trim();
    return {
      createdAt: { gte: since },
      projectId,
      ...(query.scenarioId ? { scenarioId: query.scenarioId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(search
        ? {
            OR: [
              { scenario: { is: { name: { contains: search, mode: 'insensitive' } } } },
              { contact: { is: { displayName: { contains: search, mode: 'insensitive' } } } },
              { contact: { is: { email: { contains: search, mode: 'insensitive' } } } },
              { contact: { is: { phone: { contains: search } } } },
              { contact: { is: { username: { contains: search, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };
  }

  private summary(groups: Array<{ _count: { _all: number }; status: ScenarioExecutionStatus }>) {
    const count = (targets: ScenarioExecutionStatus[]) =>
      groups
        .filter((entry) => targets.includes(entry.status))
        .reduce((sum, entry) => sum + entry._count._all, 0);
    return {
      active: count(activeStatuses),
      completed: count(['COMPLETED']),
      problems: count(problemStatuses),
      total: groups.reduce((sum, entry) => sum + entry._count._all, 0),
      waiting: count(waitingStatuses),
    };
  }

  private scenarios(
    groups: Array<{
      _count: { _all: number };
      scenarioId: string;
      status: ScenarioExecutionStatus;
    }>,
    names: Map<string, string>,
  ) {
    const result = new Map<
      string,
      {
        active: number;
        completed: number;
        id: string;
        name: string;
        problems: number;
        total: number;
      }
    >();
    for (const entry of groups) {
      const current = result.get(entry.scenarioId) ?? {
        active: 0,
        completed: 0,
        id: entry.scenarioId,
        name: names.get(entry.scenarioId) ?? 'Archived automation',
        problems: 0,
        total: 0,
      };
      current.total += entry._count._all;
      if (activeStatuses.includes(entry.status)) current.active += entry._count._all;
      if (entry.status === 'COMPLETED') current.completed += entry._count._all;
      if (problemStatuses.includes(entry.status)) current.problems += entry._count._all;
      result.set(entry.scenarioId, current);
    }
    return [...result.values()].sort((left, right) => right.total - left.total).slice(0, 8);
  }

  private trend(
    source: Array<{ createdAt: Date; status: ScenarioExecutionStatus }>,
    since: Date,
    periodDays: number,
  ) {
    const buckets = Array.from({ length: periodDays }, (_, index) => {
      const date = new Date(since.getTime() + index * dayMs).toISOString().slice(0, 10);
      return { completed: 0, date, problems: 0, started: 0 };
    });
    const byDate = new Map(buckets.map((bucket) => [bucket.date, bucket]));
    for (const execution of source) {
      const bucket = byDate.get(execution.createdAt.toISOString().slice(0, 10));
      if (!bucket) continue;
      bucket.started += 1;
      if (execution.status === 'COMPLETED') bucket.completed += 1;
      if (problemStatuses.includes(execution.status)) bucket.problems += 1;
    }
    return buckets;
  }

  private reasons(source: ReasonSource[]) {
    const reasons = new Map<string, { count: number; label: string }>();
    for (const execution of source) {
      if (!['FAILED', 'CANCELLED', 'PAUSED'].includes(execution.status)) continue;
      const label = this.reason(execution);
      const current = reasons.get(label) ?? { count: 0, label };
      current.count += 1;
      reasons.set(label, current);
    }
    return [...reasons.values()].sort((left, right) => right.count - left.count).slice(0, 6);
  }

  private reason(
    execution: ReasonSource,
    wait?: { expiresAt: Date; status: string },
    delay?: { nextAttemptAt: Date; status: string },
  ): string {
    if (execution.status === 'COMPLETED') return 'Finished normally';
    if (execution.status === 'CANCELLED')
      return execution.cancellationRequestedAt
        ? 'Stopped by an operator'
        : 'Stopped before completion';
    if (execution.status === 'FAILED') return this.errorLabel(execution.errorSafe);
    if (execution.status === 'PAUSED')
      return this.errorLabel(execution.errorSafe, 'Paused until an operator reviews it');
    if (execution.status === 'WAITING' && wait?.status === 'ACTIVE')
      return `Waiting for a reply until ${wait.expiresAt.toISOString()}`;
    if (execution.status === 'WAITING' && delay?.status === 'PENDING')
      return `Waiting until ${delay.nextAttemptAt.toISOString()}`;
    if (execution.status === 'WAITING') return 'Waiting for the next event';
    if (execution.status === 'QUEUED') return 'Waiting to start';
    return 'Moving through the automation';
  }

  private errorLabel(error: unknown, fallback = 'A step could not be completed'): string {
    const record = this.record(error);
    const code = typeof record.code === 'string' ? record.code : undefined;
    if (!code) return fallback;
    return errorLabels[code] ?? fallback;
  }

  private duration(startedAt: Date | null, endedAt: Date | null): number | null {
    if (!startedAt) return null;
    return Math.max(0, (endedAt ?? new Date()).getTime() - startedAt.getTime());
  }

  private nodeLabel(type: string): string {
    return nodeLabels[type] ?? 'Automation step';
  }

  private record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private startOfDay(value: Date): Date {
    const result = new Date(value);
    result.setUTCHours(0, 0, 0, 0);
    return result;
  }
}
