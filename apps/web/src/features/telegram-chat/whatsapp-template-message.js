// Ported from the CRM conversation renderer; Omnicus API and layout are isolated here.
function parameterText(parameter) {
  if (!parameter) return undefined;
  if (parameter.type === 'text') return parameter.text;
  if (parameter.type === 'currency') return parameter.currency.fallbackValue;
  if (parameter.type === 'date_time') return parameter.dateTime.fallbackValue;
  return undefined;
}
function renderText(text, parameters) {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (placeholder, index) => {
    return parameterText(parameters[Number(index) - 1]) ?? placeholder;
  });
}
export function resolveWhatsAppTemplateMessage(sent, templates) {
  const template = templates.find(
    (candidate) => candidate.name === sent.name && candidate.languageCode === sent.languageCode,
  );
  if (!template) return null;
  const preview = { buttons: [] };
  template.components.forEach((component) => {
    if (component.type === 'BUTTONS') {
      preview.buttons.push(...(component.buttons ?? []).map((button) => button.text));
      return;
    }
    if (component.type === 'FOOTER') {
      if (component.text) preview.footer = component.text;
      return;
    }
    if (!component.text) return;
    const sentComponent = sent.components?.find(
      (candidate) => candidate.type === component.type.toLowerCase(),
    );
    const rendered = renderText(component.text, sentComponent?.parameters ?? []);
    if (component.type === 'HEADER') preview.header = rendered;
    if (component.type === 'BODY') preview.body = rendered;
  });
  return preview.header || preview.body || preview.footer || preview.buttons.length
    ? preview
    : null;
}
