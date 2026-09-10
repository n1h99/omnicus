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
    template.components.some((component) =>
      [...(component.text?.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g) ?? [])].some(
        (match) => !/^\d+$/.test((match[1] ?? '').trim()),
      ),
    )
  ) {
    return 'Named Meta variables are not exposed by the current ordered-parameter contract';
  }
  if (template.components.some((component) => component.unsupportedReason)) {
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
      const positions = new Set<number>();
      for (const match of component.text?.matchAll(/\{\{\s*(\d+)\s*\}\}/g) ?? []) {
        const position = Number(match[1]);
        if (Number.isSafeInteger(position) && position > 0) positions.add(position);
      }
      for (const position of [...positions].sort((left, right) => left - right)) {
        slots.push({
          component: componentType,
          key: `${componentType}-${position}`,
          kind: 'text',
          label: `${component.type === 'HEADER' ? 'Header' : 'Message'} variable ${position}`,
          order: position,
        });
      }
    }
    if (component.type === 'BUTTONS') {
      component.buttons?.forEach((button, index) => {
        if (button.type === 'URL' && button.dynamic) {
          slots.push({
            component: 'button',
            index,
            key: `button-${index}`,
            kind: 'url',
            label: `URL value for “${button.text}”`,
            order: index,
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
        parameters: [{ text: value, type: 'text' }],
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
        .map((parameter) => ({ text: parameter.text, type: 'text' as const })),
      type,
    });
  }
  return components.length ? components : undefined;
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
