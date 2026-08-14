import { z } from 'zod';

export const automationNodeTypes = [
  'INCOMING_MESSAGE',
  'CONDITION',
  'ADD_TAG',
  'REMOVE_TAG',
  'SEND_MESSAGE',
  'SEND_TEMPLATE',
  'SEND_EMAIL',
  'CREATE_OR_UPDATE_LEAD',
  'FORWARD_TO_CRM',
  'SET_CUSTOM_FIELD',
  'CLEAR_CUSTOM_FIELD',
  'DELAY',
  'WAIT_FOR_REPLY',
  'START_SUBFLOW',
  'EXTERNAL_HTTP_REQUEST',
  'PAUSE_AUTOMATION',
  'RESUME_AUTOMATION',
  'STOP',
] as const;

export type AutomationNodeType = (typeof automationNodeTypes)[number];

export const sendEmailAutomationConfigSchema = z.object({
  templateId: z.string().uuid(),
  templateVersionId: z.string().uuid(),
});

export const conditionOperators = [
  'equals',
  'not_equals',
  'contains',
  'starts_with',
  'ends_with',
  'greater_than',
  'greater_or_equal',
  'less_than',
  'less_or_equal',
  'exists',
  'not_exists',
] as const;

export type ConditionOperator = (typeof conditionOperators)[number];

export const waitReplyMediaTypes = [
  'PHOTO',
  'DOCUMENT',
  'VIDEO',
  'AUDIO',
  'VOICE',
  'VIDEO_NOTE',
  'ANIMATION',
  'STICKER',
] as const;

const waitTextOperatorSchema = z.enum(['equals', 'contains', 'starts_with', 'ends_with']);

const waitCriteriaContractSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ANY') }),
  z.object({
    caseSensitive: z.boolean().default(false),
    kind: z.literal('TEXT'),
    operator: waitTextOperatorSchema,
    value: z.string().min(1).max(4_096),
  }),
  z.object({
    caseSensitive: z.boolean().default(true),
    kind: z.literal('CALLBACK'),
    operator: waitTextOperatorSchema,
    value: z.string().min(1).max(64),
  }),
  z.object({
    kind: z.literal('MEDIA'),
    mediaTypes: z.array(z.enum(waitReplyMediaTypes)).min(1),
  }),
]);

export const waitForReplyCriteriaSchema = z.preprocess(
  (input) =>
    input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 0
      ? { kind: 'ANY' }
      : input,
  waitCriteriaContractSchema,
);

export type WaitForReplyCriteria = z.infer<typeof waitForReplyCriteriaSchema>;

export const conditionRuleSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(conditionOperators),
  value: z.unknown().optional(),
});

export const conditionGroupSchema = z.object({
  combinator: z.enum(['AND', 'OR']),
  rules: z.array(conditionRuleSchema).min(1).max(20),
});

export type ConditionRule = z.infer<typeof conditionRuleSchema>;
export type ConditionGroup = z.infer<typeof conditionGroupSchema>;

export const externalHttpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export const externalHttpContentTypes = [
  'application/json',
  'application/x-www-form-urlencoded',
  'text/plain',
] as const;
export const externalHttpValueTypes = ['string', 'number', 'boolean', 'json'] as const;

const externalHttpTemplateSchema = z.string().max(65_536);
const dangerousPathSegments = new Set(['__proto__', 'constructor', 'prototype']);
const reservedExternalHttpMappingRoots = new Set([
  'contact',
  'conversation',
  'message',
  'nodes',
  'project',
  'trigger',
  'variables',
]);
const externalHttpNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.-]+$/);

