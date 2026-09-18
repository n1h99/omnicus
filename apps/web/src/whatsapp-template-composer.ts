import type {
  WhatsAppMessageTemplate,
  WhatsAppTemplateComponentInput,
} from './whatsapp-templates-api';

export type WhatsAppParameterSlot = {
  component: 'body' | 'button' | 'header';
  index?: number;
  key: string;
  kind: 'media' | 'quick_reply' | 'text' | 'url';
  label: string;
  mediaType?: 'document' | 'image' | 'video';
  order: number;
  suggestedValue?: string;
  variableName?: string;
};

export function whatsAppTemplateComposerIssue(
  template: WhatsAppMessageTemplate,
): string | undefined {
  if (template.category === 'AUTHENTICATION') {
    return 'Authentication templates need an OTP-specific contract that is not enabled yet';
  }
  if (
    template.components.some(
      (component) => component.type === 'HEADER' && component.format === 'LOCATION',
    )
  ) {
    return 'Location template headers are not enabled by the safe composer';
  }
  if (
    template.components.some(
      (component) =>
        component.parameterStyle === 'mixed' ||
        (component.unsupportedReason &&
          component.unsupportedReason !== 'WHATSAPP_TEMPLATE_NAMED_VARIABLES_UNSUPPORTED'),
    )
  ) {
    return 'This template contains components that are not supported by the current composer';
  }
  return undefined;
}

export function whatsAppParameterSlots(
  template?: WhatsAppMessageTemplate,
): WhatsAppParameterSlot[] {
  if (!template) return [];
  const slots: WhatsAppParameterSlot[] = [];
  for (const component of template.components) {
    const componentType = component.type.toLowerCase();
    if (componentType === 'header' || componentType === 'body') {
      if (
        component.type === 'HEADER' &&
        component.format &&
        ['DOCUMENT', 'IMAGE', 'VIDEO'].includes(component.format)
      ) {
        slots.push({
          component: 'header',
          key: 'header-media',
          kind: 'media',
          label: `Header ${component.format.toLowerCase()}`,
          mediaType: component.format.toLowerCase() as 'document' | 'image' | 'video',
          order: 0,
        });
      }
      const variables = [
        ...new Set(
          [...(component.text?.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g) ?? [])].map((match) =>
            match[1]!.trim(),
          ),
        ),
      ];
      if (variables.every((name) => /^\d+$/.test(name)))
        variables.sort((left, right) => Number(left) - Number(right));
      for (const [variableOrder, variableName] of variables.entries()) {
        const position = Number(variableName);
        slots.push({
          component: componentType,
          key: `${componentType}-${variableName}`,
          kind: 'text',
          label: `${component.type === 'HEADER' ? 'Header' : 'Message'} variable ${variableName}`,
          order: Number.isSafeInteger(position) && position > 0 ? position : variableOrder + 1,
          variableName,
        });
      }
    }
    if (component.type === 'BUTTONS') {
      component.buttons?.forEach((button, index) => {
        if (button.type === 'URL' && button.dynamic) {
          const variableName = button.url?.match(/\{\{\s*([^{}]+?)\s*\}\}/)?.[1]?.trim();
          slots.push({
            component: 'button',
            index,
            key: `button-${index}`,
            kind: 'url',
            label: `URL value for “${button.text}”`,
            order: index,
            ...(variableName ? { variableName } : {}),
          });
          return;
        }
        if (button.type !== 'QUICK_REPLY') return;
        slots.push({
          component: 'button',
          index,
          key: `button-${index}`,
          kind: 'quick_reply',
          label: `Reply value for “${button.text}”`,
          order: index,
          suggestedValue: button.text,
        });
      });
    }
  }
  return slots;
}

export function assetKindForWhatsAppSlot(slot: WhatsAppParameterSlot): string | undefined {
  const kinds = { document: 'DOCUMENT', image: 'PHOTO', video: 'VIDEO' } as const;
  return slot.mediaType ? kinds[slot.mediaType] : undefined;
}

