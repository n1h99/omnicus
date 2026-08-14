import type { AutomationCustomField } from './automation-studio-api';
import type { ScenarioGraph } from './automation-api';

export const durationUnits = {
  days: 86_400,
  hours: 3_600,
  minutes: 60,
  seconds: 1,
} as const;

export type DurationUnit = keyof typeof durationUnits;

export function durationParts(secondsInput: unknown): { unit: DurationUnit; value: number } {
  const seconds =
    typeof secondsInput === 'number' && Number.isInteger(secondsInput) && secondsInput > 0
      ? secondsInput
      : 60;
  for (const unit of ['days', 'hours', 'minutes'] as const) {
    const multiplier = durationUnits[unit];
    if (seconds % multiplier === 0) return { unit, value: seconds / multiplier };
  }
  return { unit: 'seconds', value: seconds };
}

export function durationSeconds(value: number | null, unit: DurationUnit): number {
  return Math.max(1, Math.round((value ?? 1) * durationUnits[unit]));
}

export function defaultCustomFieldValue(field?: AutomationCustomField): unknown {
  if (!field) return '';
  if (field.type === 'NUMBER') return 0;
  if (field.type === 'BOOLEAN') return false;
  if (field.type === 'MULTI_SELECT') return [];
  if (field.type === 'JSON') return {};
  return '';
}

export function conditionFieldType(
  fieldPath: string | undefined,
  customFields: AutomationCustomField[],
): AutomationCustomField['type'] | 'TEXT' {
  if (!fieldPath?.startsWith('contact.customFields.')) return 'TEXT';
  const key = fieldPath.slice('contact.customFields.'.length);
  return customFields.find((field) => field.key === key)?.type ?? 'TEXT';
}

export function safeDiagnosticJson(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0) return undefined;
  return JSON.stringify(value, null, 2);
}