export const externalHttpRequestConfigSchema = z
  .object({
    body: z.unknown().optional(),
    contentType: z.enum(externalHttpContentTypes).default('application/json'),
    headers: z
      .array(
        z
          .object({
            name: externalHttpNameSchema,
            secretId: z.string().min(1).optional(),
            value: externalHttpTemplateSchema.optional(),
          })
          .refine((header) => Boolean(header.secretId) !== (header.value !== undefined), {
            message: 'Header requires exactly one value or secretId',
          }),
      )
      .max(20)
      .default([]),
    mappings: z
      .array(
        z.object({
          defaultValue: z.unknown().optional(),
          required: z.boolean().default(false),
          sourcePath: z
            .string()
            .min(1)
            .max(256)
            .regex(/^response\.(?:status|data(?:\.[A-Za-z][A-Za-z0-9_]*)*)$/)
            .refine((path) => path.split('.').every((part) => !dangerousPathSegments.has(part))),
          targetPath: z
            .string()
            .min(1)
            .max(256)
            .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/)
            .refine(
              (path) =>
                path.split('.').every((part) => !dangerousPathSegments.has(part)) &&
                !reservedExternalHttpMappingRoots.has(path.split('.')[0]!),
            ),
          type: z.enum(externalHttpValueTypes).default('json'),
        }),
      )
      .max(20)
      .default([]),
    maxAttempts: z.number().int().min(1).max(5).default(1),
    method: z.enum(externalHttpMethods).default('GET'),
    query: z
      .array(z.object({ name: externalHttpNameSchema, value: externalHttpTemplateSchema }))
      .max(20)
      .default([]),
    successStatusMaximum: z.number().int().min(100).max(599).default(299),
    successStatusMinimum: z.number().int().min(100).max(599).default(200),
    timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
    url: z
      .string()
      .min(1)
      .max(2_048)
      .regex(/^https:\/\//i),
  })
  .superRefine((config, context) => {
    if (config.body !== undefined && JSON.stringify(config.body).length > 65_536)
      context.addIssue({ code: 'custom', message: 'External HTTP body is too large' });
  });

export type ExternalHttpRequestConfig = z.infer<typeof externalHttpRequestConfigSchema>;

export const graphNodeSchema = z.object({
  config: z.record(z.string(), z.unknown()).default({}),
  id: z.string().min(1),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  type: z.enum(automationNodeTypes),
});

const whatsAppTemplateTextParameterSchema = z
  .object({ text: z.string().min(1).max(4_096), type: z.literal('text') })
  .strict();
const whatsAppTemplateCurrencyParameterSchema = z
  .object({
    amount1000: z.number().int(),
    code: z.string().regex(/^[A-Z]{3}$/),
    fallbackValue: z.string().min(1).max(128),
    type: z.literal('currency'),
  })
  .strict();
const whatsAppTemplateDateTimeParameterSchema = z
  .object({ fallbackValue: z.string().min(1).max(128), type: z.literal('date_time') })
  .strict();
const whatsAppTemplateMediaParameterSchema = z
  .object({
    mediaAssetId: z.string().min(1).max(128),
    type: z.enum(['document', 'image', 'video']),
  })
  .strict();
const whatsAppTemplatePayloadParameterSchema = z
  .object({ payload: z.string().min(1).max(1_024), type: z.literal('payload') })
  .strict();

const whatsAppBodyParameterSchema = z.discriminatedUnion('type', [
  whatsAppTemplateTextParameterSchema,
  whatsAppTemplateCurrencyParameterSchema,
  whatsAppTemplateDateTimeParameterSchema,
]);

const whatsAppHeaderParameterSchema = z.discriminatedUnion('type', [
  whatsAppTemplateTextParameterSchema,
  whatsAppTemplateMediaParameterSchema,
]);

const whatsAppTemplateComponentSchema = z.union([
  z
    .object({
      parameters: z.array(whatsAppBodyParameterSchema).max(64),
      type: z.literal('body'),
    })
    .strict(),
  z
    .object({
      parameters: z.array(whatsAppHeaderParameterSchema).max(64),
      type: z.literal('header'),
    })
    .strict(),
  z
    .object({
      index: z.number().int().min(0).max(9),
      parameters: z.tuple([whatsAppTemplatePayloadParameterSchema]),
      subType: z.literal('quick_reply'),
      type: z.literal('button'),
    })
    .strict(),
  z
    .object({
      index: z.number().int().min(0).max(9),
      parameters: z.tuple([whatsAppTemplateTextParameterSchema]),
      subType: z.literal('url'),
      type: z.literal('button'),
    })
    .strict(),
]);

