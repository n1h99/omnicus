import { z } from 'zod';

const colorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);
const alignmentSchema = z.enum(['left', 'center', 'right']);
const idSchema = z.string().min(1).max(100);
const safeUrlSchema = z
  .string()
  .url()
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol));

const headingBlockSchema = z.object({
  align: alignmentSchema.default('left'),
  color: colorSchema.optional(),
  content: z.string().max(2_000),
  id: idSchema,
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  type: z.literal('HEADING'),
});

const textBlockSchema = z.object({
  align: alignmentSchema.default('left'),
  color: colorSchema.optional(),
  content: z.string().max(20_000),
  fontSize: z.number().int().min(11).max(32).default(16),
  id: idSchema,
  lineHeight: z.number().min(1).max(2.5).default(1.6),
  type: z.literal('TEXT'),
});

const buttonBlockSchema = z.object({
  align: alignmentSchema.default('center'),
  backgroundColor: colorSchema.default('#0f766e'),
  borderRadius: z.number().int().min(0).max(32).default(10),
  id: idSchema,
  label: z.string().min(1).max(120),
  textColor: colorSchema.default('#ffffff'),
  type: z.literal('BUTTON'),
  url: safeUrlSchema,
});

const imageBlockSchema = z.object({
  align: alignmentSchema.default('center'),
  alt: z.string().max(300).default(''),
  assetId: z.string().uuid(),
  caption: z.string().max(500).optional(),
  heightPx: z.number().int().min(40).max(1200).optional(),
  id: idSchema,
  linkUrl: safeUrlSchema.optional(),
  objectFit: z.enum(['contain', 'cover']).default('contain'),
  type: z.literal('IMAGE'),
  widthPercent: z.number().int().min(10).max(100).default(100),
});

const attachmentBlockSchema = z.object({
  assetId: z.string().uuid(),
  description: z.string().max(500).optional(),
  fileName: z.string().min(1).max(255),
  id: idSchema,
  label: z.string().min(1).max(160),
  type: z.literal('ATTACHMENT'),
});

const dividerBlockSchema = z.object({
  color: colorSchema.default('#e2e8f0'),
  id: idSchema,
  spacing: z.number().int().min(4).max(64).default(24),
  type: z.literal('DIVIDER'),
});

const spacerBlockSchema = z.object({
  height: z.number().int().min(4).max(120).default(24),
  id: idSchema,
  type: z.literal('SPACER'),
});

const socialBlockSchema = z.object({
  align: alignmentSchema.default('center'),
  id: idSchema,
  links: z
    .array(
      z.object({
        label: z.string().min(1).max(50),
        url: safeUrlSchema,
      }),
    )
    .min(1)
    .max(8),
  type: z.literal('SOCIAL'),
});

export const emailBlockSchema = z.discriminatedUnion('type', [
  attachmentBlockSchema,
  buttonBlockSchema,
  dividerBlockSchema,
  headingBlockSchema,
  imageBlockSchema,
  socialBlockSchema,
  spacerBlockSchema,
  textBlockSchema,
]);

export const emailDocumentSchema = z.object({
  blocks: z.array(emailBlockSchema).min(1).max(100),
  settings: z.object({
    accentColor: colorSchema.default('#0f766e'),
    backgroundColor: colorSchema.default('#eef3f5'),
    contentColor: colorSchema.default('#ffffff'),
    fontFamily: z
      .enum(['Arial', 'Georgia', 'Tahoma', 'Trebuchet MS', 'Verdana'])
      .default('Arial'),
    textColor: colorSchema.default('#172033'),
    width: z.number().int().min(480).max(720).default(640),
  }),
  version: z.literal(1),
});

export type EmailBlock = z.infer<typeof emailBlockSchema>;
export type EmailDocument = z.infer<typeof emailDocumentSchema>;

export interface EmailAssetReference {
  assetId: string;
  usage: 'ATTACHMENT' | 'INLINE';
}

export interface RenderedEmail {
  html: string;
  missingVariables: string[];
  text: string;
}

