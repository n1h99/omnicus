import { z } from 'zod';
import { receivedEmailSchema, resendDomainSchema } from './mailbox';

/** Resend REST v1 contract checked 2026-09-15; never accepts an arbitrary URL. */
export class ResendMailApiError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

export class ResendMailClient {
  constructor(
    private readonly apiKey: string,
    private readonly transport: typeof fetch = fetch,
  ) {}

  async request(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport('https://api.resend.com' + path, {
        headers: { Authorization: 'Bearer ' + this.apiKey },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ResendMailApiError('email_provider_unavailable', true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ResendMailApiError(
        'email_provider_http_' + response.status,
        response.status === 429 || response.status >= 500,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ResendMailApiError('email_provider_empty_response', true);
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 5 * 1024 * 1024)
          throw new ResendMailApiError('email_provider_response_too_large', false);
        parts.push(part.value);
      }
      return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof ResendMailApiError) throw error;
      throw new ResendMailApiError('email_provider_response_invalid', true);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async domain(id: string) {
    return resendDomainSchema.parse(await this.request('/domains/' + z.string().uuid().parse(id)));
  }

  async domains() {
    const result: z.infer<typeof resendDomainSchema>[] = [];
    let after: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const body = z
        .object({ data: z.array(resendDomainSchema).max(100), has_more: z.boolean().optional() })
        .parse(
          await this.request(
            '/domains?limit=100' + (after ? '&after=' + encodeURIComponent(after) : ''),
          ),
        );
      result.push(...body.data);
      if (!body.has_more || !body.data.length) break;
      after = body.data.at(-1)!.id;
    }
    return result;
  }

  async received(id: string) {
    return receivedEmailSchema.parse(
      await this.request('/emails/receiving/' + z.string().uuid().parse(id) + '?html_format=cid'),
    );
  }

  async attachment(emailId: string, id: string) {
    return z
      .object({
        download_url: z.string().url().max(16_384),
        size: z.number().int().nonnegative().optional(),
      })
      .parse(
        await this.request(
          '/emails/receiving/' +
            z.string().uuid().parse(emailId) +
            '/attachments/' +
            z.string().uuid().parse(id),
        ),
      );
  }
}