export function automationEditorSignature(
  graph: ScenarioGraph,
  name: string | undefined,
  description: string | undefined,
): string {
  const canonicalGraph = {
    edges: graph.edges
      .map(({ id: _editorOnlyId, ...edge }) => edge)
      .sort((left, right) =>
        `${left.from}\u0000${left.output ?? 'default'}\u0000${left.to}`.localeCompare(
          `${right.from}\u0000${right.output ?? 'default'}\u0000${right.to}`,
        ),
      ),
    nodes: [...graph.nodes].sort((left, right) => left.id.localeCompare(right.id)),
  };
  return stableJson({ description: description ?? '', graph: canonicalGraph, name: name ?? '' });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function normalizeScenarioDescription(
  description: string | undefined,
  clearExisting: boolean,
): string | null | undefined {
  if (!description?.trim()) return clearExisting ? null : undefined;
  return description;
}

export interface AutomationResourceValidationIssue {
  edgeId?: string;
  message: string;
  nodeId?: string;
}

interface AutomationResourceCatalog {
  currentScenarioId?: string;
  customFields?: AutomationCustomField[];
  scenarios?: Array<{ activeVersionId: string | null; id: string; status: string }>;
  secrets?: Array<{ id: string }>;
  tags?: Array<{ id: string }>;
  templates?: Array<{ activeVersionId: string | null; id: string; status: string }>;
  emailTemplates?: Array<{ activeVersionId: string | null; id: string; status: string }>;
}

export function validateAutomationResources(
  graph: ScenarioGraph,
  resources: AutomationResourceCatalog,
): AutomationResourceValidationIssue[] {
  const issues: AutomationResourceValidationIssue[] = [];
  const seen = new Set<string>();
  const add = (issue: AutomationResourceValidationIssue) => {
    const key = `${issue.nodeId ?? ''}:${issue.edgeId ?? ''}:${issue.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      issues.push(issue);
    }
  };

  const fields = resources.customFields
    ? new Map(resources.customFields.map((field) => [field.key, field]))
    : undefined;
  const validateFieldPath = (
    fieldPath: unknown,
    location: { edgeId?: string; nodeId?: string },
  ) => {
    if (!fields || typeof fieldPath !== 'string') return;
    if (!fieldPath.startsWith('contact.customFields.')) return;
    const key = fieldPath.slice('contact.customFields.'.length);
    if (!fields.has(key))
      add({ ...location, message: 'This condition uses an unavailable custom field.' });
  };

  for (const node of graph.nodes) {
    const config = node.config ?? {};
    if (resources.tags && (node.type === 'ADD_TAG' || node.type === 'REMOVE_TAG')) {
      if (
        typeof config.tagId === 'string' &&
        !resources.tags.some((tag) => tag.id === config.tagId)
      )
        add({ message: 'Select an available project tag.', nodeId: node.id });
    }
    if (fields && (node.type === 'SET_CUSTOM_FIELD' || node.type === 'CLEAR_CUSTOM_FIELD')) {
      const field = typeof config.key === 'string' ? fields.get(config.key) : undefined;
      if (typeof config.key === 'string') {
        if (!field) add({ message: 'Select an available custom field.', nodeId: node.id });
        else if (node.type === 'SET_CUSTOM_FIELD' && !isCustomFieldValueValid(field, config.value))
          add({ message: `Choose a valid value for ${field.name}.`, nodeId: node.id });
      }
    }
    if (node.type === 'CONDITION') validateFieldPath(config.field, { nodeId: node.id });
    if (node.type === 'SEND_TEMPLATE') {
      const whatsAppTemplate =
        config.whatsAppTemplate &&
        typeof config.whatsAppTemplate === 'object' &&
        !Array.isArray(config.whatsAppTemplate)
          ? (config.whatsAppTemplate as Record<string, unknown>)
          : undefined;
      if (
        whatsAppTemplate &&
        (typeof whatsAppTemplate.name !== 'string' ||
          !whatsAppTemplate.name.trim() ||
          typeof whatsAppTemplate.languageCode !== 'string' ||
          !whatsAppTemplate.languageCode.trim())
      ) {
        add({
          message: 'Select an approved WhatsApp template.',
          nodeId: node.id,
        });
      }
      const template = resources.templates?.find((candidate) => candidate.id === config.templateId);
      if (
        resources.templates &&
        typeof config.templateId === 'string' &&
        typeof config.templateVersionId === 'string' &&
        (!template ||
          template.status !== 'PUBLISHED' ||
          !template.activeVersionId ||
          template.activeVersionId !== config.templateVersionId)
      )
        add({ message: 'Select an available published template.', nodeId: node.id });
    }
    if (node.type === 'SEND_EMAIL') {
      const template = resources.emailTemplates?.find(
        (candidate) => candidate.id === config.templateId,
      );
      if (
        resources.emailTemplates &&
        (!template ||
          template.status !== 'PUBLISHED' ||
          !template.activeVersionId ||
          template.activeVersionId !== config.templateVersionId)
      )
        add({ message: 'Select an available published email template.', nodeId: node.id });
    }
    if (resources.scenarios && node.type === 'START_SUBFLOW') {
      const scenario = resources.scenarios.find(
        (candidate) =>
          candidate.id === config.scenarioId && candidate.id !== resources.currentScenarioId,
      );
      if (
        typeof config.scenarioId === 'string' &&
        typeof config.scenarioVersionId === 'string' &&
        (!scenario ||
          scenario.status !== 'PUBLISHED' ||
          !scenario.activeVersionId ||
          scenario.activeVersionId !== config.scenarioVersionId)
      )
        add({ message: 'Select an available published subflow.', nodeId: node.id });
    }
    if (resources.secrets && node.type === 'EXTERNAL_HTTP_REQUEST') {
      const available = new Set(resources.secrets.map((secret) => secret.id));
      const headers = Array.isArray(config.headers) ? config.headers : [];
      if (
        headers.some(
          (header) =>
            header &&
            typeof header === 'object' &&
            typeof (header as { secretId?: unknown }).secretId === 'string' &&
            !available.has((header as { secretId: string }).secretId),
        )
      )
        add({ message: 'Replace the unavailable HTTP secret.', nodeId: node.id });
    }
  }
  for (const edge of graph.edges) {
    const location = { ...(edge.id ? { edgeId: edge.id } : {}), nodeId: edge.from };
    validateFieldPath(edge.condition?.field, location);
    for (const rule of edge.conditionGroup?.rules ?? []) validateFieldPath(rule.field, location);
  }
  return issues;
}

function isCustomFieldValueValid(field: AutomationCustomField, value: unknown): boolean {
  if (value === null) return true;
  if (field.type === 'TEXT') return typeof value === 'string';
  if (field.type === 'NUMBER') return typeof value === 'number' && Number.isFinite(value);
  if (field.type === 'BOOLEAN') return typeof value === 'boolean';
  if (field.type === 'DATE') return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (field.type === 'DATETIME')
    return typeof value === 'string' && !Number.isNaN(Date.parse(value));
  if (field.type === 'JSON') return value !== null && typeof value === 'object';
  const options = field.options ?? [];
  if (field.type === 'SELECT') return typeof value === 'string' && options.includes(value);
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && options.includes(entry))
  );
}

export function automationActionErrorMessage(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  const messages: Record<string, string> = {
    SCENARIO_AUTOMATION_SECRET_INVALID: 'Replace the unavailable HTTP secret before continuing.',
    SCENARIO_CUSTOM_FIELD_INVALID: 'Select an available custom field before continuing.',
    SCENARIO_CUSTOM_FIELD_VALUE_INVALID: 'A custom-field value no longer matches its definition.',
    SCENARIO_GRAPH_INVALID: 'Fix the highlighted scenario connections before continuing.',
    SCENARIO_GRAPH_SCHEMA_INVALID: 'Fix the highlighted scenario structure before continuing.',
    SCENARIO_SUBFLOW_SELF_REFERENCE: 'A scenario cannot start itself as a subflow.',
    SCENARIO_SUBFLOW_VERSION_INVALID: 'Select an available published subflow before continuing.',
    SCENARIO_TAG_INVALID: 'Select an available project tag before continuing.',
    SCENARIO_TEMPLATE_VERSION_INVALID: 'Select an available published template before continuing.',
    SCENARIO_EMAIL_TEMPLATE_VERSION_INVALID:
      'Select an available published email template before continuing.',
  };
  return messages[code] ?? 'The automation action could not be completed safely.';
}

const automationNodeLabels: Record<string, string> = {
  ADD_TAG: 'Add tag',
  CLEAR_CUSTOM_FIELD: 'Clear custom field',
  CONDITION: 'Condition',
  CREATE_OR_UPDATE_LEAD: 'Create or update lead',
  DELAY: 'Delay',
  EXTERNAL_HTTP_REQUEST: 'External HTTP request',
  FORWARD_TO_CRM: 'Forward to CRM',
  INCOMING_MESSAGE: 'Incoming message',
  PAUSE_AUTOMATION: 'Pause automation',
  REMOVE_TAG: 'Remove tag',
  RESUME_AUTOMATION: 'Resume automation',
  SEND_MESSAGE: 'Send message',
  SEND_TEMPLATE: 'Send template',
  SEND_EMAIL: 'Send email',
  SET_CUSTOM_FIELD: 'Set custom field',
  START_SUBFLOW: 'Subflow',
  STOP: 'Stop',
  WAIT_FOR_REPLY: 'Wait for reply',
};

export function automationNodeLabel(nodeType: string): string {
  return automationNodeLabels[nodeType] ?? nodeType.toLowerCase().replaceAll('_', ' ');
}

export function automationNodeDescription(nodeType: string): string {
  const descriptions: Record<string, string> = {
    ADD_TAG: 'Add a project tag to the contact.',
    CLEAR_CUSTOM_FIELD: 'Clear one custom-field value for the current contact.',
    CONDITION: 'Route the contact through matching and fallback branches.',
    CREATE_OR_UPDATE_LEAD: 'Create or refresh the paired CRM lead.',
    DELAY: 'Continue after a durable delay.',
    EXTERNAL_HTTP_REQUEST: 'Call an approved public HTTPS endpoint through the safe outbox.',
    FORWARD_TO_CRM: 'Forward the current inbound event to the paired CRM.',
    INCOMING_MESSAGE: 'Start this scenario for a supported inbound event.',
    PAUSE_AUTOMATION: 'Pause automation for this contact.',
    REMOVE_TAG: 'Remove a project tag from the contact.',
    RESUME_AUTOMATION: 'Resume automation for this contact.',
    SEND_MESSAGE:
      'Reply through the conversation channel with portable text and optional contact variables.',
    SEND_TEMPLATE: 'Queue one approved, channel-compatible template version.',
    SEND_EMAIL: 'Queue a consent-aware email from a pinned published template version.',
    SET_CUSTOM_FIELD: 'Set a typed custom-field value on the contact.',
    START_SUBFLOW: 'Run a pinned published version of another scenario.',
    STOP: 'Finish this path without another action.',
    WAIT_FOR_REPLY: 'Wait for a matching customer reply or continue on timeout.',
  };
  return descriptions[nodeType] ?? 'Configure this automation step.';
}

export function humanizeAutomationValidationIssue(
  issue: string,
  nodes: Array<{ id: string; type: string }>,
): { message: string; nodeId?: string } {
  const node = nodes.find((candidate) => issue.includes(candidate.id));
  if (issue === 'Incoming Message trigger must have an outgoing path')
    return {
      message: 'Incoming message needs an outgoing connection.',
      ...(nodes.find((candidate) => candidate.type === 'INCOMING_MESSAGE')?.id
        ? { nodeId: nodes.find((candidate) => candidate.type === 'INCOMING_MESSAGE')!.id }
        : {}),
    };
  if (node && issue === `Node ${node.id} is unreachable`)
    return {
      message: `${automationNodeLabel(node.type)} is not connected to the trigger.`,
      nodeId: node.id,
    };
  let message = issue;
  if (node) message = message.replaceAll(node.id, automationNodeLabel(node.type));
  message = message
    .replaceAll('Incoming Message', 'Incoming message')
    .replaceAll('Wait for Reply', 'Wait for reply')
    .replaceAll('delaySeconds', 'delay')
    .replaceAll('timeoutSeconds', 'timeout');
  return {
    message: message.endsWith('.') ? message : `${message}.`,
    ...(node ? { nodeId: node.id } : {}),
  };
}

export function externalHttpSafeErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    external_http_config_invalid: 'Complete the required request settings before testing.',
    external_http_dns_unavailable: 'The destination could not be resolved. Try again later.',
    external_http_target_forbidden:
      'The destination resolved only to private or restricted network addresses.',
    external_http_url_forbidden: 'Use a public HTTPS URL without embedded credentials.',
    external_http_url_invalid: 'Enter a valid public HTTPS URL.',
  };
  return messages[code] ?? 'The request failed safely. Review the request settings and try again.';
}

export function previewAutomationText(
  source: string,
  customFields: AutomationCustomField[],
): { missing: string[]; output: string } {
  const customFieldSamples = Object.fromEntries(
    customFields.map((field) => [field.key, sampleValue(field.type)]),
  );
  const context: Record<string, unknown> = {
    contact: {
      customFields: customFieldSamples,
      displayName: 'Alex Example',
      email: 'alex@example.test',
      firstName: 'Alex',
      lastName: 'Example',
      phone: '+10000000000',
      username: 'alex_example',
    },
    event: { content: { data: 'confirm', text: 'Example reply' }, type: 'MESSAGE' },
  };
  const missing = new Set<string>();
  const output = source.replace(/{{\s*([a-zA-Z0-9_.]+)\s*}}/g, (_, path: string) => {
    const value = path.split('.').reduce<unknown>((current, part) => {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
      return (current as Record<string, unknown>)[part];
    }, context);
    if (value === undefined || value === null || typeof value === 'object') {
      missing.add(path);
      return '';
    }
    return String(value);
  });
  return { missing: [...missing], output };
}

function sampleValue(type: AutomationCustomField['type']): unknown {
  if (type === 'NUMBER') return 42;
  if (type === 'BOOLEAN') return true;
  if (type === 'MULTI_SELECT') return ['sample'];
  if (type === 'JSON') return { sample: true };
  return 'Sample value';
}
