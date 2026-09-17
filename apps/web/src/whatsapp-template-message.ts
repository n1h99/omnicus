import type {
  WhatsAppMessageTemplate,
  WhatsAppTemplateParameter,
} from './whatsapp-templates-api';

export interface WhatsAppTemplateMessagePreview {
  body?: string;
  buttons: string[];
  footer?: string;
  header?: string;
  languageCode: string;
  name: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parameterText(parameter: unknown) {
  const value = object(parameter);
  if (!value) return undefined;
  if (value.type === 'text') return text(value.text);
  if (value.type === 'currency')
    return text(value.fallbackValue) ?? text(object(value.currency)?.fallbackValue);
  if (value.type === 'date_time')
    return text(value.fallbackValue) ?? text(object(value.dateTime)?.fallbackValue);
  return undefined;
}

function renderText(value: string, parameters: unknown[]) {
  return value.replace(/\{\{\s*(\d+)\s*\}\}/g, (placeholder, index: string) => {
    return parameterText(parameters[Number(index) - 1]) ?? placeholder;
  });
}

export function resolveWhatsAppTemplateMessage(
  sentValue: unknown,
  templates: WhatsAppMessageTemplate[],
): WhatsAppTemplateMessagePreview | null {
  const sent = object(sentValue);
  const name = text(sent?.name);
  const languageCode = text(sent?.languageCode);
  if (!name || !languageCode) return null;
  const template = templates.find(
    (candidate) => candidate.name === name && candidate.languageCode === languageCode,
  );
  if (!template) return null;

  const sentComponents = Array.isArray(sent?.components) ? sent.components : [];
  const preview: WhatsAppTemplateMessagePreview = {
    buttons: [],
    languageCode,
    name,
  };
  for (const component of template.components) {
    if (component.type === 'BUTTONS') {
      preview.buttons.push(...(component.buttons ?? []).map((button) => button.text));
      continue;
    }
    if (component.type === 'FOOTER') {
      if (component.text) preview.footer = component.text;
      continue;
    }
    if (!component.text) continue;
    const sentComponent = sentComponents
      .map(object)
      .find((candidate) => candidate?.type === component.type.toLowerCase());
    const parameters = Array.isArray(sentComponent?.parameters)
      ? sentComponent.parameters
      : ([] as WhatsAppTemplateParameter[]);
    const rendered = renderText(component.text, parameters);
    if (component.type === 'HEADER') preview.header = rendered;
    if (component.type === 'BODY') preview.body = rendered;
  }

  return preview;
}