export const whatsAppAutomationTemplateSchema = z
  .object({
    components: z.array(whatsAppTemplateComponentSchema).max(64).optional(),
    languageCode: z.string().trim().min(1).max(32),
    name: z.string().trim().min(1).max(512),
  })
  .strict();

export const graphEdgeSchema = z.object({
  condition: conditionRuleSchema.optional(),
  conditionGroup: conditionGroupSchema.optional(),
  from: z.string().min(1),
  output: z.string().min(1).default('default'),
  priority: z.number().int().nonnegative().optional(),
  to: z.string().min(1),
});

export const scenarioGraphSchema = z.object({
  edges: z.array(graphEdgeSchema),
  nodes: z.array(graphNodeSchema).min(1),
});

export type ScenarioGraph = z.infer<typeof scenarioGraphSchema>;
export type ScenarioGraphNode = z.infer<typeof graphNodeSchema>;
export type ScenarioGraphEdge = z.infer<typeof graphEdgeSchema>;

export interface GraphValidationResult {
  errors: string[];
  warnings: string[];
}

const branchingNodes = new Set<AutomationNodeType>(['CONDITION']);
const continuationNodes = new Set<AutomationNodeType>(['DELAY', 'WAIT_FOR_REPLY']);
const sendMessageDeliveryTargets = ['INCOMING_CONVERSATION', 'TELEGRAM', 'WHATSAPP'] as const;
type SendMessageDeliveryTarget = (typeof sendMessageDeliveryTargets)[number];

