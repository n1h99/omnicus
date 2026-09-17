# Email Broadcasts

Status reviewed: 2026-08-29. Resend sending/tracking domains and the signed
webhook are configured; the email product is implemented and deployed. SMS is
not implemented.

Omnicus email delivery is a separate, durable delivery path. It does not emulate a Telegram or
WhatsApp connection and does not depend on a chat identity.

The WhatsApp management update of 2026-09-10 does not change Resend billing,
email click tracking or the shared Automation editor. Native WhatsApp templates,
Meta payment navigation and WhatsApp cost estimates are a separate provider
surface documented in [WHATSAPP_MANAGEMENT.md](WHATSAPP_MANAGEMENT.md).

## Product surface

Local Email Inbox addition (2026-09-15, not deployed): campaign editor and test
send use the selected/default configured mailbox. Send email automation pins a
mailbox on its queued delivery. Their new messages and replies share Inbox history;
manual replies remain private to authorized mailbox readers and are excluded from
the legacy broadcast delivery/analytics endpoints. Existing legacy `EMAIL_FROM`
works without a configured mailbox, but does not gain incoming history by itself.
See [EMAIL_INBOX.md](EMAIL_INBOX.md) for the new permissions and setup.

`Email & SMS Broadcast` contains:

- Email/SMS channel switch. SMS is intentionally marked as under construction.
- Campaign drafts with autosave, audience filters, immediate launch and scheduling.
- Block editor for headings, formatted text, buttons, inline images, attachments, dividers,
  spacing and social links.
- Desktop inbox preview with contact variables.
- Test sends that do not require marketing consent and do not affect campaign metrics.
- Reusable templates with mutable drafts and immutable published versions.
- Campaign delivery report with recipient status, attempts and safe errors.
- Project Analytics table for safe lifecycle events and clicked target URLs.
- Project suppression list with manual entries and automatic unsubscribe/bounce/complaint entries.
- `Send email` Automation Studio node that pins a published email template version.
- An editor notice explaining that link tracking is controlled centrally for
  the sending domain rather than by a per-campaign checkbox.

The editor exposes a variable picker rather than requiring operators to type
template syntax from memory. Image blocks keep a private media reference and
support explicit width and height controls; attachments are listed in content
settings and are not rendered as fake body content in the central preview.
Campaign and template deletion use the shared application confirmation dialog
and remain subject to server lifecycle guards.

Broadcast is intentionally not a second automation authoring surface. A
campaign has content, audience, delivery time and delivery reporting. A
triggered follow-up sequence belongs in `Automation -> Scenarios`, where the
existing graph already owns delays, waits, conditions, branches and channel
actions. Duplicating that canvas here would add client render/state cost and a
second validation/version contract without adding runtime capability.

## Delivery architecture

1. The API saves campaign/template content and immutable media references in PostgreSQL.
2. Launch changes a campaign to `PREPARING` or `SCHEDULED`.
3. The worker takes a recipient snapshot using the saved audience definition.
4. Every address is normalized and deduplicated. Active contacts with a valid email and no
   suppression entry receive a delivery row.
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

## URL validation and click tracking

Campaign button destinations must be absolute HTTP(S) URLs. For example,
`https://www.google.com` is valid while `www.google.com` is incomplete. The
editor reports an inline validation issue and keeps the rest of the page
available.

Click tracking has no campaign-level checkbox. It is enabled centrally under
the Resend domain configuration and applies consistently to campaigns sent from
that domain. When enabled, the provider rewrites eligible links through
`links.mail.omnicus.app`; signed webhook events populate the Omnicus Analytics
table and the linked CRM lead history.

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
- Consent metadata is retained for auditing but is not required for campaign eligibility.
- Every marketing email has `List-Unsubscribe` and `List-Unsubscribe-Post` headers plus a visible
  unsubscribe footer.
- GET shows a confirmation page. POST performs RFC 8058 one-click unsubscribe.
- Unsubscribe revokes contact consent, creates a suppression, and suppresses all queued deliveries
  for the same normalized address in the project.
- Complaint, bounce and provider suppression webhooks automatically add suppressions.
- Removing a suppression makes an otherwise active contact with a valid email eligible again.

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

`Save template` updates the mutable template draft. `Publish version` creates
an immutable version for campaigns and Automation Studio; publishing does not
delete or replace earlier versions.

## Audience rules

- `ALL_ACTIVE` starts from active contacts with a valid email.
- Selected-contact mode targets the explicit project contacts.
- Saved filters may include and exclude tags; the UI prevents the same tag from
  being selected in both lists.
- Addresses are normalized and deduplicated before delivery rows are created.
- A project suppression always wins. Stored email consent remains visible for
  audit but is not required by the current product eligibility rule.

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
3. Register a lead with an email and verify the automation delivery.
4. Create a small selected-contact campaign and inspect the audience estimate before launch.
5. Click a tracked link and verify `CLICKED` in the campaign delivery and CRM lead history.
6. Use the unsubscribe link and verify that a second campaign excludes the address.
7. Replay one Resend webhook and verify that it does not create a duplicate event.

Do not use a production-sized audience until this smoke test is complete.
