import { describe, expect, it, vi } from 'vitest';
import {
  blockedMailAttachment,
  isAutomaticMail,
  mailboxAddressSchema,
  mailboxLocalPartSchema,
  mailMessageIds,
  parseMailAddress,
  receivingDomainReady,
  replyAliasToken,
  replySubject,
  safeMailFilename,
} from './mailbox';
import { ResendMailApiError, ResendMailClient } from './resend-mail-client';

describe('mailbox boundaries', () => {
  it('normalizes a single mailbox and refuses header injection or multiple recipients', () => {
    expect(parseMailAddress('Customer <ALICE@example.com>')).toBe('alice@example.com');
    expect(parseMailAddress('a@example.com, b@example.com')).toBeNull();
    expect(mailboxAddressSchema.safeParse('a@example.com\r\nBcc: victim@example.com').success).toBe(
      false,
    );
    expect(mailboxLocalPartSchema.safeParse('sales..team').success).toBe(false);
    expect(mailboxLocalPartSchema.safeParse('reply+token').success).toBe(false);
  });
  it('requires an exact alias token and bounded RFC IDs', () => {
    const token = 'a'.repeat(36);
    expect(replyAliasToken('reply+' + token + '@mail.example.com')).toBe(token);
    expect(replyAliasToken('sales+' + token + '@mail.example.com')).toBeNull();
    expect(
      mailMessageIds('<first@example.com> junk <second@example.com> <first@example.com>'),
    ).toEqual(['first@example.com', 'second@example.com'].map((id) => '<' + id + '>'));
    expect(mailMessageIds('<bad\r\nmessage@example.com>')).toEqual([]);
    expect(replySubject('Re: Existing')).toBe('Re: Existing');
  });
  it('does not confuse sending verification with receiving readiness', () => {
    const domain = {
      id: '1',
      name: 'example.com',
      status: 'verified',
      capabilities: { sending: 'enabled', receiving: 'enabled' },
      records: [],
    };
    expect(receivingDomainReady(domain as never)).toBe(false);
    expect(
      receivingDomainReady({
        ...domain,
        records: [
          {
            record: 'Receiving',
            type: 'MX',
            status: 'verified',
            name: '@',
            value: 'inbound.example.com',
          },
        ],
      } as never),
    ).toBe(true);
  });
  it('excludes automated mail and blocks executable attachments', () => {
    expect(isAutomaticMail({ 'Auto-Submitted': 'auto-replied' }, 'client@example.com')).toBe(true);
    expect(isAutomaticMail({ Precedence: 'bulk' }, 'client@example.com')).toBe(true);
    expect(isAutomaticMail({}, 'mailer-daemon@example.com')).toBe(true);
    expect(isAutomaticMail({}, 'client@example.com')).toBe(false);
    expect(blockedMailAttachment('invoice.HTML', 'text/plain')).toBe(true);
    expect(blockedMailAttachment('invoice.pdf', 'application/pdf')).toBe(false);
    expect(safeMailFilename('../../hello\r\n.pdf')).not.toMatch(/[\r\n/\\]/);
  });
});

describe('Resend bounded server reader', () => {
  it('keeps API keys on the server and requests CID-preserving inbound HTML', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id,
          from: 'Alice <alice@example.com>',
          to: ['sales@example.com'],
          subject: 'Reply',
          created_at: '2026-09-15T00:00:00Z',
          text: 'Hello',
          html: '<p>Hello</p>',
          headers: {},
          message_id: '<reply@example.com>',
        }),
        { status: 200 },
      ),
    );
    const client = new ResendMailClient('re_fixture', fetcher);
    expect((await client.received(id)).text).toBe('Hello');
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.resend.com/emails/receiving/' + id + '?html_format=cid',
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({ Authorization: 'Bearer re_fixture' }),
      }),
    );
  });
  it('never exposes provider error bodies or follows provider redirects', async () => {
    const client = new ResendMailClient(
      're_fixture',
      vi.fn().mockResolvedValue(new Response('secret provider details', { status: 429 })),
    );
    await expect(client.request('/domains')).rejects.toBeInstanceOf(ResendMailApiError);
    await expect(
      new ResendMailClient(
        're_fixture',
        vi.fn().mockResolvedValue(new Response('secret provider details', { status: 401 })),
      ).request('/domains'),
    ).rejects.not.toThrow('secret provider details');
  });
});