export function validateScenarioGraph(input: unknown): GraphValidationResult {
  const parsed = scenarioGraphSchema.safeParse(input);
  if (!parsed.success) {
    return { errors: parsed.error.issues.map((issue) => issue.message), warnings: [] };
  }
  const graph = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, ScenarioGraphEdge[]>();
  for (const edge of graph.edges) {
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) {
      errors.push(`Edge ${edge.from}:${edge.output}->${edge.to} references an unknown node`);
      continue;
    }
    const rules = edge.conditionGroup?.rules ?? (edge.condition ? [edge.condition] : []);
    for (const rule of rules)
      if (
        rule.operator !== 'exists' &&
        rule.operator !== 'not_exists' &&
        rule.value === undefined
      ) {
        errors.push(`Edge ${edge.from}:${edge.output}->${edge.to} requires a comparison value`);
      }
    if (edge.condition && edge.conditionGroup)
      errors.push(
        `Edge ${edge.from}:${edge.output}->${edge.to} cannot define two condition formats`,
      );
    const edges = outgoing.get(edge.from) ?? [];
    edges.push(edge);
    outgoing.set(edge.from, edges);
  }

  const triggers = graph.nodes.filter((node) => node.type === 'INCOMING_MESSAGE');
  if (triggers.length !== 1) {
    errors.push('A scenario must contain exactly one Incoming Message trigger');
  }
  for (const trigger of triggers) {
    if (!outgoing.get(trigger.id)?.length) {
      errors.push('Incoming Message trigger must have an outgoing path');
    }
  }
  for (const node of graph.nodes) {
    const edges = outgoing.get(node.id) ?? [];
    const ports = new Map<string, ScenarioGraphEdge[]>();
    for (const edge of edges) {
      const portEdges = ports.get(edge.output) ?? [];
      portEdges.push(edge);
      ports.set(edge.output, portEdges);
    }
    for (const [port, portEdges] of ports) {
      if (!branchingNodes.has(node.type) && portEdges.length > 1) {
        errors.push(`Node ${node.id} output ${port} has multiple active connections`);
      }
    }
    if (node.type === 'CONDITION') {
      const priorities = edges.map((edge) => edge.priority);
      if (priorities.some((priority) => priority === undefined)) {
        errors.push(`Condition node ${node.id} requires an explicit branch priority`);
      }
      if (new Set(priorities).size !== priorities.length) {
        errors.push(`Condition node ${node.id} has duplicate branch priorities`);
      }
      const configuredBranches = edges.filter((edge) => edge.condition || edge.conditionGroup);
      if (
        configuredBranches.length > 0 &&
        edges.filter((edge) => !edge.condition && !edge.conditionGroup).length > 1
      ) {
        errors.push(`Condition node ${node.id} has multiple fallback branches`);
      }
    }
    if (node.type === 'DELAY') {
      const delaySeconds = node.config.delaySeconds;
      if (
        !Number.isInteger(delaySeconds) ||
        typeof delaySeconds !== 'number' ||
        delaySeconds <= 0
      ) {
        errors.push(`Delay node ${node.id} requires a positive integer delaySeconds`);
      }
    }
    if (node.type === 'WAIT_FOR_REPLY') {
      const timeoutSeconds = node.config.timeoutSeconds;
      if (
        !Number.isInteger(timeoutSeconds) ||
        typeof timeoutSeconds !== 'number' ||
        timeoutSeconds <= 0
      ) {
        errors.push(`Wait for Reply node ${node.id} requires a positive integer timeoutSeconds`);
      }
      const criteria = waitForReplyCriteriaSchema.safeParse(node.config.criteria ?? {});
      if (!criteria.success) {
        errors.push(`Wait for Reply node ${node.id} has invalid reply criteria`);
      }
    }
    if (
      (node.type === 'ADD_TAG' || node.type === 'REMOVE_TAG') &&
      (typeof node.config.tagId !== 'string' || node.config.tagId.length === 0)
    ) {
      errors.push(
        `${node.type === 'ADD_TAG' ? 'Add Tag' : 'Remove Tag'} node ${node.id} requires a tag`,
      );
    }
    if (
      (node.type === 'SET_CUSTOM_FIELD' || node.type === 'CLEAR_CUSTOM_FIELD') &&
      (typeof node.config.key !== 'string' || node.config.key.length === 0)
    ) {
      errors.push(
        `${node.type === 'SET_CUSTOM_FIELD' ? 'Set' : 'Clear'} Custom Field node ${node.id} requires a custom field`,
      );
    }
    if (
      node.type === 'START_SUBFLOW' &&
      (typeof node.config.scenarioId !== 'string' ||
        typeof node.config.scenarioVersionId !== 'string')
    ) {
      errors.push(`Subflow node ${node.id} requires a pinned published scenario version`);
    }
    if (node.type === 'SEND_TEMPLATE') {
      const whatsAppTemplate = whatsAppAutomationTemplateSchema.safeParse(
        node.config.whatsAppTemplate,
      );
      const telegramTemplate =
        typeof node.config.templateId === 'string' &&
        typeof node.config.templateVersionId === 'string';
      if (!telegramTemplate && !whatsAppTemplate.success)
        errors.push(
          `Send Template node ${node.id} requires a pinned template version or a WhatsApp template`,
        );
      if (telegramTemplate && node.config.whatsAppTemplate !== undefined)
        errors.push(`Send Template node ${node.id} cannot mix Telegram and WhatsApp templates`);
    }
    if (
      node.type === 'SEND_EMAIL' &&
      !sendEmailAutomationConfigSchema.safeParse(node.config).success
    )
      errors.push(`Send Email node ${node.id} requires a pinned published email template`);
    if (
      node.type === 'SEND_MESSAGE' &&
      (typeof node.config.text !== 'string' || node.config.text.trim().length === 0) &&
      !isNonEmptyString(node.config.mediaAssetId)
    ) {
      errors.push(`Send Message node ${node.id} requires message text`);
    }
    if (node.type === 'SEND_MESSAGE') {
      const deliveryTarget =
        typeof node.config.deliveryTarget === 'string'
          ? (node.config.deliveryTarget as SendMessageDeliveryTarget)
          : 'INCOMING_CONVERSATION';
      if (!sendMessageDeliveryTargets.includes(deliveryTarget)) {
        errors.push(`Send Message node ${node.id} has an unsupported delivery target`);
      }
      if (deliveryTarget === 'TELEGRAM' && !isNonEmptyString(node.config.telegramConnectionId)) {
        errors.push(`Send Message node ${node.id} requires a Telegram connection`);
      }
      if (deliveryTarget === 'WHATSAPP' && !isNonEmptyString(node.config.whatsappConnectionId)) {
        errors.push(`Send Message node ${node.id} requires a WhatsApp connection`);
      }
      if (
        deliveryTarget !== 'TELEGRAM' &&
        Array.isArray(node.config.telegramButtons) &&
        node.config.telegramButtons.length > 0
      ) {
        errors.push(`Send Message node ${node.id} can use URL buttons only with Telegram`);
      }
      if (Array.isArray(node.config.telegramButtons)) {
        for (const button of node.config.telegramButtons) {
          if (
            !button ||
            typeof button !== 'object' ||
            !isNonEmptyString((button as Record<string, unknown>).text) ||
            !isNonEmptyString((button as Record<string, unknown>).url)
          ) {
            errors.push(`Send Message node ${node.id} has an incomplete Telegram URL button`);
            break;
          }
        }
      }
      const whatsAppButtons = Array.isArray(node.config.whatsappButtons)
        ? node.config.whatsappButtons
        : [];
      if (
        node.config.whatsappButtons !== undefined &&
        !Array.isArray(node.config.whatsappButtons)
      ) {
        errors.push(`Send Message node ${node.id} has invalid WhatsApp reply buttons`);
      }
      if (deliveryTarget !== 'WHATSAPP' && whatsAppButtons.length > 0) {
        errors.push(
          `Send Message node ${node.id} can use WhatsApp reply buttons only with WhatsApp`,
        );
      }
      if (whatsAppButtons.length > 3) {
        errors.push(`Send Message node ${node.id} can use at most 3 WhatsApp reply buttons`);
      }
      if (whatsAppButtons.length > 0) {
        if (isNonEmptyString(node.config.mediaAssetId)) {
          errors.push(
            `Send Message node ${node.id} cannot combine an attachment with WhatsApp reply buttons`,
          );
        }
        if (!isNonEmptyString(node.config.text)) {
          errors.push(
            `Send Message node ${node.id} requires message text with WhatsApp reply buttons`,
          );
        } else if ((node.config.text as string).length > 1_024) {
          errors.push(
            `Send Message node ${node.id} text cannot exceed 1024 characters with WhatsApp reply buttons`,
          );
        }
        const buttonIds = new Set<string>();
        for (const button of whatsAppButtons) {
          const value =
            button && typeof button === 'object' ? (button as Record<string, unknown>) : undefined;
          const id = value?.id;
          const title = value?.title;
          if (
            typeof id !== 'string' ||
            id.length < 1 ||
            id.length > 256 ||
            id.trim() !== id ||
            typeof title !== 'string' ||
            title.length < 1 ||
            title.length > 20 ||
            title.trim() !== title
          ) {
            errors.push(`Send Message node ${node.id} has an incomplete WhatsApp reply button`);
            break;
          }
          if (buttonIds.has(id)) {
            errors.push(`Send Message node ${node.id} has duplicate WhatsApp reply values`);
            break;
          }
          buttonIds.add(id);
        }
      }
    }
    if (node.type === 'INCOMING_MESSAGE') {
      const triggerType =
        typeof node.config.triggerType === 'string' ? node.config.triggerType : 'INCOMING_MESSAGE';
      if (
        !['INCOMING_MESSAGE', 'WEBSITE_REGISTRATION', 'TELEGRAM_DEEP_LINK'].includes(triggerType)
      ) {
        errors.push(`Incoming Message node ${node.id} has an unsupported trigger type`);
      }
      if (
        triggerType === 'WEBSITE_REGISTRATION' &&
        (!isNonEmptyString(node.config.sourceKey) ||
          !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(node.config.sourceKey as string))
      ) {
        errors.push(`Incoming Message node ${node.id} requires a valid website source key`);
      }
      if (
        triggerType === 'TELEGRAM_DEEP_LINK' &&
        (!isNonEmptyString(node.config.connectionId) ||
          !isNonEmptyString(node.config.startPayload) ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(node.config.startPayload as string))
      ) {
        errors.push(
          `Incoming Message node ${node.id} requires a Telegram connection and start payload`,
        );
      }
    }
    if (node.type === 'EXTERNAL_HTTP_REQUEST') {
      const config = externalHttpRequestConfigSchema.safeParse(node.config);
      if (!config.success) errors.push(`External HTTP node ${node.id} has invalid request config`);
      else if (config.data.successStatusMinimum > config.data.successStatusMaximum)
        errors.push(`External HTTP node ${node.id} has an invalid success status range`);
      const successEdges = edges.filter((edge) => edge.output === 'success');
      const failureEdges = edges.filter((edge) => edge.output === 'failure');
      if (successEdges.length !== 1 || failureEdges.length !== 1)
        errors.push(
          `External HTTP node ${node.id} requires exactly one success and one failure path`,
        );
    }
  }

  const reachable = new Set<string>();
  const visit = (nodeId: string): void => {
    if (reachable.has(nodeId)) return;
    reachable.add(nodeId);
    for (const edge of outgoing.get(nodeId) ?? []) visit(edge.to);
  };
  for (const trigger of triggers) visit(trigger.id);
  for (const node of graph.nodes) {
    if (!reachable.has(node.id)) errors.push(`Node ${node.id} is unreachable`);
  }
  if (hasUnguardedCycle(graph, outgoing, nodesById)) {
    errors.push('Graph contains an unguarded cycle');
  }
  return { errors, warnings };
}

