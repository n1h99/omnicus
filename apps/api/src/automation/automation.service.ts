import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  externalHttpRequestConfigSchema,
  scenarioGraphSchema,
  simulateScenarioGraph,
  validateScenarioGraph,
  whatsAppAutomationTemplateSchema,
} from '@omnicus/automation-core';
import {
  assertWhatsAppTemplateComponents,
  whatsAppTemplateDisabledReason,
} from '@omnicus/channel-whatsapp';
import type { CustomFieldType, Prisma } from '@omnicus/database';

import type { AuthenticatedUser } from '../auth/auth.types';
import type { RequestSecurityContext } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import type {
  CreateScenarioDto,
  DuplicateScenarioDto,
  TestScenarioDto,
  UpdateScenarioDto,
} from './dto';

@Injectable()
export class AutomationService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async list(projectId: string) {
    return this.database.client.scenario.findMany({
      orderBy: { updatedAt: 'desc' },
      select: {
        activeVersionId: true,
        createdAt: true,
        description: true,
        id: true,
        name: true,
        status: true,
        updatedAt: true,
      },
      where: { projectId, status: { not: 'ARCHIVED' } },
    });
  }

  async get(projectId: string, scenarioId: string) {
    const scenario = await this.database.client.scenario.findUnique({
      include: {
        activeVersion: true,
        draftVersion: true,
        versions: {
          orderBy: { version: 'desc' },
          select: {
            createdAt: true,
            graph: true,
            id: true,
            publishedAt: true,
            status: true,
            validation: true,
            version: true,
          },
        },
      },
      where: { projectId_id: { id: scenarioId, projectId } },
    });
    if (!scenario)
      throw new NotFoundException({
        code: 'SCENARIO_NOT_FOUND',
        message: 'Scenario was not found',
      });
    return scenario;
  }

  async executions(projectId: string, scenarioId: string) {
    await this.get(projectId, scenarioId);
    const executions = await this.database.client.scenarioExecution.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        completedAt: true,
        createdAt: true,
        currentNodeId: true,
        failedAt: true,
        id: true,
        scenarioVersionId: true,
        status: true,
        triggerEventId: true,
        nodeExecutions: {
          orderBy: { startedAt: 'asc' },
          select: {
            attempt: true,
            completedAt: true,
            errorSafe: true,
            inputSafe: true,
            nodeId: true,
            nodeType: true,
            outputSafe: true,
            startedAt: true,
            status: true,
          },
        },
      },
      take: 100,
      where: { projectId, scenarioId },
    });
    const operationReferences = executions.flatMap((execution) =>
      execution.nodeExecutions.flatMap((node) => {
        const output = this.record(node.outputSafe);
        return typeof output.outboxRecordId === 'string' && typeof output.messageId === 'string'
          ? [{ messageId: output.messageId, outboxRecordId: output.outboxRecordId }]
          : [];
      }),
    );
    const [messages, outboxes] = await Promise.all([
      operationReferences.length
        ? this.database.client.message.findMany({
            select: { id: true, status: true },
            where: {
              id: { in: operationReferences.map((item) => item.messageId) },
              projectId,
            },
          })
        : [],
      operationReferences.length
        ? this.database.client.outboxRecord.findMany({
            select: { id: true, status: true },
            where: {
              id: { in: operationReferences.map((item) => item.outboxRecordId) },
              projectId,
            },
          })
        : [],
    ]);
    const messageStatuses = new Map(messages.map((message) => [message.id, message.status]));
    const outboxStatuses = new Map(outboxes.map((outbox) => [outbox.id, outbox.status]));
    return executions.map((execution) => ({
      ...execution,
      nodeExecutions: execution.nodeExecutions.map((node) => {
        const output = this.record(node.outputSafe);
        if (typeof output.outboxRecordId !== 'string' || typeof output.messageId !== 'string')
          return node;
        return {
          ...node,
          delivery: {
            messageId: output.messageId,
            messageStatus: messageStatuses.get(output.messageId) ?? 'UNKNOWN',
            outboxRecordId: output.outboxRecordId,
            outboxStatus: outboxStatuses.get(output.outboxRecordId) ?? 'UNKNOWN',
          },
        };
      }),
    }));
  }

  async testRun(projectId: string, dto: TestScenarioDto, sourceScenarioId = 'new') {
    this.assertValidGraph(dto.graph);
    await this.assertReferencedResources(projectId, dto.graph);
    await this.assertPinnedTemplates(projectId, dto.graph);
    await this.assertPinnedSubflows(projectId, sourceScenarioId, dto.graph);
    await this.assertAutomationSecrets(projectId, dto.graph);
    return simulateScenarioGraph(dto.graph, {
      ...(dto.contact ? { contact: dto.contact } : {}),
      ...(dto.customFields ? { customFields: dto.customFields } : {}),
      ...(dto.event ? { event: dto.event } : {}),
      ...(dto.httpOutcome ? { httpOutcome: dto.httpOutcome } : {}),
      ...(dto.waitOutcome ? { waitOutcome: dto.waitOutcome } : {}),
    });
  }

  async replayExecution(
    projectId: string,
    scenarioId: string,
    executionId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const execution = await this.database.client.scenarioExecution.findFirst({
      include: {
        contact: true,
        scenarioVersion: { select: { compiledDefinition: true } },
        triggerEvent: { select: { payload: true } },
      },
      where: { id: executionId, projectId, scenarioId },
    });
    if (!execution?.scenarioVersion.compiledDefinition)
      throw new NotFoundException({
        code: 'SCENARIO_EXECUTION_NOT_FOUND',
        message: 'Scenario execution was not found',
      });
    const result = simulateScenarioGraph(execution.scenarioVersion.compiledDefinition, {
      contact: {
        displayName: execution.contact.displayName,
        email: execution.contact.email,
        firstName: execution.contact.firstName,
        lastName: execution.contact.lastName,
        phone: execution.contact.phone,
        username: execution.contact.username,
      },
      customFields: this.record(execution.contact.customFields),
      event: this.record(execution.triggerEvent?.payload ?? execution.triggerPayload ?? {}),
    });
    await this.audit.record({
      action: 'scenario.execution_test_replayed',
      actorUserId: actor.userId,
      correlationId: context.correlationId,
      entityId: executionId,
      entityType: 'ScenarioExecution',
      projectId,
      afterSafeJson: { completed: result.completed, stepCount: result.steps.length },
    });
    return result;
  }

  async create(
    projectId: string,
    dto: CreateScenarioDto,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const validation = this.validateDraftGraph(dto.graph);
    return this.database.client.$transaction(async (transaction) => {
      const scenario = await transaction.scenario.create({
        data: { description: dto.description ?? null, name: dto.name, projectId },
      });
      const draft = await transaction.scenarioVersion.create({
        data: {
          contentHash: this.hash(dto.graph),
          graph: this.toJson(dto.graph),
          projectId,
          scenarioId: scenario.id,
          validation: this.toJson(validation),
          version: 1,
        },
      });
      const created = await transaction.scenario.update({
        data: { draftVersionId: draft.id },
        where: { projectId_id: { id: scenario.id, projectId } },
      });
      await this.audit.record({
        action: 'scenario.created',
        actorUserId: actor.userId,
        correlationId: context.correlationId,
        entityId: created.id,
        entityType: 'Scenario',
        projectId,
        afterSafeJson: { name: created.name, version: 1 },
      });
      return created;
    });
  }

  async update(
    projectId: string,
    scenarioId: string,
    dto: UpdateScenarioDto,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const scenario = await this.get(projectId, scenarioId);
    const graph =
      dto.graph ?? (scenario.draftVersion?.graph as Record<string, unknown> | undefined);
    if (!graph)
      throw new BadRequestException({
        code: 'SCENARIO_DRAFT_REQUIRED',
        message: 'A scenario draft is required',
      });
    const validation = this.validateDraftGraph(graph);
    return this.database.client.$transaction(async (transaction) => {
      let draftId = scenario.draftVersionId;
      if (!draftId) {
        const latest = await transaction.scenarioVersion.aggregate({
          _max: { version: true },
          where: { projectId, scenarioId },
        });
        const draft = await transaction.scenarioVersion.create({
          data: {
            contentHash: this.hash(graph),
            graph: this.toJson(graph),
            projectId,
            scenarioId,
            validation: this.toJson(validation),
            version: (latest._max.version ?? 0) + 1,
          },
        });
        draftId = draft.id;
      } else {
        await transaction.scenarioVersion.update({
          data: {
            contentHash: this.hash(graph),
            graph: this.toJson(graph),
            validation: this.toJson(validation),
          },
          where: { projectId_id: { id: draftId, projectId } },
        });
      }
      const data = {
        ...(dto.description === undefined ? {} : { description: dto.description }),
        ...(dto.name === undefined ? {} : { name: dto.name }),
        draftVersionId: draftId,
      };
      if (dto.expectedUpdatedAt) {
        const result = await transaction.scenario.updateMany({
          data,
          where: { id: scenarioId, projectId, updatedAt: new Date(dto.expectedUpdatedAt) },
        });
        if (result.count !== 1)
          throw new ConflictException({
            code: 'SCENARIO_DRAFT_CONFLICT',
            message: 'Scenario draft changed in another editor session',
          });
      } else {
        await transaction.scenario.update({
          data,
          where: { projectId_id: { id: scenarioId, projectId } },
        });
      }
      const updated = await transaction.scenario.findUniqueOrThrow({
        where: { projectId_id: { id: scenarioId, projectId } },
      });
      await this.audit.record({
        action: 'scenario.updated',
        actorUserId: actor.userId,
        correlationId: context.correlationId,
        entityId: scenarioId,
        entityType: 'Scenario',
        projectId,
        afterSafeJson: { draftVersionId: draftId },
      });
      return updated;
    });
  }

  async publish(
    projectId: string,
    scenarioId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const scenario = await this.get(projectId, scenarioId);
    if (!scenario.draftVersion)
      throw new BadRequestException({
        code: 'SCENARIO_DRAFT_REQUIRED',
        message: 'A scenario draft is required',
      });
    const draftVersion = scenario.draftVersion;
    const validation = this.assertValidGraph(draftVersion.graph);
    await this.assertReferencedResources(projectId, draftVersion.graph);
    await this.assertPinnedTemplates(projectId, draftVersion.graph);
    await this.assertPinnedSubflows(projectId, scenarioId, draftVersion.graph);
    await this.assertAutomationSecrets(projectId, draftVersion.graph);
    return this.database.client.$transaction(async (transaction) => {
      if (scenario.activeVersionId)
        await transaction.scenarioVersion.update({
          data: { status: 'SUPERSEDED' },
          where: { projectId_id: { id: scenario.activeVersionId, projectId } },
        });
      await transaction.scenarioVersion.update({
        data: {
          compiledDefinition: this.compiledDefinition(draftVersion.graph),
          publishedAt: new Date(),
          status: 'PUBLISHED',
          validation: this.toJson(validation),
        },
        where: { projectId_id: { id: draftVersion.id, projectId } },
      });
      const published = await transaction.scenario.update({
        data: {
          activeVersionId: draftVersion.id,
          draftVersionId: null,
          status: 'PUBLISHED',
        },
        where: { projectId_id: { id: scenarioId, projectId } },
      });
      await this.audit.record({
        action: 'scenario.published',
        actorUserId: actor.userId,
        correlationId: context.correlationId,
        entityId: scenarioId,
        entityType: 'Scenario',
        projectId,
        afterSafeJson: { activeVersionId: draftVersion.id },
      });
      return published;
    });
  }

  async setStatus(
    projectId: string,
    scenarioId: string,
    status: 'PAUSED' | 'PUBLISHED',
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const scenario = await this.get(projectId, scenarioId);
    if (status === 'PUBLISHED' && !scenario.activeVersionId)
      throw new BadRequestException({
        code: 'SCENARIO_ACTIVE_VERSION_REQUIRED',
        message: 'An active version is required',
      });
    const updated = await this.database.client.scenario.update({
      data: { status },
      where: { projectId_id: { id: scenarioId, projectId } },
    });
    await this.audit.record({
      action: status === 'PAUSED' ? 'scenario.paused' : 'scenario.resumed',
      actorUserId: actor.userId,
      correlationId: context.correlationId,
      entityId: scenarioId,
      entityType: 'Scenario',
      projectId,
      afterSafeJson: { status },
    });
    return updated;
  }

  async archive(
    projectId: string,
    scenarioId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    await this.get(projectId, scenarioId);
    const archived = await this.database.client.scenario.update({
      data: { status: 'ARCHIVED' },
      where: { projectId_id: { id: scenarioId, projectId } },
    });
    await this.audit.record({
      action: 'scenario.archived',
      actorUserId: actor.userId,
      correlationId: context.correlationId,
      entityId: scenarioId,
      entityType: 'Scenario',
      projectId,
      afterSafeJson: { status: archived.status },
    });
    return archived;
  }

  async duplicate(
    projectId: string,
    scenarioId: string,
    dto: DuplicateScenarioDto,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    const source = await this.get(projectId, scenarioId);
    const sourceVersion = source.draftVersion ?? source.activeVersion;
    if (!sourceVersion)
      throw new BadRequestException({
        code: 'SCENARIO_VERSION_REQUIRED',
        message: 'Scenario has no version',
      });
    return this.database.client.$transaction(async (transaction) => {
      const scenario = await transaction.scenario.create({
        data: { description: source.description, name: dto.name, projectId },
      });
      const graph = sourceVersion.graph as Prisma.InputJsonValue;
      const draft = await transaction.scenarioVersion.create({
        data: {
          contentHash: this.hash(graph),
          graph,
          projectId,
          scenarioId: scenario.id,
          validation: sourceVersion.validation as Prisma.InputJsonValue,
          version: 1,
        },
      });
      const duplicated = await transaction.scenario.update({
        data: { draftVersionId: draft.id },
        where: { projectId_id: { id: scenario.id, projectId } },
      });
      await this.audit.record({
        action: 'scenario.duplicated',
        actorUserId: actor.userId,
        correlationId: context.correlationId,
        entityId: duplicated.id,
        entityType: 'Scenario',
        projectId,
        afterSafeJson: { sourceScenarioId: scenarioId },
      });
      return duplicated;
    });
  }

  async restoreVersion(
    projectId: string,
    scenarioId: string,
    versionId: string,
    actor: AuthenticatedUser,
    context: RequestSecurityContext,
  ) {
    await this.get(projectId, scenarioId);
    const source = await this.database.client.scenarioVersion.findFirst({
      where: { id: versionId, projectId, scenarioId },
    });
    if (!source)
      throw new NotFoundException({
        code: 'SCENARIO_VERSION_NOT_FOUND',
        message: 'Scenario version was not found',
      });
    return this.update(
      projectId,
      scenarioId,
      { graph: source.graph as Record<string, unknown> },
      actor,
      context,
    );
  }

  private assertValidGraph(graph: unknown) {
    const validation = validateScenarioGraph(graph);
    if (validation.errors.length)
      throw new BadRequestException({
        code: 'SCENARIO_GRAPH_INVALID',
        message: 'Scenario graph is invalid',
      });
    return validation;
  }

  private validateDraftGraph(graph: unknown) {
    const parsed = scenarioGraphSchema.safeParse(graph);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'SCENARIO_GRAPH_SCHEMA_INVALID',
        message: 'Scenario graph structure is invalid',
      });
    return validateScenarioGraph(parsed.data);
  }

  private async assertPinnedTemplates(projectId: string, graph: unknown): Promise<void> {
    const parsed = scenarioGraphSchema.safeParse(graph);
    if (!parsed.success) return;
    for (const node of parsed.data.nodes.filter(
      (candidate) => candidate.type === 'SEND_TEMPLATE',
    )) {
      const whatsAppTemplate = whatsAppAutomationTemplateSchema.safeParse(
        node.config.whatsAppTemplate,
      );
      if (whatsAppTemplate.success) {
        const candidates = await this.database.client.whatsAppMessageTemplate.findMany({
          where: {
            languageCode: whatsAppTemplate.data.languageCode,
            name: whatsAppTemplate.data.name,
            projectId,
            status: 'APPROVED',
          },
        });
        const sendable = candidates.some((template) => {
          if (whatsAppTemplateDisabledReason(template)) return false;
          try {
            assertWhatsAppTemplateComponents(template.components, whatsAppTemplate.data.components);
            return true;
          } catch {
            return false;
          }
        });
        if (!sendable)
          throw new BadRequestException({
            code: 'SCENARIO_WHATSAPP_TEMPLATE_INVALID',
            message: 'Scenario references an unavailable or unsupported WhatsApp template',
          });
        continue;
      }
      const templateId = node.config.templateId;
      const templateVersionId = node.config.templateVersionId;
      if (typeof templateId !== 'string' || typeof templateVersionId !== 'string') continue;
      const version = await this.database.client.messageTemplateVersion.findFirst({
        where: {
          id: templateVersionId,
          projectId,
          status: 'PUBLISHED',
          templateId,
          template: { status: 'PUBLISHED' },
        },
      });
      if (!version)
        throw new BadRequestException({
          code: 'SCENARIO_TEMPLATE_VERSION_INVALID',
          message: 'Scenario references an unavailable template version',
        });
    }
  }

  private async assertAutomationSecrets(projectId: string, graph: unknown): Promise<void> {
    const parsed = scenarioGraphSchema.safeParse(graph);
    if (!parsed.success) return;
    const secretIds = new Set(
      parsed.data.nodes
        .filter((node) => node.type === 'EXTERNAL_HTTP_REQUEST')
        .flatMap((node) => {
          const config = externalHttpRequestConfigSchema.safeParse(node.config);
          return config.success
            ? config.data.headers.flatMap((header) => (header.secretId ? [header.secretId] : []))
            : [];
        }),
    );
    if (!secretIds.size) return;
    const available = await this.database.client.automationSecret.count({
      where: { archivedAt: null, id: { in: [...secretIds] }, projectId },
    });
    if (available !== secretIds.size)
      throw new BadRequestException({
        code: 'SCENARIO_AUTOMATION_SECRET_INVALID',
        message: 'Scenario references a missing automation secret',
      });
  }

  private async assertReferencedResources(projectId: string, graph: unknown): Promise<void> {
    const parsed = scenarioGraphSchema.safeParse(graph);
    if (!parsed.success) return;
    const tagIds = new Set(
      parsed.data.nodes
        .filter((node) => node.type === 'ADD_TAG' || node.type === 'REMOVE_TAG')
        .map((node) => node.config.tagId)
        .filter((tagId): tagId is string => typeof tagId === 'string'),
    );
    if (tagIds.size) {
      const tags = await this.database.client.tag.findMany({
        select: { id: true },
        where: { archivedAt: null, id: { in: [...tagIds] }, projectId },
      });
      if (tags.length !== tagIds.size)
        throw new BadRequestException({
          code: 'SCENARIO_TAG_INVALID',
          message: 'Scenario references an unavailable project tag',
        });
    }
    const fieldPaths = [
      ...parsed.data.nodes.map((node) =>
        node.type === 'SET_CUSTOM_FIELD' || node.type === 'CLEAR_CUSTOM_FIELD'
          ? node.config.key
          : node.type === 'CONDITION'
            ? node.config.field
            : undefined,
      ),
      ...parsed.data.edges.map((edge) => edge.condition?.field),
      ...parsed.data.edges.flatMap((edge) =>
        edge.conditionGroup ? edge.conditionGroup.rules.map((rule) => rule.field) : [],
      ),
    ];
    const fieldKeys = new Set(
      fieldPaths
        .filter((field): field is string => typeof field === 'string')
        .map((field) =>
          field.startsWith('contact.customFields.')
            ? field.slice('contact.customFields.'.length)
            : field,
        )
        .filter((field) => !field.includes('.')),
    );
    if (!fieldKeys.size) return;
    const fields = await this.database.client.customFieldDefinition.findMany({
      select: { key: true, options: true, type: true },
      where: { archivedAt: null, key: { in: [...fieldKeys] }, projectId },
    });
    if (fields.length !== fieldKeys.size)
      throw new BadRequestException({
        code: 'SCENARIO_CUSTOM_FIELD_INVALID',
        message: 'Scenario references an unavailable project custom field',
      });
    const definitions = new Map(fields.map((field) => [field.key, field]));
    for (const node of parsed.data.nodes.filter(
      (candidate) => candidate.type === 'SET_CUSTOM_FIELD',
    )) {
      const key = typeof node.config.key === 'string' ? node.config.key : undefined;
      const definition = key ? definitions.get(key) : undefined;
      if (
        !definition ||
        !this.isCustomFieldValueValid(definition.type, node.config.value, definition.options)
      )
        throw new BadRequestException({
          code: 'SCENARIO_CUSTOM_FIELD_VALUE_INVALID',
          message: 'Scenario custom-field value does not match its active definition',
        });
    }
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
    if (type === 'JSON') return value !== null && typeof value === 'object';
    const allowed = Array.isArray(options) ? options : [];
    return type === 'SELECT'
      ? typeof value === 'string' && allowed.includes(value)
      : Array.isArray(value) &&
          value.every((entry) => typeof entry === 'string' && allowed.includes(entry));
  }

  private async assertPinnedSubflows(
    projectId: string,
    sourceScenarioId: string,
    graph: unknown,
  ): Promise<void> {
    const parsed = scenarioGraphSchema.safeParse(graph);
    if (!parsed.success) return;
    for (const node of parsed.data.nodes.filter(
      (candidate) => candidate.type === 'START_SUBFLOW',
    )) {
      const scenarioId = node.config.scenarioId;
      const scenarioVersionId = node.config.scenarioVersionId;
      if (typeof scenarioId !== 'string' || typeof scenarioVersionId !== 'string') continue;
      if (scenarioId === sourceScenarioId)
        throw new BadRequestException({
          code: 'SCENARIO_SUBFLOW_SELF_REFERENCE',
          message: 'A scenario cannot start itself as a subflow',
        });
      const version = await this.database.client.scenarioVersion.findFirst({
        where: {
          id: scenarioVersionId,
          projectId,
          scenarioId,
          status: 'PUBLISHED',
        },
      });
      if (!version)
        throw new BadRequestException({
          code: 'SCENARIO_SUBFLOW_VERSION_INVALID',
          message: 'Scenario references an unavailable subflow version',
        });
    }
  }

  private hash(graph: unknown): string {
    return createHash('sha256').update(JSON.stringify(graph)).digest('hex');
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private compiledDefinition(value: unknown): Prisma.InputJsonValue {
    const graph = JSON.parse(JSON.stringify(value)) as {
      nodes?: Array<{ config?: Record<string, unknown>; type?: string }>;
    };
    const publicUrl = process.env.API_PUBLIC_URL?.trim().replace(/\/$/, '');
    if (publicUrl) {
      for (const node of graph.nodes ?? []) {
        if (node.type === 'SEND_MESSAGE' && node.config?.trackLinks === true) {
          node.config.trackingBaseUrl = publicUrl;
        }
      }
    }
    return graph as Prisma.InputJsonValue;
  }

  private record(value: Prisma.JsonValue): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
}
