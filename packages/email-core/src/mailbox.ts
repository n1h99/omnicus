import { z } from 'zod';

export const emailHeaderSchema = z
  .string()
  .max(998)
  // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted email headers.
  .refine((value) => !/[\r\n\x00]/.test(value));
export const mailboxAddressSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254)
  // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted email headers.
  .refine((value) => !/[\r\n\x00<>]/.test(value));
export const mailboxLocalPartSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/)
  .refine((value) => !value.includes('..'));
export const mailTextLimit = 100_000;
export const mailAttachmentLimit = 25 * 1024 * 1024;

/** One address only; display names never become a routing identity. */
export function parseMailAddress(input: string): string | null {
  // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted email headers.
  if (input.length > 998 || /[\r\n\x00]/.test(input)) return null;
  const angle = input.match(/^[^<>]*<([^<>]+)>\s*$/);
  const result = mailboxAddressSchema.safeParse(angle ? angle[1] : input);
  return result.success ? result.data : null;
}

export function mailHeader(headers: Record<string, string>, name: string): string {
  return (
    Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? ''
  );
}

export function mailMessageIds(value: string): string[] {
  if (value.length > 16_384) return [];
  // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted email headers.
  return [...new Set(value.match(/<[^<>\s\x00-\x1f]{1,900}>/g) ?? [])].slice(-30);
}

export function replyAliasToken(address: string): string | null {
  return /^reply\+([a-f0-9]{36})@[^@]+$/.exec(address)?.[1] ?? null;
}

export function isAutomaticMail(headers: Record<string, string>, sender: string): boolean {
  const submitted = mailHeader(headers, 'auto-submitted').trim().toLowerCase();
  return Boolean(
    (submitted && submitted !== 'no') ||
    /^(bulk|list|junk)$/i.test(mailHeader(headers, 'precedence').trim()) ||
    /multipart\/report|message\/delivery-status/i.test(mailHeader(headers, 'content-type')) ||
    /^(mailer-daemon|postmaster)@/i.test(sender),
  );
}

export function replySubject(subject: string): string {
  return (/^re\s*:/i.test(subject) ? subject : 'Re: ' + subject).slice(0, 200);
}

export const receivedEmailEventSchema = z.object({
  type: z.literal('email.received'),
  created_at: z.string().max(80),
  data: z.object({
    email_id: z.string().uuid(),
    to: z.array(emailHeaderSchema).max(100),
    cc: z.array(emailHeaderSchema).max(100).optional(),
    bcc: z.array(emailHeaderSchema).max(100).optional(),
  }),
});

export const resendDomainSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(253),
  status: z.string().max(80),
  region: z.string().max(80).optional(),
  capabilities: z.object({ sending: z.string(), receiving: z.string() }).optional(),
  records: z
    .array(
      z.object({
        record: z.string().max(80),
        name: z.string().max(253),
        type: z.string().max(20),
        value: z.string().max(8_192),
        status: z.string().max(80),
        priority: z.number().optional(),
        ttl: z.union([z.string(), z.number()]).optional(),
      }),
    )
    .max(50)
    .default([]),
});
export type ResendMailDomain = z.infer<typeof resendDomainSchema>;

export function receivingDomainReady(domain: ResendMailDomain): boolean {
  return (
    domain.capabilities?.receiving === 'enabled' &&
    domain.records.some(
      (record) =>
        record.type === 'MX' &&
        record.record.toLowerCase() === 'receiving' &&
        record.status === 'verified',
    )
  );
}

export const receivedEmailSchema = z.object({
  id: z.string().uuid(),
  from: emailHeaderSchema,
  to: z.array(emailHeaderSchema).max(100),
  cc: z.array(emailHeaderSchema).max(100).default([]),
  bcc: z.array(emailHeaderSchema).max(100).default([]),
  reply_to: z.array(emailHeaderSchema).max(20).default([]),
  subject: emailHeaderSchema,
  message_id: emailHeaderSchema.nullish(),
  created_at: z.string().max(80),
  text: z.string().max(2_000_000).nullable(),
  html: z.string().max(2_000_000).nullable(),
  headers: z
    .record(z.string().max(200), z.string().max(16_384))
    .refine((headers) => Object.keys(headers).length <= 250),
  attachments: z
    .array(
      z.object({
        id: z.string().uuid(),
        filename: z.string().max(500).nullable(),
        content_type: z.string().max(200),
        content_id: z.string().max(998).nullish(),
        size: z.number().int().nonnegative().max(2147483647),
      }),
    )
    .max(100)
    .default([]),
});
export type ReceivedMail = z.infer<typeof receivedEmailSchema>;

export function safeMailFilename(value: string | null): string {
  // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted email headers.
  return (value ?? 'attachment').replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 180) || 'attachment';
}

export const blockedMailAttachment = (filename: string, contentType: string): boolean =>
  /\.(?:exe|com|bat|cmd|ps1|sh|js|mjs|cjs|vbs|msi|scr|lnk|hta|html?|svg)$/i.test(filename) ||
  /(?:javascript|x-msdownload|x-sh|x-powershell|text\/html|image\/svg)/i.test(contentType);