function hasUnguardedCycle(
  graph: ScenarioGraph,
  outgoing: ReadonlyMap<string, ScenarioGraphEdge[]>,
  nodesById: ReadonlyMap<string, ScenarioGraphNode>,
): boolean {
  const visiting: string[] = [];
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    const cycleStart = visiting.indexOf(nodeId);
    if (cycleStart >= 0) {
      return !visiting
        .slice(cycleStart)
        .some((cycleNodeId) => continuationNodes.has(nodesById.get(cycleNodeId)!.type));
    }
    if (visited.has(nodeId)) return false;
    visiting.push(nodeId);
    for (const edge of outgoing.get(nodeId) ?? []) {
      if (visit(edge.to)) return true;
    }
    visiting.pop();
    visited.add(nodeId);
    return false;
  };
  return graph.nodes.some((node) => visit(node.id));
}

export function evaluateCondition(
  operator: ConditionOperator,
  actual: unknown,
  expected: unknown,
): boolean {
  if (operator === 'exists') return actual !== null && actual !== undefined;
  if (operator === 'not_exists') return actual === null || actual === undefined;
  if (actual === null || actual === undefined || expected === null || expected === undefined) {
    return operator === 'not_equals' && actual !== expected;
  }
  switch (operator) {
    case 'equals':
      return actual === expected;
    case 'not_equals':
      return actual !== expected;
    case 'contains':
      return (
        (typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected)) ||
        (Array.isArray(actual) && actual.some((item) => item === expected))
      );
    case 'starts_with':
      return (
        typeof actual === 'string' && typeof expected === 'string' && actual.startsWith(expected)
      );
    case 'ends_with':
      return (
        typeof actual === 'string' && typeof expected === 'string' && actual.endsWith(expected)
      );
    case 'greater_than':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'greater_or_equal':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'less_than':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'less_or_equal':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
  }
}