export function createDefaultEmailDocument(): EmailDocument {
  return {
    blocks: [
      {
        align: 'left',
        content: 'A message worth opening',
        id: 'heading-1',
        level: 1,
        type: 'HEADING',
      },
      {
        align: 'left',
        content:
          'Hello {{contact.firstName|there}},\n\nWrite a clear, useful message and give the reader one obvious next step.',
        fontSize: 16,
        id: 'text-1',
        lineHeight: 1.6,
        type: 'TEXT',
      },
      {
        align: 'center',
        backgroundColor: '#0f766e',
        borderRadius: 10,
        id: 'button-1',
        label: 'Learn more',
        textColor: '#ffffff',
        type: 'BUTTON',
        url: 'https://omnicus.app',
      },
    ],
    settings: {
      accentColor: '#0f766e',
      backgroundColor: '#eef3f5',
      contentColor: '#ffffff',
      fontFamily: 'Arial',
      textColor: '#172033',
      width: 640,
    },
    version: 1,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function safeHref(value: string): string | undefined {
  try {
    const parsed = new URL(value.replaceAll('&amp;', '&'));
    return ['http:', 'https:'].includes(parsed.protocol) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function renderInlineMarkup(value: string): string {
  let output = escapeHtml(value);
  output = output.replace(
    /\[([^\]]{1,300})\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, url: string) => {
      const href = safeHref(url);
      return href
        ? `<a href="${href}" style="color:#0f766e;text-decoration:underline">${label}</a>`
        : label;
    },
  );
  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  output = output.replace(/__([^_]+)__/g, '<u>$1</u>');
  output = output.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return output.replaceAll('\n', '<br />');
}

function valueAtPath(variables: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, variables);
}

export function renderEmailTemplate(
  template: string,
  variables: Record<string, unknown>,
): { missing: string[]; output: string } {
  const missing = new Set<string>();
  const output = template.replace(
    /{{\s*([A-Za-z][A-Za-z0-9_.]*)(?:\|([^}]*))?\s*}}/g,
    (_match, path: string, fallback: string | undefined) => {
      const value = valueAtPath(variables, path);
      if (value === undefined || value === null || value === '') {
        if (fallback !== undefined) return fallback.trim();
        missing.add(path);
        return '';
      }
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : '';
    },
  );
  return { missing: [...missing], output };
}

export function emailAssetReferences(documentInput: unknown): EmailAssetReference[] {
  const document = emailDocumentSchema.parse(documentInput);
  const references = new Map<string, EmailAssetReference>();
  for (const block of document.blocks) {
    if (block.type === 'IMAGE')
      references.set(block.assetId, { assetId: block.assetId, usage: 'INLINE' });
    if (block.type === 'ATTACHMENT')
      references.set(block.assetId, { assetId: block.assetId, usage: 'ATTACHMENT' });
  }
  return [...references.values()];
}

function align(value: 'left' | 'center' | 'right'): string {
  return value;
}

function renderBlock(
  block: EmailBlock,
  variables: Record<string, unknown>,
  assetContentIds: Readonly<Record<string, string>>,
  missing: Set<string>,
): { html: string; text: string } {
  if (block.type === 'SPACER')
    return { html: `<div style="height:${block.height}px;line-height:${block.height}px">&nbsp;</div>`, text: '' };
  if (block.type === 'DIVIDER')
    return {
      html: `<div style="padding:${block.spacing}px 0"><div style="height:1px;background:${block.color}"></div></div>`,
      text: '---',
    };
  if (block.type === 'HEADING') {
    const rendered = renderEmailTemplate(block.content, variables);
    rendered.missing.forEach((item) => missing.add(item));
    const sizes = { 1: 34, 2: 27, 3: 21 };
    return {
      html: `<h${block.level} style="margin:0 0 18px;color:${block.color ?? '#172033'};font-size:${sizes[block.level]}px;line-height:1.2;text-align:${align(block.align)}">${renderInlineMarkup(rendered.output)}</h${block.level}>`,
      text: rendered.output,
    };
  }
  if (block.type === 'TEXT') {
    const rendered = renderEmailTemplate(block.content, variables);
    rendered.missing.forEach((item) => missing.add(item));
    return {
      html: `<div style="margin:0 0 18px;color:${block.color ?? '#334155'};font-size:${block.fontSize}px;line-height:${block.lineHeight};text-align:${align(block.align)}">${renderInlineMarkup(rendered.output)}</div>`,
      text: rendered.output,
    };
  }
  if (block.type === 'BUTTON') {
    const label = renderEmailTemplate(block.label, variables);
    const url = renderEmailTemplate(block.url, variables);
    label.missing.forEach((item) => missing.add(item));
    url.missing.forEach((item) => missing.add(item));
    return {
      html: `<div style="padding:8px 0 24px;text-align:${align(block.align)}"><a href="${escapeHtml(url.output)}" style="display:inline-block;padding:13px 22px;border-radius:${block.borderRadius}px;background:${block.backgroundColor};color:${block.textColor};font-size:15px;font-weight:700;text-decoration:none">${escapeHtml(label.output)}</a></div>`,
      text: `${label.output}: ${url.output}`,
    };
  }
  if (block.type === 'IMAGE') {
    const contentId = assetContentIds[block.assetId];
    const dimensions = block.heightPx
      ? `width:${block.widthPercent}%;height:${block.heightPx}px;object-fit:${block.objectFit};`
      : `width:${block.widthPercent}%;height:auto;`;
    const image = contentId
      ? `<img src="cid:${escapeHtml(contentId)}" alt="${escapeHtml(block.alt)}" style="display:block;${dimensions}max-width:100%;margin:0 auto;border:0" />`
      : `<div style="padding:32px;background:#f1f5f9;color:#64748b;text-align:center">Image unavailable</div>`;
    const linked = block.linkUrl
      ? `<a href="${escapeHtml(block.linkUrl)}" style="text-decoration:none">${image}</a>`
      : image;
    return {
      html: `<div style="padding:0 0 22px;text-align:${align(block.align)}">${linked}${block.caption ? `<div style="padding-top:8px;color:#64748b;font-size:12px">${escapeHtml(block.caption)}</div>` : ''}</div>`,
      text: block.caption ?? block.alt,
    };
  }
  if (block.type === 'ATTACHMENT')
    return { html: '', text: '' };
  const links = block.links
    .map(
      (link) =>
        `<a href="${escapeHtml(link.url)}" style="display:inline-block;margin:0 7px;color:#0f766e;font-size:13px;font-weight:700;text-decoration:none">${escapeHtml(link.label)}</a>`,
    )
    .join('');
  return {
    html: `<div style="padding:8px 0 20px;text-align:${align(block.align)}">${links}</div>`,
    text: block.links.map((link) => `${link.label}: ${link.url}`).join(' | '),
  };
}

export function renderEmailDocument(
  input: unknown,
  variables: Record<string, unknown>,
  options: {
    assetContentIds?: Readonly<Record<string, string>>;
    preheader?: string | undefined;
    unsubscribeUrl?: string | undefined;
  } = {},
): RenderedEmail {
  const document = emailDocumentSchema.parse(input);
  const missing = new Set<string>();
  const blocks = document.blocks.map((block) =>
    renderBlock(block, variables, options.assetContentIds ?? {}, missing),
  );
  const preheader = options.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(options.preheader)}</div>`
    : '';
  const unsubscribe = options.unsubscribeUrl
    ? `<div style="padding:22px 24px;color:#718096;font-size:11px;line-height:1.5;text-align:center">You are receiving this email because you opted in. <a href="${escapeHtml(options.unsubscribeUrl)}" style="color:#526578;text-decoration:underline">Unsubscribe</a></div>`
    : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:${document.settings.backgroundColor};font-family:${document.settings.fontFamily},sans-serif;color:${document.settings.textColor}">${preheader}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${document.settings.backgroundColor}"><tr><td align="center" style="padding:30px 12px"><table role="presentation" width="${document.settings.width}" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:${document.settings.width}px;background:${document.settings.contentColor};border-radius:18px;overflow:hidden"><tr><td style="padding:38px 40px">${blocks.map((block) => block.html).join('')}</td></tr><tr><td>${unsubscribe}</td></tr></table></td></tr></table></body></html>`;
  const text = [
    ...blocks.map((block) => block.text).filter(Boolean),
    ...(options.unsubscribeUrl ? [`Unsubscribe: ${options.unsubscribeUrl}`] : []),
  ].join('\n\n');
  return { html, missingVariables: [...missing], text };
}
