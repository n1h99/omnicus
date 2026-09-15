import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { selectSafeLookupAddress } from '@omnicus/automation-http';
import { mailAttachmentLimit } from '@omnicus/email-core';

/** Input must come from the authenticated Resend attachment API, never from message HTML. */
export async function downloadEmailAttachment(
  urlText: string,
  expectedBytes: number,
): Promise<Buffer> {
  const url = new URL(urlText);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    url.href.length > 16_384
  )
    throw new Error('email_attachment_url_forbidden');
  if (expectedBytes < 0 || expectedBytes > mailAttachmentLimit)
    throw new Error('email_attachment_too_large');
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  const target = selectSafeLookupAddress(addresses);
  if (!target) throw new Error('email_attachment_target_forbidden');
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        signal: AbortSignal.timeout(30_000),
        lookup: (_hostname, options, callback) => {
          if (typeof options === 'object' && options.all) callback(null, [target]);
          else callback(null, target.address, target.family);
        },
      },
      (incoming) => {
        const parts: Buffer[] = [];
        let length = 0;
        const maximum = Math.min(mailAttachmentLimit, expectedBytes);
        if (
          incoming.statusCode !== 200 ||
          Number(incoming.headers['content-length'] ?? 0) > maximum
        ) {
          incoming.destroy();
          reject(new Error('email_attachment_download_rejected'));
          return;
        }
        incoming.on('data', (part: Buffer) => {
          length += part.length;
          if (length > maximum) {
            incoming.destroy();
            reject(new Error('email_attachment_too_large'));
          } else parts.push(Buffer.from(part));
        });
        incoming.on('error', () => reject(new Error('email_attachment_download_failed')));
        incoming.on('aborted', () => reject(new Error('email_attachment_download_failed')));
        incoming.on('end', () => {
          if (length !== expectedBytes) reject(new Error('email_attachment_size_mismatch'));
          else resolve(Buffer.concat(parts));
        });
      },
    );
    outgoing.on('error', () => reject(new Error('email_attachment_download_failed')));
    outgoing.end();
  });
}