const supportedReplyEventTypes = new Set([
  'MESSAGE',
  'COMMAND',
  'CALLBACK_QUERY',
  'CONTACT_SHARED',
  ...waitReplyMediaTypes,
]);

export function matchesWaitForReplyCriteria(
  criteriaInput: unknown,
  payloadInput: unknown,
): boolean {
  const criteria = waitForReplyCriteriaSchema.safeParse(criteriaInput ?? {});
  if (!criteria.success) return false;
  const payload = record(payloadInput);
  const content = record(payload.content);
  const whatsAppInteractive = record(payload.interactive);
  const explicitEventType = typeof payload.type === 'string' ? payload.type : undefined;
  const eventType =
    explicitEventType === 'INTERACTIVE' &&
    ['button_reply', 'list_reply'].includes(String(whatsAppInteractive.type))
      ? 'CALLBACK_QUERY'
      : (explicitEventType ??
        (['button_reply', 'list_reply'].includes(String(whatsAppInteractive.type))
          ? 'CALLBACK_QUERY'
          : typeof payload.text === 'string'
            ? 'MESSAGE'
            : undefined));
  if (!eventType || !supportedReplyEventTypes.has(eventType)) return false;
  if (criteria.data.kind === 'ANY') return true;
  if (criteria.data.kind === 'MEDIA') return criteria.data.mediaTypes.includes(eventType as never);
  const actual =
    criteria.data.kind === 'CALLBACK'
      ? typeof content.data === 'string'
        ? content.data
        : typeof whatsAppInteractive.id === 'string'
          ? whatsAppInteractive.id
          : undefined
      : typeof content.text === 'string'
        ? content.text
        : typeof payload.text === 'string'
          ? payload.text
          : undefined;
  if (actual === undefined) return false;
  const expected = criteria.data.value;
  return evaluateCondition(
    criteria.data.operator,
    criteria.data.caseSensitive ? actual : actual.toLocaleLowerCase(),
    criteria.data.caseSensitive ? expected : expected.toLocaleLowerCase(),
  );
}

