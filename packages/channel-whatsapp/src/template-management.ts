export interface WhatsAppTemplateDraft {
  name: string;
  languageCode: string;
  category: 'MARKETING' | 'UTILITY';
  body: string;
  bodyExamples?: string[];
  footer?: string;
  header?: {
    format: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
    text?: string;
    examples?: string[];
    handle?: string;
  };
  buttons?: Array<{
    type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';
    text: string;
    url?: string;
    phoneNumber?: string;
    example?: string;
  }>;
}

export class WhatsAppTemplateValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

function fail(field: string, message: string): never {
  throw new WhatsAppTemplateValidationError(field, message);
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    fail(field, `Enter ${field} using 1–${maximum} characters.`);
  return value.trim();
}

export function templateVariableCount(value: string): number {
  const matches = [...value.matchAll(/\{\{([^{}]+)\}\}/g)];
  if (value.replace(/\{\{[^{}]+\}\}/g, '').match(/[{}]/))
    fail('variables', 'Use numbered variables such as {{1}} and {{2}}.');
  const ids = matches.map((match) => Number(match[1]));
  if (matches.some((match) => !/^[1-9]\d*$/.test(match[1]!)))
    fail('variables', 'Use numbered variables such as {{1}} and {{2}}.');
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  if (unique.some((id, index) => id !== index + 1) || unique.length > 100)
    fail('variables', 'Number variables consecutively, starting with {{1}}.');
  return unique.length;
}

function examples(value: unknown, count: number, field: string): string[] {
  if (!count) return [];
  if (!Array.isArray(value) || value.length !== count)
    fail(field, 'Provide an example for every variable.');
  return value.map((item) => text(item, field, 1024));
}

/** Build an allowlisted Graph payload. Never forward arbitrary client components to Meta. */
export function buildWhatsAppTemplate(draft: WhatsAppTemplateDraft) {
  if (!draft || typeof draft !== 'object') fail('template', 'Enter a template.');
  const name = text(draft.name, 'name', 512);
  if (!/^[a-z0-9_]+$/.test(name))
    fail('name', 'Use lowercase letters, numbers and underscores in the name.');
  const language = text(draft.languageCode, 'language', 10);
  if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)) fail('language', 'Choose a valid language.');
  if (!['MARKETING', 'UTILITY'].includes(draft.category))
    fail('category', 'Choose Marketing or Utility.');
  const components: Record<string, unknown>[] = [];
  if (draft.header) {
    const header = draft.header;
    if (header.format === 'TEXT') {
      const value = text(header.text, 'header', 60);
      const count = templateVariableCount(value);
      if (count > 1 || /[\r\n]/.test(value))
        fail('header', 'Use one line and at most one variable.');
      components.push({
        type: 'HEADER',
        format: 'TEXT',
        text: value,
        ...(count
          ? { example: { header_text: examples(header.examples, count, 'header examples') } }
          : {}),
      });
    } else {
      if (!['IMAGE', 'VIDEO', 'DOCUMENT'].includes(header.format))
        fail('header', 'Choose a supported header.');
      components.push({
        type: 'HEADER',
        format: header.format,
        example: { header_handle: [text(header.handle, 'header sample', 4096)] },
      });
    }
  }
  const body = text(draft.body, 'body', 1024);
  const count = templateVariableCount(body);
  components.push({
    type: 'BODY',
    text: body,
    ...(count
      ? { example: { body_text: [examples(draft.bodyExamples, count, 'body examples')] } }
      : {}),
  });
  if (draft.footer) {
    const footer = text(draft.footer, 'footer', 60);
    if (templateVariableCount(footer) || /[\r\n]/.test(footer))
      fail('footer', 'Use a single line without variables.');
    components.push({ type: 'FOOTER', text: footer });
  }
  if (draft.buttons !== undefined && (!Array.isArray(draft.buttons) || draft.buttons.length > 10))
    fail('buttons', 'Add at most 10 buttons.');
  if (draft.buttons?.length) {
    const buttons = draft.buttons.map((button) => {
      if (!button || typeof button !== 'object') fail('buttons', 'Choose a button type.');
      const label = text(button.text, 'button text', 25);
      if (templateVariableCount(label)) fail('buttons', 'Button labels cannot contain variables.');
      if (button.type === 'QUICK_REPLY') return { type: button.type, text: label };
      if (button.type === 'PHONE_NUMBER') {
        const phone = text(button.phoneNumber, 'phone number', 17);
        if (!/^\+[1-9]\d{6,14}$/.test(phone))
          fail('phone number', 'Enter a number with its country code, starting with +.');
        return { type: button.type, text: label, phone_number: phone };
      }
      if (button.type !== 'URL') fail('buttons', 'Choose a supported button type.');
      const url = text(button.url, 'button URL', 2000);
      const count = templateVariableCount(url);
      if (count > 1 || (count && !url.endsWith('{{1}}')))
        fail('button URL', 'A URL can have one variable, {{1}}, at the end.');
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return fail('button URL', 'Enter a complete HTTPS URL.');
      }
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        parsed.hostname.includes('{')
      )
        fail('button URL', 'Enter a complete HTTPS URL without credentials.');
      const example = count ? text(button.example, 'button URL example', 2000) : undefined;
      if (example) {
        const prefix = url.slice(0, -5);
        if (!example.startsWith(prefix) || example === prefix || /[{}\s]/.test(example))
          fail(
            'button URL example',
            'Provide a complete URL with the variable replaced by an example value.',
          );
        try {
          if (new URL(example).origin !== parsed.origin)
            fail('button URL example', 'Use the same website as the button URL.');
        } catch {
          fail('button URL example', 'Enter a complete HTTPS URL.');
        }
      }
      return { type: button.type, text: label, url, ...(example ? { example: [example] } : {}) };
    });
    if (
      buttons.filter((b) => b.type === 'URL').length > 2 ||
      buttons.filter((b) => b.type === 'PHONE_NUMBER').length > 1
    )
      fail('buttons', 'Use at most two URL buttons and one phone button.');
    const groups = buttons
      .map((b) => (b.type === 'QUICK_REPLY' ? 'reply' : 'action'))
      .filter((type, i, list) => !i || list[i - 1] !== type);
    if (groups.length > 2)
      fail('buttons', 'Group quick replies together before or after the other buttons.');
    components.push({ type: 'BUTTONS', buttons });
  }
  return { name, language, category: draft.category, components };
}
