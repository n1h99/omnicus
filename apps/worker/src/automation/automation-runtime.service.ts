import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  automationValueFor,
  evaluateCondition,
  evaluateConditionGroup,
  externalHttpRequestConfigSchema,
  matchesWaitForReplyCriteria,
  scenarioGraphSchema,
  waitForReplyCriteriaSchema,
  whatsAppAutomationTemplateSchema,
  type ConditionOperator,
  type ScenarioGraph,
  type ScenarioGraphEdge,
  type ScenarioGraphNode,
} from '@omnicus/automation-core';
import { Prisma, type CustomFieldType } from '@omnicus/database';
import {
  assertWhatsAppTemplateComponents,
  whatsAppTemplateDisabledReason,
} from '@omnicus/channel-whatsapp';
import { emailAssetReferences, emailDocumentSchema } from '@omnicus/email-core';
import { renderTemplate } from '@omnicus/media-core';

import { DatabaseService } from '../database/database.service';

export interface AutomationTriggerInput {
  contactId: string;
  connectionId: string;
  conversationId: string;
  normalizedEventId: string;
  projectId: string;
}

type RuntimeTransaction = Prisma.TransactionClient;

interface RuntimeContext extends AutomationTriggerInput {
  contactVariables: Record<string, Prisma.JsonValue>;
  customFields: Prisma.JsonValue;
  eventPayload: Prisma.JsonValue;
  variables: Prisma.JsonValue;
  subflowDepth: number;
}

interface NodeResult {
  next?: ScenarioGraphEdge | undefined;
  operationSafe?: Prisma.InputJsonObject;
  reasonCode?: string;
  suspended?: boolean;
}
type SendMessageDeliveryTarget = 'INCOMING_CONVERSATION' | 'TELEGRAM' | 'WHATSAPP';

const stepBudget = 100;