export function whatsAppTemplateComponents(
  slots: WhatsAppParameterSlot[],
  values: Record<string, string> = {},
): WhatsAppTemplateComponentInput[] | undefined {
  const textGroups = new Map<'body' | 'header', Array<{ order: number; text: string }>>();
  const components: WhatsAppTemplateComponentInput[] = [];
  for (const slot of slots) {
    const value = values[slot.key]?.trim();
    if (!value) continue;
    if (slot.kind === 'media' && slot.mediaType) {
      components.push({
        parameters: [{ mediaAssetId: value, type: slot.mediaType }],
        type: 'header',
      });
      continue;
    }
    if (slot.kind === 'quick_reply' && slot.index !== undefined) {
      components.push({
        index: slot.index,
        parameters: [{ payload: value, type: 'payload' }],
        subType: 'quick_reply',
        type: 'button',
      });
      continue;
    }
    if (slot.kind === 'url' && slot.index !== undefined) {
      components.push({
        index: slot.index,
        parameters: [
          {
            ...(slot.variableName && !/^\d+$/.test(slot.variableName)
              ? { parameterName: slot.variableName }
              : {}),
            text: value,
            type: 'text',
          },
        ],
        subType: 'url',
        type: 'button',
      });
      continue;
    }
    if (slot.component === 'button') continue;
    const group = textGroups.get(slot.component) ?? [];
    group.push({ order: slot.order, text: value });
    textGroups.set(slot.component, group);
  }
  for (const [type, parameters] of textGroups) {
    components.push({
      parameters: parameters
        .sort((left, right) => left.order - right.order)
        .map((parameter) => {
          const slot = slots.find(
            (candidate) =>
              candidate.component === type &&
              candidate.kind === 'text' &&
              candidate.order === parameter.order,
          );
          return {
            ...(slot?.variableName && !/^\d+$/.test(slot.variableName)
              ? { parameterName: slot.variableName }
              : {}),
            text: parameter.text,
            type: 'text' as const,
          };
        }),
      type,
    });
  }
  return components.length ? components : undefined;
}

function normalizedVariableName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function variableValue(variables: Record<string, string | undefined>, name: string) {
  const target = normalizedVariableName(name);
  const preferredAliases: Record<string, string[]> = {
    name: ['name', 'firstName', 'displayName', 'fullName', 'client.name', 'contact.name'],
    firstname: ['firstName', 'client.firstName', 'contact.firstName', 'name'],
    lastname: ['lastName', 'client.lastName', 'contact.lastName'],
    fullname: ['fullName', 'displayName', 'name', 'client.name', 'contact.name'],
  };
  const aliases = preferredAliases[target] ?? [name];
  const matched =
    aliases.find((key) => variables[key]?.trim()) ??
    Object.keys(variables).find(
      (key) => variables[key]?.trim() && normalizedVariableName(key) === target,
    );
  return matched ? variables[matched]?.trim() : undefined;
}

export function whatsAppTemplateInitialValues(
  template: WhatsAppMessageTemplate,
  variables: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const slot of whatsAppParameterSlots(template)) {
    if (slot.suggestedValue) {
      result[slot.key] = slot.suggestedValue;
      continue;
    }
    if (!slot.variableName) continue;
    let value = /^\d+$/.test(slot.variableName)
      ? undefined
      : variableValue(variables, slot.variableName);
    if (!value && slot.variableName === '1') {
      const component = template.components.find(
        (candidate) => candidate.type.toLowerCase() === slot.component,
      );
      const greeting = component?.text
        ?.split(/\{\{\s*1\s*\}\}/, 1)[0]
        ?.match(/(?:^|\s)(?:hi|hello|hey|dear|ola|olá|привет|здравствуйте)[,!\s]*$/iu);
      if (greeting) {
        value = variableValue(variables, 'firstName');
        if (!value) value = variableValue(variables, 'name')?.split(/\s+/)[0];
      }
    }
    if (value) result[slot.key] = value;
  }
  return result;
}

export function whatsAppTemplateParameterValues(
  slots: WhatsAppParameterSlot[],
  components: WhatsAppTemplateComponentInput[] | undefined,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const slot of slots) {
    const component = components?.find((candidate) => {
      if (slot.component === 'button') {
        return candidate.type === 'button' && candidate.index === slot.index;
      }
      return candidate.type === slot.component;
    });
    if (!component) continue;
    if (slot.kind === 'media') {
      const parameter = component.parameters.find(
        (candidate) =>
          candidate.type === 'document' || candidate.type === 'image' || candidate.type === 'video',
      );
      if (parameter && 'mediaAssetId' in parameter) values[slot.key] = parameter.mediaAssetId;
      continue;
    }
    if (slot.kind === 'quick_reply') {
      const parameter = component.parameters.find((candidate) => candidate.type === 'payload');
      if (parameter && 'payload' in parameter) values[slot.key] = parameter.payload;
      continue;
    }
    if (slot.kind === 'url') {
      const parameter = component.parameters.find((candidate) => candidate.type === 'text');
      if (parameter?.type === 'text') values[slot.key] = parameter.text;
      continue;
    }
    const parameter = component.parameters[slot.order - 1];
    if (parameter?.type === 'text') values[slot.key] = parameter.text;
  }
  return values;
}
