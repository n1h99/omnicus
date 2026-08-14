# Email Broadcasts

Omnicus email delivery is a separate, durable delivery path. It does not emulate a Telegram or
WhatsApp connection and does not depend on a chat identity.

## Product surface

`Email & SMS Broadcast` contains:

- Email/SMS channel switch. SMS is intentionally marked as under construction.
- Campaign drafts with autosave, audience filters, immediate launch and scheduling.
- Block editor for headings, formatted text, buttons, inline images, attachments, dividers,
  spacing and social links.
- Desktop inbox preview with contact variables.
- Test sends that do not require marketing consent and do not affect campaign metrics.
- Reusable templates with mutable drafts and immutable published versions.
- Campaign delivery report with recipient status, attempts and safe errors.
- Project suppression list with manual entries and automatic unsubscribe/bounce/complaint entries.
- `Send email` Automation Studio node that pins a published email template version.

## Delivery architecture

1. The API saves campaign/template content and immutable media references in PostgreSQL.
2. Launch changes a campaign to `PREPARING` or `SCHEDULED`.
3. The worker takes a recipient snapshot using the saved audience definition.
4. Every address is normalized and deduplicated. Only active contacts with `GRANTED` email
   consent and no suppression entry receive a delivery row.
5. The worker claims delivery rows atomically, renders per-contact variables, loads media from S3,
   embeds inline images with CID, and sends through Resend with an idempotency key.
6. Retryable provider/network failures use bounded exponential backoff. Permanent 4xx failures are
   not retried. Interrupted claims are recovered after the lease timeout.
7. Resend webhooks are signature-verified and deduplicated by `svix-id`. Out-of-order events cannot
   regress a later delivery status.
8. Email events are forwarded through the existing CRM outbox and appear in the linked lead history.

Inline images and attachments are loaded only at send time. The worker rejects a combined raw
attachment payload above 29 MiB, leaving headroom for Resend's Base64 request limit.

## Railway variables

Set on the **worker** service:

```env
RESEND_API_KEY=re_...
EMAIL_FROM=Omnicus <news@mail.omnicus.app>
EMAIL_REPLY_TO=
API_PUBLIC_URL=https://api.omnicus.app
EMAIL_DELIVERY_BATCH_SIZE=25
EMAIL_DELIVERY_INTERVAL_MS=2000
EMAIL_DELIVERY_LEASE_MS=300000
```

`EMAIL_REPLY_TO` is optional. Leave it empty for a no-reply marketing address.

Set on the **API** service after creating the Resend webhook:

```env
RESEND_WEBHOOK_SECRET=whsec_...
```

The API and worker must keep their existing database, S3 media and CRM variables.

## Resend setup

The sending domain and custom tracking domain must remain verified. Current production setup:

- Sending domain: `mail.omnicus.app`
- Sender: `news@mail.omnicus.app`
- Tracking domain: `links.mail.omnicus.app`
- Click tracking: enabled
- Open tracking: disabled by policy; `OPENED` remains supported if it is enabled later

Create a Resend webhook with this endpoint:

```text
https://api.omnicus.app/webhooks/resend
```

Subscribe it to:

- `email.sent`
- `email.delivered`
- `email.delivery_delayed`
- `email.opened`
- `email.clicked`
- `email.bounced`
- `email.complained`
- `email.failed`
- `email.suppressed`

Copy the webhook signing secret to the API service as `RESEND_WEBHOOK_SECRET`, then redeploy the API.
Do not put this secret in the web or worker service.

## Database deployment

Deploy the migration before starting the new API and worker images:

```bash
pnpm db:migrate:deploy
```

Migration `20260814030000_email_campaigns` creates the email tables, CRM operation enum value and
email consent fields. It also backfills consent for previously captured website leads whose stored
registration payload contains `leadRegistration.consents.email = true`.

## Consent and unsubscribe

- Website lead capture persists explicit `consents.email` with its source and timestamp.
- Missing consent is `UNKNOWN`; it is never treated as opt-in.
- Every marketing email has `List-Unsubscribe` and `List-Unsubscribe-Post` headers plus a visible
  unsubscribe footer.
- GET shows a confirmation page. POST performs RFC 8058 one-click unsubscribe.
- Unsubscribe revokes contact consent, creates a suppression, and suppresses all queued deliveries
  for the same normalized address in the project.
- Complaint, bounce and provider suppression webhooks automatically add suppressions.
- Removing a suppression does not manufacture consent; consent must still be `GRANTED`.

## Variables

The editor supports:

```text
{{contact.firstName}}
{{contact.fullName}}
{{contact.email}}
```

A fallback can be supplied with `|`, for example:

```text
Hello {{contact.firstName|there}}
```

## CRM history

The CRM receives idempotent actions such as:

- `omnicus.email.sent`
- `omnicus.email.delivered`
- `omnicus.email.clicked`
- `omnicus.email.bounced`
- `omnicus.email.complained`
- `omnicus.email.failed`
- `omnicus.email.unsubscribed`

Click events include the final target URL. The contact-to-lead link must already exist; otherwise the
CRM outbox retries until reconciliation creates it.

## Smoke test after deployment

1. Create a template, send a test email, and verify its image and attachment.
2. Publish the template and select it in a `Send email` automation node.
3. Register a lead with `consents.email: true` and verify the automation delivery.
4. Create a small selected-contact campaign and inspect the audience estimate before launch.
5. Click a tracked link and verify `CLICKED` in the campaign delivery and CRM lead history.
6. Use the unsubscribe link and verify that a second campaign excludes the address.
7. Replay one Resend webhook and verify that it does not create a duplicate event.

Do not use a production-sized audience until this smoke test is complete.