@Injectable()
export class AutomationRuntimeService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async trigger(input: AutomationTriggerInput): Promise<void> {
    await this.database.client.$transaction((transaction) =>
      this.triggerInTransaction(transaction, input),
    );
  }

  async triggerLeadCapture(eventId: string): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      const event = await transaction.leadCaptureEvent.findUnique({ where: { id: eventId } });
      if (!event || event.status === 'COMPLETED') return;
      const [contact, scenarios] = await Promise.all([
        transaction.contact.findUnique({
          select: {
            automationMode: true,
            customFields: true,
            displayName: true,
            email: true,
            firstName: true,
            lastName: true,
            phone: true,
            username: true,
          },
          where: { projectId_id: { id: event.contactId, projectId: event.projectId } },
        }),
        transaction.scenario.findMany({
          include: { activeVersion: { select: { compiledDefinition: true, id: true } } },
          where: { projectId: event.projectId, status: 'PUBLISHED' },
        }),
      ]);
      if (!contact || contact.automationMode !== 'ENABLED') {
        await transaction.leadCaptureEvent.update({
          data: { processedAt: new Date(), status: 'COMPLETED' },
          where: { id: event.id },
        });
        return;
      }
      const context: RuntimeContext = {
        connectionId: '',
        contactId: event.contactId,
        contactVariables: this.contactVariables(contact),
        conversationId: '',
        customFields: contact.customFields,
        eventPayload: event.payload,
        normalizedEventId: '',
        projectId: event.projectId,
        subflowDepth: 0,
        variables: {},
      };
      for (const scenario of scenarios) {
        const version = scenario.activeVersion;
        if (!version?.compiledDefinition) continue;
        const graph = scenarioGraphSchema.safeParse(version.compiledDefinition);
        if (!graph.success || !this.matchesWebsiteTrigger(graph.data, event.sourceKey)) continue;
        const triggerKey = `lead-capture:${event.id}`;
        const execution = await transaction.scenarioExecution.upsert({
          create: {
            contactId: event.contactId,
            conversationId: null,
            conversationSequence: null,
            correlationId: triggerKey,
            projectId: event.projectId,
            scenarioId: scenario.id,
            scenarioVersionId: version.id,
            startedAt: new Date(),
            status: 'RUNNING',
            triggerEventId: null,
            triggerKey,
            triggerPayload: event.payload as Prisma.InputJsonValue,
            triggerType: 'WEBSITE_REGISTRATION',
          },
          update: {},
          where: {
            projectId_scenarioId_triggerKey: {
              projectId: event.projectId,
              scenarioId: scenario.id,
              triggerKey,
            },
          },
        });
        if (!['COMPLETED', 'CANCELLED', 'FAILED'].includes(execution.status)) {
          await this.executeGraph(transaction, graph.data, execution.id, context);
        }
      }
      await transaction.leadCaptureEvent.update({
        data: {
          lastError: null,
          lockedAt: null,
          lockedBy: null,
          processedAt: new Date(),
          status: 'COMPLETED',
        },
        where: { id: event.id },
      });
    });
  }

  /** Resolves durable waits before normal scenario triggering for the same inbound event. */
  async resolveWaitsInTransaction(
    transaction: RuntimeTransaction,
    input: AutomationTriggerInput,
  ): Promise<boolean> {
    const activeWaits = await transaction.waitState.findMany({
      select: {
        criteria: true,
        id: true,
        projectId: true,
        scenarioExecutionId: true,
        successNodeId: true,
      },
      where: {
        conversationId: input.conversationId,
        projectId: input.projectId,
        status: 'ACTIVE',
      },
    });
    if (!activeWaits.length) return false;
    const event = await transaction.normalizedEvent.findUnique({
      select: { payload: true },
      where: {
        projectId_id: { id: input.normalizedEventId, projectId: input.projectId },
      },
    });
    if (!event) return false;
    let consumed = false;
    for (const wait of activeWaits) {
      if (!matchesWaitForReplyCriteria(wait.criteria, event.payload)) continue;
      const won = await transaction.waitState.updateMany({
        data: {
          resolvedAt: new Date(),
          resolvedByEventId: input.normalizedEventId,
          status: 'RESOLVED',
        },
        where: { id: wait.id, projectId: wait.projectId, status: 'ACTIVE' },
      });
      if (won.count === 1) {
        consumed = true;
        await this.resumeExecutionInTransaction(
          transaction,
          wait.scenarioExecutionId,
          input.projectId,
          wait.successNodeId,
          {
            ...input,
          },
        );
      }
    }
    return consumed;
  }

  async triggerInTransaction(
    transaction: RuntimeTransaction,
    input: AutomationTriggerInput,
  ): Promise<void> {
    const [contact, conversation, event, scenarios] = await Promise.all([
      transaction.contact.findUnique({
        select: {
          automationMode: true,
          customFields: true,
          displayName: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          username: true,
        },
        where: { projectId_id: { id: input.contactId, projectId: input.projectId } },
      }),
      transaction.conversation.findUnique({
        select: { automationModeOverride: true },
        where: { projectId_id: { id: input.conversationId, projectId: input.projectId } },
      }),
      transaction.normalizedEvent.findUnique({
        select: { payload: true },
        where: { projectId_id: { id: input.normalizedEventId, projectId: input.projectId } },
      }),
      transaction.scenario.findMany({
        include: { activeVersion: { select: { compiledDefinition: true, id: true } } },
        where: { projectId: input.projectId, status: 'PUBLISHED' },
      }),
    ]);
    if (!contact || !conversation || !event) return;
    if ((conversation.automationModeOverride ?? contact.automationMode ?? 'ENABLED') !== 'ENABLED')
      return;

    const advanced = await transaction.conversation.update({
      data: { nextAutomationSequence: { increment: 1 } },
      select: { nextAutomationSequence: true },
      where: { projectId_id: { id: input.conversationId, projectId: input.projectId } },
    });
    const context: RuntimeContext = {
      ...input,
      contactVariables: this.contactVariables(contact),
      customFields: contact.customFields,
      eventPayload: event.payload,
      subflowDepth: 0,
      variables: {},
    };
    for (const scenario of scenarios) {
      const version = scenario.activeVersion;
      if (!version?.compiledDefinition) continue;
      const graph = scenarioGraphSchema.safeParse(version.compiledDefinition);
      if (!graph.success) continue;
      if (!this.matchesInboundTrigger(graph.data, event.payload, input.connectionId)) continue;
      const execution = await transaction.scenarioExecution.upsert({
        create: {
          contactId: input.contactId,
          conversationId: input.conversationId,
          conversationSequence: advanced.nextAutomationSequence - BigInt(1),
          correlationId: `normalized-event:${input.normalizedEventId}`,
          projectId: input.projectId,
          scenarioId: scenario.id,
          scenarioVersionId: version.id,
          startedAt: new Date(),
          status: 'RUNNING',
          triggerEventId: input.normalizedEventId,
          triggerKey: input.normalizedEventId,
          triggerPayload: event.payload as Prisma.InputJsonValue,
          triggerType: 'INCOMING_MESSAGE',
        },
        update: {},
        where: {
          projectId_scenarioId_triggerKey: {
            projectId: input.projectId,
            scenarioId: scenario.id,
            triggerKey: input.normalizedEventId,
          },
        },
      });
      if (!['COMPLETED', 'CANCELLED', 'FAILED'].includes(execution.status)) {
        await this.executeGraph(transaction, graph.data, execution.id, context);
      }
    }
  }

  async resumeDelayedAction(actionId: string): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      const action = await transaction.delayedAction.findUnique({ where: { id: actionId } });
      if (!action || action.status !== 'PENDING') return;
      const claimed = await transaction.delayedAction.updateMany({
        data: {
          attempts: { increment: 1 },
          lockedAt: new Date(),
          lockedBy: `automation:${process.pid}`,
          status: 'PROCESSING',
        },
        where: { id: action.id, status: 'PENDING' },
      });
      if (claimed.count !== 1) return;
      try {
        await this.resumeExecutionInTransaction(
          transaction,
          action.scenarioExecutionId,
          action.projectId,
          action.resumeNodeId,
        );
        await transaction.delayedAction.updateMany({
          data: { completedAt: new Date(), lockedAt: null, lockedBy: null, status: 'COMPLETED' },
          where: { id: action.id, lockedBy: `automation:${process.pid}`, status: 'PROCESSING' },
        });
      } catch {
        await transaction.delayedAction.updateMany({
          data: { lockedAt: null, lockedBy: null, status: 'PENDING' },
          where: { id: action.id, lockedBy: `automation:${process.pid}`, status: 'PROCESSING' },
        });
        throw new Error('automation_delay_resume_failed');
      }
    });
  }

  async timeoutWait(waitId: string): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      const wait = await transaction.waitState.findUnique({ where: { id: waitId } });
      if (!wait || wait.status !== 'ACTIVE' || wait.expiresAt > new Date()) return;
      const won = await transaction.waitState.updateMany({
        data: { resolvedAt: new Date(), status: 'TIMED_OUT' },
        where: { id: wait.id, status: 'ACTIVE' },
      });
      if (won.count === 1) {
        await this.resumeExecutionInTransaction(
          transaction,
          wait.scenarioExecutionId,
          wait.projectId,
          wait.timeoutNodeId,
        );
      }
    });
  }

  private async resumeExecutionInTransaction(
    transaction: RuntimeTransaction,
    executionId: string,
    projectId: string,
    startNodeId?: string | null,
    eventOverride?: AutomationTriggerInput,
  ): Promise<void> {
    const execution = await transaction.scenarioExecution.findUnique({
      include: { scenarioVersion: { select: { compiledDefinition: true } } },
      where: { projectId_id: { id: executionId, projectId } },
    });
    if (
      !execution ||
      !execution.scenarioVersion.compiledDefinition ||
      ['COMPLETED', 'FAILED', 'CANCELLED'].includes(execution.status)
    )
      return;
    const graph = scenarioGraphSchema.safeParse(execution.scenarioVersion.compiledDefinition);
    if (!graph.success) throw new Error('automation_graph_invalid');
    const eventId = eventOverride?.normalizedEventId ?? execution.triggerEventId;
    const [contact, event, conversation] = await Promise.all([
      transaction.contact.findUnique({
        where: { projectId_id: { id: execution.contactId, projectId } },
      }),
      eventId
        ? transaction.normalizedEvent.findUnique({
            where: { projectId_id: { id: eventId, projectId } },
          })
        : Promise.resolve(null),
      execution.conversationId
        ? transaction.conversation.findUnique({
            where: { projectId_id: { id: execution.conversationId, projectId } },
          })
        : Promise.resolve(null),
    ]);
    if (!contact || (!event && execution.triggerPayload === null))
      throw new Error('automation_execution_context_missing');
    await transaction.scenarioExecution.update({
      data: { currentNodeId: startNodeId ?? null, status: 'RUNNING' },
      where: { projectId_id: { id: executionId, projectId } },
    });
    await this.executeGraph(
      transaction,
      graph.data,
      executionId,
      {
        connectionId: eventOverride?.connectionId ?? conversation?.connectionId ?? '',
        contactId: execution.contactId,
        contactVariables: this.contactVariables(contact),
        conversationId: execution.conversationId ?? '',
        customFields: contact.customFields,
        eventPayload: event?.payload ?? execution.triggerPayload ?? {},
        normalizedEventId: eventId ?? '',
        projectId,
        subflowDepth: 0,
        variables: execution.variables,
      },
      startNodeId ?? undefined,
    );
  }

  private async executeGraph(
    transaction: RuntimeTransaction,
    graph: ScenarioGraph,
    executionId: string,
    context: RuntimeContext,
    startNodeId?: string,
  ): Promise<void> {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const outgoing = new Map<string, ScenarioGraphEdge[]>();
    for (const edge of graph.edges)
      outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    let node = startNodeId
      ? nodes.get(startNodeId)
      : graph.nodes.find((item) => item.type === 'INCOMING_MESSAGE');
    let steps = 0;
    while (node && steps++ < stepBudget) {
      await transaction.scenarioExecution.update({
        data: { currentNodeId: node.id, status: 'RUNNING' },
        where: { projectId_id: { id: executionId, projectId: context.projectId } },
      });
      await this.nodeExecution(
        transaction,
        executionId,
        context.projectId,
        node,
        'PROCESSING',
        this.safeNodeInput(node, context),
      );
      let result: NodeResult;
      try {
        result = await this.applyNode(
          transaction,
          node,
          outgoing.get(node.id) ?? [],
          context,
          executionId,
        );
      } catch (error) {
        const reasonCode =
          error instanceof Error &&
          [
            'automation_channel_connection_unavailable',
            'automation_channel_identity_unavailable',
            'automation_email_not_eligible',
            'automation_email_template_unavailable',
            'automation_whatsapp_service_window_closed',
          ].includes(error.message)
            ? error.message
            : undefined;
        if (!reasonCode) throw error;
        await this.nodeExecution(
          transaction,
          executionId,
          context.projectId,
          node,
          'FAILED',
          undefined,
          { reasonCode },
        );
        await transaction.scenarioExecution.update({
          data: { completedAt: new Date(), currentNodeId: null, status: 'FAILED' },
          where: { projectId_id: { id: executionId, projectId: context.projectId } },
        });
        return;
      }
      await this.nodeExecution(
        transaction,
        executionId,
        context.projectId,
        node,
        'SUCCEEDED',
        undefined,
        {
          ...(result.next?.output ? { selectedOutput: result.next.output } : {}),
          ...(result.next?.to ? { nextNodeId: result.next.to } : {}),
          ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
          ...(result.operationSafe ?? {}),
          suspended: result.suspended === true,
        },
      );
      if (result.suspended) return;
      node = result.next ? nodes.get(result.next.to) : undefined;
    }
    if (steps >= stepBudget) throw new Error('automation_step_budget_exhausted');
    await transaction.scenarioExecution.update({
      data: { completedAt: new Date(), currentNodeId: null, status: 'COMPLETED' },
      where: { projectId_id: { id: executionId, projectId: context.projectId } },
    });
    await this.resumeParentIfNeeded(transaction, executionId, context.projectId);
  }

  private async applyNode(
    transaction: RuntimeTransaction,
    node: ScenarioGraphNode,
    edges: ScenarioGraphEdge[],
    context: RuntimeContext,
    executionId: string,
  ): Promise<NodeResult> {
    const defaultEdge = edges.find((edge) => edge.output === 'default') ?? edges[0];
    if (node.type === 'STOP') return {};
    if (node.type === 'CONDITION') {
      const config = node.config as {
        field?: string;
        operator?: ConditionOperator;
        value?: unknown;
      };
      const sorted = edges
        .slice()
        .sort(
          (a, b) =>
            (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER),
        );
      const configured = sorted.filter((edge) => edge.condition || edge.conditionGroup);
      const fallback = sorted.find((edge) => !edge.condition && !edge.conditionGroup);
      const matches = (edge: ScenarioGraphEdge) => {
        const valueFor = (field: string) =>
          automationValueFor(
            field,
            context.eventPayload,
            context.customFields,
            context.contactVariables,
            context.variables,
          );
        if (edge.conditionGroup) return evaluateConditionGroup(edge.conditionGroup, valueFor);
        const rule = edge.condition ?? config;
        return evaluateCondition(rule.operator ?? 'exists', valueFor(rule.field ?? ''), rule.value);
      };
      const legacyCondition =
        typeof config.field === 'string' && typeof config.operator === 'string';
      const next =
        configured.length === 0 && legacyCondition
          ? sorted.find(matches)
          : configured.find(matches);
      return {
        next: next ?? (configured.length > 0 || !legacyCondition ? fallback : undefined),
        reasonCode: next
          ? 'CONDITION_MATCHED'
          : (configured.length > 0 || !legacyCondition) && fallback
            ? 'FALLBACK_SELECTED'
            : 'NO_BRANCH_MATCHED',
      };
    }
    if (node.type === 'DELAY') {
      const seconds = node.config.delaySeconds;
      if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds <= 0)
        throw new Error('automation_delay_invalid');
      const execution = await transaction.scenarioExecution.findUniqueOrThrow({
        where: { projectId_id: { id: executionId, projectId: context.projectId } },
      });
      await transaction.delayedAction.upsert({
        create: {
          nextAttemptAt: new Date(Date.now() + seconds * 1_000),
          nodeId: node.id,
          projectId: context.projectId,
          resumeNodeId: defaultEdge?.to ?? null,
          scenarioExecutionId: executionId,
          scenarioId: execution.scenarioId,
          scenarioVersionId: execution.scenarioVersionId,
        },
        update: {},
        where: {
          projectId_scenarioExecutionId_nodeId: {
            nodeId: node.id,
            projectId: context.projectId,
            scenarioExecutionId: executionId,
          },
        },
      });
      await transaction.scenarioExecution.update({
        data: { currentNodeId: node.id, status: 'WAITING' },
        where: { projectId_id: { id: executionId, projectId: context.projectId } },
      });
      return { suspended: true };
    }
    if (node.type === 'WAIT_FOR_REPLY') {
      const seconds = node.config.timeoutSeconds;
      if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds <= 0)
        throw new Error('automation_wait_invalid');
      const execution = await transaction.scenarioExecution.findUniqueOrThrow({
        where: { projectId_id: { id: executionId, projectId: context.projectId } },
      });
      const replyEdge = edges.find((edge) => edge.output === 'reply') ?? defaultEdge;
      const timeoutEdge = edges.find((edge) => edge.output === 'timeout');
      const criteria = waitForReplyCriteriaSchema.safeParse(node.config.criteria ?? {});
      if (!criteria.success) throw new Error('automation_wait_criteria_invalid');
      await transaction.waitState.upsert({
        create: {
          conversationId: context.conversationId,
          criteria: criteria.data as Prisma.InputJsonValue,
          expiresAt: new Date(Date.now() + seconds * 1_000),
          nodeId: node.id,
          projectId: context.projectId,
          scenarioExecutionId: executionId,
          scenarioId: execution.scenarioId,
          scenarioVersionId: execution.scenarioVersionId,
          successNodeId: replyEdge?.to ?? null,
          timeoutNodeId: timeoutEdge?.to ?? null,
        },
        update: {},
        where: {
          projectId_scenarioExecutionId_nodeId: {
            nodeId: node.id,
            projectId: context.projectId,
            scenarioExecutionId: executionId,
          },
        },
      });
      await transaction.scenarioExecution.update({
        data: { currentNodeId: node.id, status: 'WAITING' },
        where: { projectId_id: { id: executionId, projectId: context.projectId } },
      });
      return { suspended: true };
    }
    if (node.type === 'START_SUBFLOW') {
      const scenarioId =
        typeof node.config.scenarioId === 'string' ? node.config.scenarioId : undefined;
      const scenarioVersionId =
        typeof node.config.scenarioVersionId === 'string'
          ? node.config.scenarioVersionId
          : undefined;
      if (!scenarioId || !scenarioVersionId) throw new Error('automation_subflow_invalid');
      if (context.subflowDepth >= 10) throw new Error('automation_subflow_depth_exceeded');
      const target = await transaction.scenario.findUnique({
        where: { projectId_id: { id: scenarioId, projectId: context.projectId } },
      });
      const targetVersion = await transaction.scenarioVersion.findFirst({
        where: {
          id: scenarioVersionId,
          projectId: context.projectId,
          scenarioId,
          status: { in: ['PUBLISHED', 'SUPERSEDED'] },
        },
      });
      if (!target || !targetVersion?.compiledDefinition)
        throw new Error('automation_subflow_unpublished');
      const child = await transaction.scenarioExecution.upsert({
        create: {
          contactId: context.contactId,
          conversationId: context.conversationId,
          conversationSequence: BigInt(0),
          correlationId: `subflow:${executionId}:${node.id}`,
          parentExecutionId: executionId,
          projectId: context.projectId,
          resumeNodeId: defaultEdge?.to ?? null,
          scenarioId: target.id,
          scenarioVersionId: targetVersion.id,
          startedAt: new Date(),
          status: 'RUNNING',
          triggerEventId: context.normalizedEventId || null,
          triggerPayload: context.eventPayload as Prisma.InputJsonValue,
          triggerKey: `subflow:${executionId}:${node.id}`,
        },
        update: {},
        where: {
          projectId_scenarioId_triggerKey: {
            projectId: context.projectId,
            scenarioId: target.id,
            triggerKey: `subflow:${executionId}:${node.id}`,
          },
        },
      });
      const awaitChild = node.config.await !== false;
      if (awaitChild)
        await transaction.scenarioExecution.update({
          data: { currentNodeId: node.id, status: 'WAITING' },
          where: { projectId_id: { id: executionId, projectId: context.projectId } },
        });
      const graph = scenarioGraphSchema.safeParse(targetVersion.compiledDefinition);
      if (!graph.success) throw new Error('automation_subflow_graph_invalid');
      if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(child.status))
        await this.executeGraph(transaction, graph.data, child.id, {
          ...context,
          subflowDepth: context.subflowDepth + 1,
        });
      return awaitChild ? { suspended: true } : { next: defaultEdge };
    }
    if (node.type === 'EXTERNAL_HTTP_REQUEST')
      return this.queueExternalHttpOperation(transaction, node, edges, context, executionId);
    if (node.type === 'SET_CUSTOM_FIELD') {
      const key = typeof node.config.key === 'string' ? node.config.key : undefined;
      if (!key) throw new Error('automation_custom_field_invalid');
      const definition = await transaction.customFieldDefinition.findFirst({
        where: { archivedAt: null, key, projectId: context.projectId },
      });
      if (
        !definition ||
        !this.isCustomFieldValueValid(definition.type, node.config.value, definition.options)
      )
        throw new Error('automation_custom_field_invalid');
      await transaction.contact.update({
        data: {
          customFields: {
            ...this.object(context.customFields),
            [key]: node.config.value as Prisma.JsonValue,
          },
        },
        where: { projectId_id: { id: context.contactId, projectId: context.projectId } },
      });
      await transaction.contactCustomFieldValue.upsert({
        create: {
          contactId: context.contactId,
          definitionId: definition.id,
          projectId: context.projectId,
          valueJson: node.config.value as Prisma.InputJsonValue,
          ...this.customFieldProjections(definition.type, node.config.value),
        },
        update: {
          valueJson: node.config.value as Prisma.InputJsonValue,
          ...this.customFieldProjections(definition.type, node.config.value),
        },
        where: {
          projectId_contactId_definitionId: {
            contactId: context.contactId,
            definitionId: definition.id,
            projectId: context.projectId,
          },
        },
      });
      context.customFields = {
        ...this.object(context.customFields),
        [key]: node.config.value as Prisma.JsonValue,
      };
    }
    if (node.type === 'CLEAR_CUSTOM_FIELD') {
      const key = typeof node.config.key === 'string' ? node.config.key : undefined;
      if (!key) throw new Error('automation_custom_field_invalid');
      const definition = await transaction.customFieldDefinition.findFirst({
        where: { archivedAt: null, key, projectId: context.projectId },
      });
      if (!definition) throw new Error('automation_custom_field_invalid');
      const customFields = { ...this.object(context.customFields) };
      delete customFields[key];
      await transaction.contact.update({
        data: { customFields },
        where: { projectId_id: { id: context.contactId, projectId: context.projectId } },
      });
      await transaction.contactCustomFieldValue.deleteMany({
        where: {
          contactId: context.contactId,
          definitionId: definition.id,
          projectId: context.projectId,
        },
      });
      context.customFields = customFields;
    }
    if (node.type === 'PAUSE_AUTOMATION' || node.type === 'RESUME_AUTOMATION') {
      await transaction.contact.update({
        data: { automationMode: node.type === 'PAUSE_AUTOMATION' ? 'DISABLED' : 'ENABLED' },
        where: { projectId_id: { id: context.contactId, projectId: context.projectId } },
      });
    }
    if (node.type === 'ADD_TAG' || node.type === 'REMOVE_TAG')
      await this.applyTag(transaction, node, context);
    if (node.type === 'SEND_EMAIL')
      return {
        next: defaultEdge,
        operationSafe: await this.queueEmail(transaction, node, context, executionId),
      };
    if (node.type === 'SEND_MESSAGE' || node.type === 'SEND_TEMPLATE')
      return {
        next: defaultEdge,
        operationSafe: await this.queueMessage(transaction, node, context, executionId),
      };
    if (node.type === 'CREATE_OR_UPDATE_LEAD' || node.type === 'FORWARD_TO_CRM')
      await this.queueCrmOperation(transaction, node, context, executionId);
    return { next: defaultEdge };
  }

  async resumeExternalHttpInTransaction(
    transaction: RuntimeTransaction,
    input: {
      mappedVariables: Prisma.InputJsonValue;
      nodeId: string;
      outcome: 'failure' | 'success';
      projectId: string;
      safeOutput: Prisma.InputJsonObject;
      scenarioExecutionId: string;
      startNodeId?: string | null;
    },
  ): Promise<void> {
    const execution = await transaction.scenarioExecution.findUnique({
      where: {
        projectId_id: { id: input.scenarioExecutionId, projectId: input.projectId },
      },
    });
    if (!execution || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(execution.status)) return;
    const variables = this.deepMerge(
      this.object(execution.variables),
      this.object(input.mappedVariables),
    );
    await transaction.scenarioExecution.update({
      data: { variables: variables as Prisma.InputJsonValue },
      where: {
        projectId_id: { id: input.scenarioExecutionId, projectId: input.projectId },
      },
    });
    await transaction.nodeExecution.updateMany({
      data: { completedAt: new Date(), outputSafe: input.safeOutput, status: 'SUCCEEDED' },
      where: {
        nodeId: input.nodeId,
        projectId: input.projectId,
        scenarioExecutionId: input.scenarioExecutionId,
      },
    });
    await this.resumeExecutionInTransaction(
      transaction,
      input.scenarioExecutionId,
      input.projectId,
      input.startNodeId,
    );
  }

  private async queueExternalHttpOperation(
    transaction: RuntimeTransaction,
    node: ScenarioGraphNode,
    edges: ScenarioGraphEdge[],
    context: RuntimeContext,
    executionId: string,
  ): Promise<NodeResult> {
    const config = externalHttpRequestConfigSchema.safeParse(node.config);
    if (!config.success) throw new Error('automation_external_http_invalid');
    const idempotencyKey = `http-${executionId}-${node.id}`;
    const existing = await transaction.outboxRecord.findUnique({
      where: { projectId_idempotencyKey: { idempotencyKey, projectId: context.projectId } },
    });
    if (!existing) {
      const outbox = await transaction.outboxRecord.create({
        data: {
          idempotencyKey,
          kind: 'HTTP',
          maxAttempts: config.data.maxAttempts,
          nextAttemptAt: new Date(),
          payload: {},
          projectId: context.projectId,
        },
      });
      const operation = await transaction.externalHttpOperation.create({
        data: {
          failureNodeId: edges.find((edge) => edge.output === 'failure')?.to ?? null,
          nodeId: node.id,
          outboxRecordId: outbox.id,
          projectId: context.projectId,
          scenarioExecutionId: executionId,
          successNodeId: edges.find((edge) => edge.output === 'success')?.to ?? null,
        },
      });
      await transaction.outboxRecord.update({
        data: { payload: { externalHttpOperationId: operation.id } },
        where: { projectId_id: { id: outbox.id, projectId: context.projectId } },
      });
    }
    await transaction.scenarioExecution.update({
      data: { currentNodeId: node.id, status: 'WAITING' },
      where: { projectId_id: { id: executionId, projectId: context.projectId } },
    });
    return { suspended: true };
  }

  private async resumeParentIfNeeded(
    transaction: RuntimeTransaction,
    executionId: string,
    projectId: string,
  ): Promise<void> {
    const child = await transaction.scenarioExecution.findUnique({
      where: { projectId_id: { id: executionId, projectId } },
    });
    if (!child?.parentExecutionId) return;
    const parent = await transaction.scenarioExecution.findUnique({
      where: { projectId_id: { id: child.parentExecutionId, projectId } },
    });
    if (!parent || parent.status !== 'WAITING') return;
    await this.resumeExecutionInTransaction(transaction, parent.id, projectId, child.resumeNodeId);
  }

  private async applyTag(
    transaction: RuntimeTransaction,
    node: ScenarioGraphNode,
    context: RuntimeContext,
  ): Promise<void> {
    const tagId = typeof node.config.tagId === 'string' ? node.config.tagId : undefined;
    if (!tagId) throw new Error('automation_tag_invalid');
    const tag = await transaction.tag.findFirst({
      select: { id: true },
      where: { archivedAt: null, id: tagId, projectId: context.projectId },
    });
    if (!tag) throw new Error('automation_tag_invalid');
    if (node.type === 'ADD_TAG')
      await transaction.contactTag.createMany({
        data: [
          {
            contactId: context.contactId,
            projectId: context.projectId,
            source: 'automation',
            tagId,
          },
        ],
        skipDuplicates: true,
      });
    else
      await transaction.contactTag.deleteMany({
        where: { contactId: context.contactId, projectId: context.projectId, tagId },
      });
  }

  private async queueCrmOperation(
    transaction: RuntimeTransaction,
    node: ScenarioGraphNode,
    context: RuntimeContext,
    executionId: string,
  ): Promise<void> {
    if (
      node.type === 'FORWARD_TO_CRM' &&
      (await transaction.crmOperation.findFirst({
        select: { id: true },
        where: {
          ...(context.normalizedEventId ? { normalizedEventId: context.normalizedEventId } : {}),
          projectId: context.projectId,
          type: 'FORWARD_INBOUND_MESSAGE',
        },
      }))
    )
      return;
    const idempotencyKey = `crm-${executionId}-${node.id}`;
    if (
      await transaction.outboxRecord.findUnique({
        where: { projectId_idempotencyKey: { idempotencyKey, projectId: context.projectId } },
      })
    )
      return;
    const outbox = await transaction.outboxRecord.create({
      data: { idempotencyKey, kind: 'CRM', payload: {}, projectId: context.projectId },
    });
    const operation = await transaction.crmOperation.create({
      data: {
        contactId: context.contactId,
        inputSafe: { nodeId: node.id, scenarioExecutionId: executionId },
        normalizedEventId: context.normalizedEventId,
        outboxRecordId: outbox.id,
        projectId: context.projectId,
        type:
          node.type === 'CREATE_OR_UPDATE_LEAD'
            ? 'CREATE_OR_UPDATE_LEAD'
            : 'FORWARD_INBOUND_MESSAGE',
      },
    });
    await transaction.outboxRecord.update({
      data: { payload: { crmOperationId: operation.id } },
      where: { projectId_id: { id: outbox.id, projectId: context.projectId } },
    });
  }

  private async queueEmail(
    transaction: RuntimeTransaction,
    node: ScenarioGraphNode,
    context: RuntimeContext,
    executionId: string,
  ): Promise<Prisma.InputJsonObject> {
    const templateId =
      typeof node.config.templateId === 'string' ? node.config.templateId : undefined;
    const templateVersionId =
      typeof node.config.templateVersionId === 'string'
        ? node.config.templateVersionId
        : undefined;
    if (!templateId || !templateVersionId)
      throw new Error('automation_email_template_unavailable');
    const version = await transaction.emailTemplateVersion.findFirst({
      where: {
        id: templateVersionId,
        projectId: context.projectId,
        status: 'PUBLISHED',
        templateId,
        template: { activeVersionId: templateVersionId, status: 'PUBLISHED' },
      },
    });
    if (!version) throw new Error('automation_email_template_unavailable');
    const contact = await transaction.contact.findUnique({
      select: {
        email: true,
        id: true,
        normalizedEmail: true,
      },
      where: { projectId_id: { id: context.contactId, projectId: context.projectId } },
    });
    if (
      !contact?.email || !contact.normalizedEmail
    )
      throw new Error('automation_email_not_eligible');
    const suppression = await transaction.emailSuppression.findUnique({
      where: {
        projectId_normalizedEmail: {
          normalizedEmail: contact.normalizedEmail,
          projectId: context.projectId,
        },
      },
    });
    if (suppression) throw new Error('automation_email_not_eligible');
    const existing = await transaction.emailDelivery.findFirst({
      where: { nodeId: node.id, projectId: context.projectId, scenarioExecutionId: executionId },
    });
    if (existing)
      return {
        emailDeliveryId: existing.id,
        emailTemplateId: templateId,
        emailTemplateVersionId: templateVersionId,
      };
    const design = emailDocumentSchema.parse(version.design);
    const delivery = await transaction.emailDelivery.create({
      data: {
        attachmentAssetIds: JSON.parse(
          JSON.stringify(emailAssetReferences(design).map((reference) => reference.assetId)),
        ) as Prisma.InputJsonValue,
        contactId: contact.id,
        designSnapshot: JSON.parse(JSON.stringify(design)) as Prisma.InputJsonValue,
        nodeId: node.id,
        normalizedEmail: contact.normalizedEmail,
        preheader: version.preheader,
        projectId: context.projectId,
        scenarioExecutionId: executionId,
        source: 'AUTOMATION',
        subject: version.subject,
        templateVersionId: version.id,
        toEmail: contact.email,
      },
    });
    return {
      emailDeliveryId: delivery.id,
      emailTemplateId: templateId,
      emailTemplateVersionId: templateVersionId,
    };
  }

  private async queueMessage(
    transaction: RuntimeTransaction,
    node: ScenarioGraphNode,
    context: RuntimeContext,
    executionId: string,
  ): Promise<Prisma.InputJsonObject> {
    const nodeConfig = this.object(node.config);
    const whatsAppTemplate = whatsAppAutomationTemplateSchema.safeParse(
      node.config.whatsAppTemplate,
    );
    const deliveryTarget =
      node.type === 'SEND_MESSAGE'
        ? this.resolveSendMessageDeliveryTarget(nodeConfig)
        : whatsAppTemplate.success
          ? 'WHATSAPP'
          : 'INCOMING_CONVERSATION';
    const connectionId =
      node.type === 'SEND_MESSAGE' && deliveryTarget !== 'INCOMING_CONVERSATION'
        ? this.sendMessageConnectionId(nodeConfig, deliveryTarget)
        : node.type === 'SEND_TEMPLATE' &&
            whatsAppTemplate.success &&
            typeof nodeConfig.whatsappConnectionId === 'string'
          ? nodeConfig.whatsappConnectionId
          : context.connectionId;
    const connection = await transaction.channelConnection.findUnique({
      select: { id: true, status: true, type: true },
      where: { projectId_id: { id: connectionId, projectId: context.projectId } },
    });
    if (
      !connection ||
      connection.status !== 'ACTIVE' ||
      !['TELEGRAM', 'WHATSAPP'].includes(connection.type)
    )
      throw new Error('automation_channel_connection_unavailable');
    if (
      node.type === 'SEND_MESSAGE' &&
      ((deliveryTarget === 'TELEGRAM' && connection.type !== 'TELEGRAM') ||
        (deliveryTarget === 'WHATSAPP' && connection.type !== 'WHATSAPP'))
    )
      throw new Error('automation_channel_connection_unavailable');
    const channelType = connection.type === 'WHATSAPP' ? 'WHATSAPP' : 'TELEGRAM';
    if (channelType === 'WHATSAPP' && node.type === 'SEND_TEMPLATE' && !whatsAppTemplate.success)
      throw new Error('automation_whatsapp_template_invalid');
    if (channelType === 'TELEGRAM' && whatsAppTemplate.success)
      throw new Error('automation_template_channel_mismatch');
    const templateVersionId =
      channelType === 'TELEGRAM' && typeof node.config.templateVersionId === 'string'
        ? node.config.templateVersionId
        : undefined;
    const templateVersion = templateVersionId
      ? await transaction.messageTemplateVersion.findFirst({
          where: {
            id: templateVersionId,
            projectId: context.projectId,
            status: { in: ['PUBLISHED', 'SUPERSEDED'] },
            ...(typeof node.config.templateId === 'string'
              ? { templateId: node.config.templateId }
              : {}),
          },
        })
      : undefined;
    const templateContent = templateVersion?.content as
      | {
          caption?: string;
          inlineKeyboard?: Array<Array<{ callbackData?: string; text: string; url?: string }>>;
          text?: string;
        }
      | undefined;
    const sourceText =
      channelType === 'WHATSAPP' && whatsAppTemplate.success
        ? undefined
        : templateVersion?.kind === 'TEXT'
          ? templateContent?.text
          : templateVersion
            ? (templateContent?.caption ?? '')
            : typeof node.config.text === 'string'
              ? node.config.text
              : undefined;
    const configuredMediaAssetId =
      node.type === 'SEND_MESSAGE' && typeof nodeConfig.mediaAssetId === 'string'
        ? nodeConfig.mediaAssetId
        : undefined;
    const configuredMediaAsset = configuredMediaAssetId
      ? await transaction.mediaAsset.findFirst({
          where: { id: configuredMediaAssetId, projectId: context.projectId, status: 'AVAILABLE' },
        })
      : undefined;
    if (configuredMediaAssetId && !configuredMediaAsset)
      throw new Error('automation_media_asset_unavailable');
    const configuredMediaValidationChannel = configuredMediaAsset
      ? this.object(configuredMediaAsset.providerMetadata)?.validationChannel
      : undefined;
    const configuredMediaChannel =
      configuredMediaValidationChannel === 'telegram'
        ? 'TELEGRAM'
        : configuredMediaValidationChannel === 'whatsapp'
          ? 'WHATSAPP'
          : configuredMediaAsset?.source === 'TELEGRAM' ||
              configuredMediaAsset?.source === 'WHATSAPP'
            ? configuredMediaAsset.source
            : undefined;
    if (configuredMediaChannel && configuredMediaChannel !== channelType)
      throw new Error('automation_media_channel_mismatch');
    if (
      !whatsAppTemplate.success &&
      !configuredMediaAsset &&
      (sourceText === undefined || sourceText.trim().length === 0)
    )
      throw new Error('automation_message_content_missing');
    const variables = {
      ...this.object(context.variables),
      contact: context.contactVariables,
      event: context.eventPayload,
      nodes: this.object(context.variables).nodes,
      variables: context.variables,
    };
    const rendered = sourceText === undefined ? undefined : renderTemplate(sourceText, variables);
    if (rendered?.missing.length) throw new Error('automation_template_variable_missing');
    const renderedText =
      rendered && nodeConfig.trackLinks === true
        ? await this.rewriteTrackedLinks(
            transaction,
            rendered.output,
            context,
            executionId,
            node.id,
            typeof nodeConfig.trackingBaseUrl === 'string' ? nodeConfig.trackingBaseUrl : '',
          )
        : rendered?.output;
    let renderedWhatsAppTemplate: Prisma.InputJsonObject | undefined;
    if (whatsAppTemplate.success) {
      const components = whatsAppTemplate.data.components?.map((component) => ({
        ...component,
        parameters: component.parameters.map((parameter) => {
          if (parameter.type === 'text') {
            const value = renderTemplate(parameter.text, variables);
            if (value.missing.length) throw new Error('automation_template_variable_missing');
            return { ...parameter, text: value.output };
          }
          return parameter;
        }),
      }));
      const approved = await transaction.whatsAppMessageTemplate.findUnique({
        where: {
          projectId_connectionId_name_languageCode: {
            connectionId,
            languageCode: whatsAppTemplate.data.languageCode,
            name: whatsAppTemplate.data.name,
            projectId: context.projectId,
          },
        },
      });
      if (!approved || approved.status !== 'APPROVED')
        throw new Error('automation_whatsapp_template_not_approved');
      if (whatsAppTemplateDisabledReason(approved))
        throw new Error('automation_whatsapp_template_unsupported');
      try {
        assertWhatsAppTemplateComponents(approved.components, components);
      } catch {
        throw new Error('automation_whatsapp_template_components_invalid');
      }
      renderedWhatsAppTemplate = {
        ...(components ? { components: components as Prisma.InputJsonValue[] } : {}),
        languageCode: approved.languageCode,
        name: approved.name,
      };
    }
    const whatsAppRoute =
      channelType === 'WHATSAPP' &&
      whatsAppTemplate.success &&
      (typeof nodeConfig.whatsappConnectionId === 'string' || !context.conversationId)
        ? await this.whatsAppTemplateRoute(transaction, context, connectionId, executionId, node.id)
        : undefined;
    if (whatsAppRoute) {
      context.connectionId = connectionId;
      context.conversationId = whatsAppRoute.conversationId;
      await transaction.scenarioExecution.updateMany({
        data: { conversationId: whatsAppRoute.conversationId },
        where: { id: executionId, projectId: context.projectId },
      });
    }
    const identity =
      whatsAppRoute?.identity ??
      (await transaction.channelIdentity.findFirst({
        where: {
          channel: channelType,
          connectionId,
          contactId: context.contactId,
          projectId: context.projectId,
          status: 'ACTIVE',
        },
      }));
    if (!identity) throw new Error('automation_channel_identity_unavailable');
    const conversationId = whatsAppRoute?.conversationId ?? context.conversationId;
    if (channelType === 'WHATSAPP' && !renderedWhatsAppTemplate) {
      if (Array.isArray(nodeConfig.telegramButtons) && nodeConfig.telegramButtons.length)
        throw new Error('automation_whatsapp_buttons_require_template');
      const conversation = await transaction.conversation.findUnique({
        select: { serviceWindowExpiresAt: true },
        where: {
          projectId_id: { id: conversationId, projectId: context.projectId },
        },
      });
      if (
        !conversation?.serviceWindowExpiresAt ||
        conversation.serviceWindowExpiresAt <= new Date()
      )
        throw new Error('automation_whatsapp_service_window_closed');
    }
    if (
      channelType !== 'WHATSAPP' &&
      Array.isArray(nodeConfig.whatsappButtons) &&
      nodeConfig.whatsappButtons.length
    )
      throw new Error('automation_whatsapp_buttons_channel_mismatch');
    let renderedWhatsAppInteractive: Prisma.InputJsonObject | undefined;
    if (
      channelType === 'WHATSAPP' &&
      node.type === 'SEND_MESSAGE' &&
      Array.isArray(nodeConfig.whatsappButtons) &&
      nodeConfig.whatsappButtons.length > 0
    ) {
      if (nodeConfig.whatsappButtons.length > 3)
        throw new Error('automation_whatsapp_buttons_invalid');
      if (configuredMediaAsset) throw new Error('automation_whatsapp_interactive_media_conflict');
      if (!renderedText?.trim() || renderedText.length > 1_024)
        throw new Error('automation_whatsapp_interactive_body_invalid');
      const ids = new Set<string>();
      const buttons = nodeConfig.whatsappButtons.map((candidate) => {
        const button = this.object(candidate);
        const id = typeof button.id === 'string' ? button.id : '';
        const title = typeof button.title === 'string' ? button.title : '';
        if (
          id.length < 1 ||
          id.length > 256 ||
          id.trim() !== id ||
          title.length < 1 ||
          title.length > 20 ||
          title.trim() !== title ||
          ids.has(id)
        )
          throw new Error('automation_whatsapp_buttons_invalid');
        ids.add(id);
        return { id, title };
      });
      renderedWhatsAppInteractive = {
        action: { buttons },
        body: { text: renderedText },
        type: 'button',
      };
    }
    const telegramButtons =
      channelType === 'TELEGRAM'
        ? await this.telegramButtons(transaction, nodeConfig, context, executionId, node.id)
        : undefined;
    const idempotencyKey = `automation-${executionId}-${node.id}`;
    const existing = await transaction.outboxRecord.findUnique({
      where: { projectId_idempotencyKey: { idempotencyKey, projectId: context.projectId } },
    });
    if (existing) {
      const payload = this.object(existing.payload);
      return {
        deliveryStatus: 'QUEUED',
        ...(typeof payload.messageId === 'string' ? { messageId: payload.messageId } : {}),
        outboxRecordId: existing.id,
      };
    }
    const message = await transaction.message.create({
      data: {
        connectionId,
        contactId: context.contactId,
        content: renderedWhatsAppTemplate
          ? { whatsAppTemplate: renderedWhatsAppTemplate }
          : renderedWhatsAppInteractive
            ? { interactive: renderedWhatsAppInteractive }
            : templateVersion && templateVersion.kind !== 'TEXT'
              ? { caption: renderedText ?? '' }
              : configuredMediaAsset
                ? { caption: renderedText ?? '' }
                : { text: renderedText! },
        conversationId,
        direction: 'OUTBOUND',
        mediaAssetId: templateVersion?.mediaAssetId ?? configuredMediaAsset?.id ?? null,
        metadata: {
          source: 'automation',
          scenarioExecutionId: executionId,
          ...(templateContent?.inlineKeyboard
            ? { inlineKeyboard: templateContent.inlineKeyboard }
            : {}),
          ...(telegramButtons?.length ? { inlineKeyboard: telegramButtons } : {}),
          ...(templateVersion
            ? {
                templateId: templateVersion.templateId,
                templateVersionId: templateVersion.id,
              }
            : {}),
        },
        projectId: context.projectId,
        status: 'QUEUED',
        type: renderedWhatsAppTemplate
          ? 'TEXT'
          : renderedWhatsAppInteractive
            ? 'INTERACTIVE'
            : (templateVersion?.kind ?? configuredMediaAsset?.kind ?? 'TEXT'),
      },
    });
    const outbox = await transaction.outboxRecord.create({
      data: {
        connectionId,
        idempotencyKey,
        kind: channelType,
        nextAttemptAt: new Date(),
        payload: { channelIdentityId: identity.id, messageId: message.id },
        projectId: context.projectId,
      },
    });
    return {
      deliveryStatus: 'QUEUED',
      messageId: message.id,
      outboxRecordId: outbox.id,
    };
  }

  private matchesWebsiteTrigger(graph: ScenarioGraph, sourceKey: string): boolean {
    const trigger = graph.nodes.find((node) => node.type === 'INCOMING_MESSAGE');
    const config = this.object(trigger?.config);
    return (
      config.triggerType === 'WEBSITE_REGISTRATION' &&
      typeof config.sourceKey === 'string' &&
      config.sourceKey.trim().toLowerCase() === sourceKey
    );
  }

  private matchesInboundTrigger(
    graph: ScenarioGraph,
    payload: Prisma.JsonValue,
    connectionId: string,
  ): boolean {
    const trigger = graph.nodes.find((node) => node.type === 'INCOMING_MESSAGE');
    const config = this.object(trigger?.config);
    const triggerType =
      typeof config.triggerType === 'string' ? config.triggerType : 'INCOMING_MESSAGE';
    if (triggerType === 'WEBSITE_REGISTRATION') return false;
    const event = this.object(payload);
    const content = this.object(event.content);
    const args = Array.isArray(content.arguments) ? content.arguments : [];
    if (triggerType !== 'TELEGRAM_DEEP_LINK') {
      return !(content.command === 'start' && args.length > 0);
    }
    if (typeof config.connectionId === 'string' && config.connectionId !== connectionId)
      return false;
    return (
      content.command === 'start' &&
      typeof config.startPayload === 'string' &&
      args[0] === config.startPayload
    );
  }

  private async rewriteTrackedLinks(
    transaction: RuntimeTransaction,
    text: string,
    context: RuntimeContext,
    executionId: string,
    nodeId: string,
    baseUrl: string,
  ): Promise<string> {
    if (!baseUrl) throw new Error('automation_tracking_base_url_missing');
    const normalizedBaseUrl = new URL(baseUrl).toString().replace(/\/$/, '');
    const matches = [...new Set(text.match(/https?:\/\/[^\s<>"']+/g) ?? [])];
    let output = text;
    for (const rawTarget of matches) {
      const punctuation = rawTarget.match(/[),.!?;:]+$/)?.[0] ?? '';
      const targetUrl = punctuation ? rawTarget.slice(0, -punctuation.length) : rawTarget;
      const existing = await transaction.trackedLink.findFirst({
        where: {
          nodeId,
          projectId: context.projectId,
          scenarioExecutionId: executionId,
          targetUrl,
        },
      });
      const link =
        existing ??
        (await transaction.trackedLink.create({
          data: {
            contactId: context.contactId,
            nodeId,
            projectId: context.projectId,
            scenarioExecutionId: executionId,
            targetUrl,
            token: randomBytes(18).toString('base64url'),
          },
        }));
      output = output.split(rawTarget).join(`${normalizedBaseUrl}/r/${link.token}${punctuation}`);
    }
    return output;
  }

  private async telegramButtons(
    transaction: RuntimeTransaction,
    config: Record<string, Prisma.JsonValue>,
    context: RuntimeContext,
    executionId: string,
    nodeId: string,
  ): Promise<Array<Array<{ text: string; url: string }>> | undefined> {
    if (!Array.isArray(config.telegramButtons)) return undefined;
    const rows: Array<Array<{ text: string; url: string }>> = [];
    for (const rawButton of config.telegramButtons.slice(0, 8)) {
      const button = this.object(rawButton);
      if (typeof button.text !== 'string' || typeof button.url !== 'string')
        throw new Error('automation_telegram_button_invalid');
      const url = new URL(button.url);
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('automation_telegram_button_invalid');
      const renderedUrl =
        config.trackLinks === true
          ? await this.rewriteTrackedLinks(
              transaction,
              url.toString(),
              context,
              executionId,
              nodeId,
              typeof config.trackingBaseUrl === 'string' ? config.trackingBaseUrl : '',
            )
          : url.toString();
      rows.push([{ text: button.text.slice(0, 64), url: renderedUrl }]);
    }
    return rows;
  }

  private resolveSendMessageDeliveryTarget(
    config: Record<string, Prisma.JsonValue>,
  ): SendMessageDeliveryTarget {
    const target = typeof config.deliveryTarget === 'string' ? config.deliveryTarget : undefined;
    if (!target || target === 'INCOMING_CONVERSATION') return 'INCOMING_CONVERSATION';
    if (target === 'TELEGRAM' || target === 'WHATSAPP') return target;
    throw new Error('automation_send_message_delivery_target_invalid');
  }

  private sendMessageConnectionId(
    config: Record<string, Prisma.JsonValue>,
    deliveryTarget: SendMessageDeliveryTarget,
  ): string {
    const telegramConnectionId =
      deliveryTarget === 'TELEGRAM' && typeof config.telegramConnectionId === 'string'
        ? config.telegramConnectionId
        : undefined;
    const whatsappConnectionId =
      deliveryTarget === 'WHATSAPP' && typeof config.whatsappConnectionId === 'string'
        ? config.whatsappConnectionId
        : undefined;
    const connectionId =
      deliveryTarget === 'TELEGRAM' ? telegramConnectionId : whatsappConnectionId;
    if (!connectionId) throw new Error('automation_channel_connection_unavailable');
    return connectionId;
  }

  private async whatsAppTemplateRoute(
    transaction: RuntimeTransaction,
    context: RuntimeContext,
    connectionId: string,
    executionId: string,
    nodeId: string,
  ) {
    const contact = await transaction.contact.findUnique({
      select: {
        normalizedPhone: true,
        phone: true,
        whatsAppConsentStatus: true,
      },
      where: { projectId_id: { id: context.contactId, projectId: context.projectId } },
    });
    if (!contact) throw new Error('automation_contact_unavailable');
    const existingForContact = await transaction.channelIdentity.findFirst({
      orderBy: { createdAt: 'desc' },
      where: {
        channel: 'WHATSAPP',
        connectionId,
        contactId: context.contactId,
        projectId: context.projectId,
        status: 'ACTIVE',
      },
    });
    const normalizedPhone =
      contact.normalizedPhone ??
      contact.phone?.replace(/\D/g, '') ??
      existingForContact?.externalUserId;
    if (!normalizedPhone || normalizedPhone.length < 5)
      throw new Error('automation_whatsapp_recipient_phone_missing');
    if (!context.conversationId && contact.whatsAppConsentStatus !== 'GRANTED')
      throw new Error('automation_whatsapp_marketing_consent_required');
    const existingIdentity = await transaction.channelIdentity.findUnique({
      where: {
        projectId_connectionId_externalUserId: {
          connectionId,
          externalUserId: normalizedPhone,
          projectId: context.projectId,
        },
      },
    });
    if (existingIdentity && existingIdentity.contactId !== context.contactId)
      throw new Error('automation_whatsapp_identity_conflict');
    if (existingIdentity?.whatsAppReachability === 'BLOCKED')
      throw new Error('automation_whatsapp_recipient_blocked');
    let identity = existingIdentity;
    if (!identity) {
      identity = await transaction.channelIdentity.create({
        data: {
          channel: 'WHATSAPP',
          connectionId,
          contactId: context.contactId,
          externalUserId: normalizedPhone,
          metadata: { source: 'website_registration_automation' },
          projectId: context.projectId,
          status: 'ACTIVE',
          whatsAppReachability: 'PENDING',
          whatsAppReachabilityCheckedAt: new Date(),
        },
      });
      await this.queueCrmWhatsAppIdentitySync(
        transaction,
        context,
        connectionId,
        executionId,
        nodeId,
      );
    }
    if (identity.status !== 'ACTIVE') throw new Error('automation_channel_identity_unavailable');
    const existingConversation = await transaction.conversation.findUnique({
      where: {
        projectId_connectionId_externalChatId: {
          connectionId,
          externalChatId: normalizedPhone,
          projectId: context.projectId,
        },
      },
    });
    if (existingConversation && existingConversation.contactId !== context.contactId)
      throw new Error('automation_whatsapp_conversation_conflict');
    const conversation =
      existingConversation ??
      (await transaction.conversation.create({
        data: {
          connectionId,
          contactId: context.contactId,
          externalChatId: normalizedPhone,
          projectId: context.projectId,
          status: 'ACTIVE',
        },
      }));
    return { conversationId: conversation.id, identity };
  }

  private async queueCrmWhatsAppIdentitySync(
    transaction: RuntimeTransaction,
    context: RuntimeContext,
    connectionId: string,
    executionId: string,
    nodeId: string,
  ): Promise<void> {
    const crm = await transaction.crmProjectConfig.findUnique({
      select: { enabled: true, status: true },
      where: { projectId: context.projectId },
    });
    if (!crm?.enabled || crm.status !== 'ACTIVE') return;
    const idempotencyKey = `crm-whatsapp-identity-${executionId}-${nodeId}`;
    await transaction.outboxRecord.createMany({
      data: [
        {
          idempotencyKey,
          kind: 'CRM',
          payload: {},
          projectId: context.projectId,
        },
      ],
      skipDuplicates: true,
    });
    const outbox = await transaction.outboxRecord.findUnique({
      include: { crmOperation: { select: { id: true } } },
      where: {
        projectId_idempotencyKey: { idempotencyKey, projectId: context.projectId },
      },
    });
    if (!outbox || outbox.crmOperation) return;
    const operation = await transaction.crmOperation.create({
      data: {
        contactId: context.contactId,
        inputSafe: { connectionId, source: 'whatsapp_identity_bootstrap' },
        outboxRecordId: outbox.id,
        projectId: context.projectId,
        type: 'CREATE_OR_UPDATE_LEAD',
      },
    });
    await transaction.outboxRecord.update({
      data: { payload: { crmOperationId: operation.id } },
      where: { projectId_id: { id: outbox.id, projectId: context.projectId } },
    });
  }

  private async nodeExecution(
    transaction: RuntimeTransaction,
    executionId: string,
    projectId: string,
    node: ScenarioGraphNode,
    status: 'FAILED' | 'PROCESSING' | 'SUCCEEDED',
    inputSafe?: Prisma.InputJsonObject,
    outputSafe?: Prisma.InputJsonObject,
  ): Promise<void> {
    const idempotencyKey = createHash('sha256').update(`${executionId}:${node.id}:1`).digest('hex');
    await transaction.nodeExecution.upsert({
      create: {
        attempt: 1,
        completedAt: status === 'PROCESSING' ? null : new Date(),
        idempotencyKey,
        inputSafe: inputSafe ?? {},
        nodeId: node.id,
        nodeType: node.type,
        projectId,
        scenarioExecutionId: executionId,
        startedAt: new Date(),
        status,
        ...(status === 'PROCESSING' ? {} : { outputSafe: outputSafe ?? {} }),
      },
      update:
        status !== 'PROCESSING'
          ? { completedAt: new Date(), outputSafe: outputSafe ?? {}, status }
          : {},
      where: { projectId_idempotencyKey: { idempotencyKey, projectId } },
    });
  }

  private safeNodeInput(node: ScenarioGraphNode, context: RuntimeContext): Prisma.InputJsonObject {
    const payload = this.object(context.eventPayload);
    const eventType = typeof payload.type === 'string' ? payload.type : 'UNKNOWN';
    if (node.type === 'DELAY')
      return { delaySeconds: node.config.delaySeconds as number, eventType };
    if (node.type === 'WAIT_FOR_REPLY') {
      const criteria = waitForReplyCriteriaSchema.safeParse(node.config.criteria ?? {});
      return {
        criteriaKind: criteria.success ? criteria.data.kind : 'INVALID',
        eventType,
        timeoutSeconds: node.config.timeoutSeconds as number,
      };
    }
    if (node.type === 'CONDITION')
      return {
        eventType,
        field: typeof node.config.field === 'string' ? node.config.field : 'branch-defined',
        operator:
          typeof node.config.operator === 'string' ? node.config.operator : 'branch-defined',
      };
    if (node.type === 'EXTERNAL_HTTP_REQUEST') {
      const config = externalHttpRequestConfigSchema.safeParse(node.config);
      return {
        eventType,
        mappingCount: config.success ? config.data.mappings.length : 0,
        method: config.success ? config.data.method : 'INVALID',
        timeoutMs: config.success ? config.data.timeoutMs : 0,
      };
    }
    return { eventType };
  }

  private deepMerge(
    current: Record<string, Prisma.JsonValue>,
    incoming: Record<string, Prisma.JsonValue>,
  ): Record<string, Prisma.JsonValue> {
    const output = { ...current };
    for (const [key, value] of Object.entries(incoming)) {
      const existing = output[key];
      output[key] =
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        existing &&
        typeof existing === 'object' &&
        !Array.isArray(existing)
          ? this.deepMerge(
              existing as Record<string, Prisma.JsonValue>,
              value as Record<string, Prisma.JsonValue>,
            )
          : value;
    }
    return output;
  }

  private object(value: unknown): Record<string, Prisma.JsonValue> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, Prisma.JsonValue>)
      : {};
  }

  private customFieldProjections(type: CustomFieldType, value: unknown) {
    if (value === null)
      return { valueBoolean: null, valueDateTime: null, valueNumber: null, valueText: null };
    if (type === 'NUMBER')
      return {
        valueBoolean: null,
        valueDateTime: null,
        valueNumber: new Prisma.Decimal(value as number),
        valueText: null,
      };
    if (type === 'BOOLEAN')
      return {
        valueBoolean: value as boolean,
        valueDateTime: null,
        valueNumber: null,
        valueText: null,
      };
    return {
      valueBoolean: null,
      valueDateTime: null,
      valueNumber: null,
      valueText: typeof value === 'string' ? value : null,
    };
  }

  private isCustomFieldValueValid(
    type: CustomFieldType,
    value: unknown,
    options: Prisma.JsonValue | null,
  ): boolean {
    if (value === null) return true;
    if (type === 'TEXT') return typeof value === 'string';
    if (type === 'NUMBER') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'BOOLEAN') return typeof value === 'boolean';
    if (type === 'DATE') return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    if (type === 'DATETIME') return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    if (type === 'JSON') return typeof value === 'object';
    const allowed = Array.isArray(options) ? options : [];
    return type === 'SELECT'
      ? typeof value === 'string' && allowed.includes(value)
      : Array.isArray(value) &&
          value.every((entry) => typeof entry === 'string' && allowed.includes(entry));
  }

  private contactVariables(contact: {
    customFields: Prisma.JsonValue;
    displayName: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    username: string | null;
  }): Record<string, Prisma.JsonValue> {
    return {
      customFields: contact.customFields,
      displayName: contact.displayName,
      email: contact.email,
      firstName: contact.firstName,
      lastName: contact.lastName,
      phone: contact.phone,
      username: contact.username,
    };
  }
}