export function evaluateConditionGroup(
  group: ConditionGroup,
  valueFor: (field: string) => unknown,
): boolean {
  const results = group.rules.map((rule) =>
    evaluateCondition(rule.operator, valueFor(rule.field), rule.value),
  );
  return group.combinator === 'AND' ? results.every(Boolean) : results.some(Boolean);
}

export function automationValueFor(
  field: string | undefined,
  payloadInput: unknown,
  customFieldsInput: unknown,
  contactInput: unknown,
  variablesInput: unknown = {},
): unknown {
  const payload = record(payloadInput);
  const content = record(payload.content);
  const customFields = record(customFieldsInput);
  const contact = record(contactInput);
  const variables = record(variablesInput);
  if (field === 'message.text') return content.text ?? null;
  if (field === 'callback.data') return content.data ?? null;
  if (field === 'event.type') return payload.type ?? null;
  if (field?.startsWith('contact.') && !field.startsWith('contact.customFields.'))
    return contact[field.slice('contact.'.length)] ?? null;
  if (field?.startsWith('contact.customFields.'))
    return customFields[field.slice('contact.customFields.'.length)];
  if (field?.startsWith('variables.'))
    return valueAtPath(variables, field.slice('variables.'.length));
  if (field?.startsWith('nodes.')) return valueAtPath(variables, field);
  if (field) return valueAtPath(variables, field);
  return undefined;
}

export interface AutomationSimulationInput {
  contact?: Record<string, unknown>;
  customFields?: Record<string, unknown>;
  event?: Record<string, unknown>;
  httpOutcome?: 'success' | 'failure';
  waitOutcome?: 'reply' | 'timeout';
}

export interface AutomationSimulationStep {
  nodeId: string;
  nodeType: AutomationNodeType;
  result: 'COMPLETED' | 'WAITING' | 'WOULD_EXECUTE';
  selectedOutput?: string;
  nextNodeId?: string;
  reasonCode?: string;
}

export interface AutomationSimulationResult {
  completed: boolean;
  steps: AutomationSimulationStep[];
}

export function simulateScenarioGraph(
  graphInput: unknown,
  input: AutomationSimulationInput = {},
): AutomationSimulationResult {
  const parsed = scenarioGraphSchema.safeParse(graphInput);
  if (!parsed.success) throw new Error('automation_simulation_graph_invalid');
  const graph = parsed.data;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, ScenarioGraphEdge[]>();
  for (const edge of graph.edges)
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  let node = graph.nodes.find((candidate) => candidate.type === 'INCOMING_MESSAGE');
  const steps: AutomationSimulationStep[] = [];
  let budget = 100;
  while (node && budget-- > 0) {
    const currentNode = node;
    const edges = (outgoing.get(currentNode.id) ?? []).slice().sort(byPriority);
    let selected = edges.find((edge) => edge.output === 'default') ?? edges[0];
    let result: AutomationSimulationStep['result'] = 'WOULD_EXECUTE';
    let reasonCode: string | undefined;
    if (currentNode.type === 'CONDITION') {
      const configured = edges.filter((edge) => edge.condition || edge.conditionGroup);
      const fallback = edges.find((edge) => !edge.condition && !edge.conditionGroup);
      const legacyCondition = hasLegacyNodeCondition(currentNode);
      selected =
        configured.length === 0 && legacyCondition
          ? edges.find((edge) => edgeMatches(edge, currentNode, input))
          : (configured.find((edge) => edgeMatches(edge, currentNode, input)) ?? fallback);
      reasonCode = selected
        ? configured.length > 0 && selected === fallback
          ? 'FALLBACK_SELECTED'
          : 'CONDITION_MATCHED'
        : 'NO_BRANCH_MATCHED';
    } else if (currentNode.type === 'WAIT_FOR_REPLY') {
      if (!input.waitOutcome) {
        result = 'WAITING';
        selected = undefined;
        reasonCode = 'WAIT_OUTCOME_REQUIRED';
      } else {
        selected = edges.find((edge) => edge.output === input.waitOutcome);
        reasonCode = input.waitOutcome === 'reply' ? 'REPLY_SIMULATED' : 'TIMEOUT_SIMULATED';
      }
    } else if (currentNode.type === 'DELAY') {
      reasonCode = 'DELAY_SKIPPED_IN_TEST';
    } else if (currentNode.type === 'EXTERNAL_HTTP_REQUEST') {
      if (!input.httpOutcome) {
        result = 'WAITING';
        selected = undefined;
        reasonCode = 'HTTP_OUTCOME_REQUIRED';
      } else {
        selected = edges.find((edge) => edge.output === input.httpOutcome);
        reasonCode =
          input.httpOutcome === 'success' ? 'HTTP_SUCCESS_SIMULATED' : 'HTTP_FAILURE_SIMULATED';
      }
    } else if (currentNode.type === 'STOP') {
      result = 'COMPLETED';
      selected = undefined;
    }
    steps.push({
      nodeId: currentNode.id,
      nodeType: currentNode.type,
      result,
      ...(selected?.output ? { selectedOutput: selected.output } : {}),
      ...(selected?.to ? { nextNodeId: selected.to } : {}),
      ...(reasonCode ? { reasonCode } : {}),
    });
    if (result === 'WAITING') return { completed: false, steps };
    node = selected ? nodes.get(selected.to) : undefined;
  }
  if (budget <= 0) throw new Error('automation_simulation_step_budget_exhausted');
  return { completed: true, steps };
}

function hasLegacyNodeCondition(node: ScenarioGraphNode): boolean {
  return typeof node.config.field === 'string' && typeof node.config.operator === 'string';
}

function edgeMatches(
  edge: ScenarioGraphEdge,
  node: ScenarioGraphNode,
  input: AutomationSimulationInput,
): boolean {
  const valueFor = (field: string) =>
    automationValueFor(field, input.event ?? {}, input.customFields ?? {}, input.contact ?? {});
  if (edge.conditionGroup) return evaluateConditionGroup(edge.conditionGroup, valueFor);
  const rule = edge.condition ?? (node.config as ConditionRule);
  if (!rule.field || !rule.operator) return false;
  return evaluateCondition(rule.operator, valueFor(rule.field), rule.value);
}

function byPriority(left: ScenarioGraphEdge, right: ScenarioGraphEdge): number {
  return (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    if (dangerousPathSegments.has(part) || !Object.hasOwn(current, part)) return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
