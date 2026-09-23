# Email Inbox

Status: implemented on `origin/main`, with completion fixes on 2026-09-17; user-approved scope (ADR-060).
Deployment and live acceptance are not verified. This is a Resend-backed Omnicus workspace, not
an IMAP/Gmail importer or a second automation engine.

## Product

The Email tab in `Project -> Communications` is an alternate contact-first
entry into these same mailboxes, threads, messages and APIs. It does not create
a second email store or bypass mailbox assignment, `email:*` permissions,
suppression, attachment or provider rules. See
[COMMUNICATIONS.md](COMMUNICATIONS.md).

Project sections → Email Inbox. Responsive folders/mailbox navigation, paginated
searchable threads and chronological reading/reply pane. Inbox, Sent, Starred,
Archived and private Drafts; per-user read/star/archive state; sender switcher;
manual compose/reply, attachments and graceful loading/empty/error states.
Existing Email & SMS Broadcast stays separate; campaign and automation messages
using configured mailboxes appear in the same history as their replies.

Inbox Settings contains domains, sender addresses, sending-only/two-way modes,
default sender and user assignments. Mail managers access all project mailboxes;
operators access shared/assigned mailboxes only. Drafts belong to their author.
Only a system administrator can attach an existing Resend-account domain to a
project; domain names/provider IDs cannot belong to multiple projects.
Legacy EMAIL_FROM continues to work without falsely claiming reply support.
Historical content/senders not previously retained cannot be reconstructed.

Reply-address update (2026-09-23, ADR-064): new two-way mailbox deliveries use the
selected mailbox's readable address as Reply-To (for example, `support@company.com`),
not a generated `reply+…` address. This applies to Inbox, Communications, CRM,
campaigns and automations through their shared sender. RFC Message-ID/In-Reply-To/
References identify the conversation; keep sending events including `email.sent`
enabled on the signed webhook so outgoing Message-IDs are recorded. Existing queued
delivery snapshots are immutable, and replies to older aliases remain supported
while that domain/mailbox still routes incoming mail here. Without matching RFC
headers, mail is a new conversation, never a subject/peer-based guess.

The desktop layout uses folders on the left, a conversation list in the middle
and a reader on the right. Mobile uses list/reader navigation. Threads show the
source (campaign, automation or manual), delivery status and downloadable files.
Search matches subject/address; list pages contain 30 threads, message pages 50.
Polling is every 15 seconds; the receive worker scans every 5 seconds.

Completion fixes (2026-09-17): draft saves accept an identical retry after a lost
response; draft deletion requires the displayed revision and cannot remove a newer
edit from another tab. A queued manual send can be reconciled with its original
request ID after the project/sender is paused, while new sends still require an
active project and ready sender. Legacy send retries retain the original Reply-To.
First incoming messages retain their received date and preview when imported later;
plain-text content is bounded just like HTML-derived text. Disabled/send-only
mailboxes do not occupy the reply/timeout processing batches.

Media readers can attach existing files; uploading additionally requires media
management permission. Filtered drafts show a matching count and empty state;
mailbox assignments display member names from the API contract. These fixes use
the existing schema and do not require a new migration. Joint module-by-module
live acceptance remains deferred at the user's request.

## Durability and security

- Signed `email.received` callbacks save bounded durable receipts; no provider
  requests inside webhook processing. Worker fetches full content/attachments.
- Exact configured recipient and project-scoped mailbox determine ownership.
  RFC Message-ID/In-Reply-To/References and legacy reply aliases identify threads;
  never group by subject alone. Sender must match thread peer to resume a wait.
- Automatic replies and delivery reports are visible but cannot resume scenarios.
  Email headers are not identity authentication or marketing consent.
- Existing EmailDelivery is the outbound queue. Store immutable sender/body/header
  snapshots. Retry the same delivery ID and exact payload only inside Resend's
  idempotency window. Stop at 23 hours or exhausted ambiguous attempts with
  UNKNOWN. A send request has a 30-second timeout; signed delivery events can
  still reconcile a later outcome. Suppressions also apply to manual mail.
- New mail processing respects project pause and disabled mailboxes. Tenant
  references have composite project foreign keys. Downloads enforce mailbox access.
- Bound attachments and provider responses. Fetch only provider-issued attachment
  URLs with public-address/redirect protection. Persist bytes privately, not expired
  provider links. Sanitize/isolate HTML; scripts/forms/remote tracking are disabled.
- Contact merge moves thread links to the survivor, without changing historical
  addresses. Private draft/outbound media references prevent premature retention.
  Inbound files are separate private objects, not project-wide Media Library assets.
- No actual live send, DNS change, paid subscription, live migration or deployment
  during local implementation. Git publication is a separate authorized release step.

## Automation

`WAIT_FOR_REPLY` gets an explicit Email channel, exact execution-thread routing,
Any/Text criteria and timeout branches. Use the existing graph/runtime. Handle
early replies durably; exclude unrelated threads/projects and automatic messages.
Telegram/WhatsApp semantics stay intact. Email received is an optional trigger.

To build a follow-up: use an existing contact trigger, then Send email with a
published template and a receiving-ready mailbox, then Wait for reply with
Reply channel = Email and Any/Text criteria. Connect reply and timeout branches.
Send email records the exact thread on the execution; a standalone email wait
without a thread is rejected. An Email received trigger specifies its mailbox.
Only unambiguously matched ACTIVE contacts with automation enabled can start or
continue a scenario. Unknown senders still appear in Inbox and allow manual replies;
receiving mail does not silently create a contact/CRM lead or grant marketing consent.

A campaign reply appears in its conversation. It does not automatically create a
scenario wait: use the Email received trigger for that mailbox, or initiate the
outbound message from the Send email → Wait for reply chain. Paused projects and
disabled mailboxes do not process continuations or new sends.

## Permissions and limits

- `email:read`: open shared/assigned mailboxes and download their messages/files.
- `email:send`: manual send, private drafts, and use a configured sender in
  campaigns/tests/published automations (in addition to existing campaign rights).
- `email:manage`: all mailboxes in this project, assignments, health and retries.
- Existing system Project Admin receives these permissions in the migration.
  Custom roles need explicit grants; no cross-project access is introduced.
- A default sender must be shared. Assigned mailboxes require active project members.
  Reassigning does not transfer another author's drafts. Disabling retains history.
- Manual correspondence is not exposed by the older broadcast delivery/analytics
  endpoints; campaign reporting retains its existing project-level role contract.
- Up to 20 attachments, 25 MiB raw total for inbox mail; executable/HTML/SVG
  inbound files remain visibly blocked. Downloads are authenticated attachments.
- Composer is plain text with a per-address signature, not a rich-text builder.
  Incoming formatted HTML is sanitized in a sandbox without scripts, remote images,
  clickable links or forms. Plain-text view is always available.
- No Gmail/Outlook login, IMAP import, CC/BCC or reply-all composer, forwarding UI,
  spam/trash classifier, full-text search, read receipt guarantees or email identity
  authentication. These are not implied by a Gmail-style layout.
- No automatic mailbox purge or S3 erasure. Archive is a per-user view action.
  Old test-data cleanup allowlists intentionally stop on the expanded schema and
  require a separate reviewed update before any future reset; do not bypass them.

## Provider setup and prices (checked 2026-09-15)

API needs RESEND_API_KEY for domain reads; worker uses it for send/receive.
Use a server-side key with the necessary read permissions, not a sending-only key.
RESEND_WEBHOOK_SECRET stays on API. Enable `email.received` on the existing
signed webhook, enable domain Receiving and add its exact MX record. Never
overwrite a working mail providers MX automatically: use a dedicated subdomain
or a separately verified forwarding setup when another mailbox service handles it.

Operator rollout (not performed by the local implementation):

1. Review/release API, worker and web together. Apply the additive migration
   `20260915010000_email_inbox` through the designated migration release service
   after normal database backup review. It does not delete existing contacts/mail.
   In Railway, verify Omnicus API → Settings → Deploy → Pre-deploy Command is
   `pnpm db:migrate:deploy`. This is documented as an operator-managed setting and
   is not declared in the repository's `apps/api/railway.toml`. Do not add it to
   worker/web or run the same migration concurrently elsewhere. Confirm this
   migration succeeds in API deployment logs before live testing.
2. Set `RESEND_API_KEY` on API and worker. Keep `RESEND_WEBHOOK_SECRET` on API.
   Preserve existing private S3 settings on both services and `API_PUBLIC_URL`
   on worker. Never expose keys through `VITE_*` or screenshots.
3. In the customer's Resend account choose the intended domain, enable Sending
   and Receiving, copy its DNS records, and verify them at the DNS provider.
   A dedicated subdomain avoids replacing an existing company's mailbox MX.
4. Subscribe the signed endpoint `https://api.omnicus.app/webhooks/resend` to
   `email.received` as well as the existing sending/delivery events. Use the
   actual API public origin if deploying somewhere else.
5. In Project → Email Inbox → Settings, a system administrator connects that
   existing Resend domain. Refresh status until sending and receiving are ready.
   Then add `sales`, `info`, etc. as TWO_WAY, and `no-reply` as SEND_ONLY if needed.
   Choose the shared default sender and assign any restricted addresses to members.
6. Give custom project roles the required email/media permissions. Confirm the
   project is ACTIVE before live testing; this implementation did not change its state.
7. Perform the live acceptance checklist below with the customer-approved addresses.
   No card is necessary just to use the UI; Resend quotas still govern actual delivery.

Published Free: $0, 3,000 emails/month, 100/day, 3 domains. Pro: $20/month,
50,000 emails/month, 10 domains, no daily cap, $0.90/1,000 additional emails.
Sending and receiving count toward usage. Check the current account before
enabling overages. No Omnicus credits, card collection or per-address Workspace
subscription. Prices are provider reference figures, not a billing guarantee.

Sources:

- https://resend.com/docs/dashboard/receiving/introduction
- https://resend.com/docs/dashboard/receiving/custom-domains
- https://resend.com/docs/dashboard/receiving/create-receiving-webhook
- https://resend.com/docs/dashboard/receiving/attachments
- https://resend.com/docs/dashboard/receiving/reply-to-emails
- https://resend.com/docs/api-reference/emails/retrieve-received-email
- https://resend.com/docs/api-reference/domains/get-domain
- https://resend.com/changelog/message-id-for-sent-emails
- https://resend.com/pricing

## Acceptance

### Interactive attachments (ADR-065)

Inbox, Conversations and the CRM lead email modal support multiple file selection,
drag/drop, compact filename/size cards, removal before sending, retryable upload
errors, authenticated downloads and raster image/PDF previews. Limits are 20 files,
20 MiB per upload (or the lower configured storage limit), 25 MiB combined. Uploads
use the existing email content validator: PDF, DOCX/XLSX/PPTX, ZIP, JPEG/PNG/WebP/GIF,
MP4/M4A/MP3/OGG; executable/HTML/SVG files remain unsupported. Preview is optional;
corrupt, encrypted or unsupported documents can still be downloaded when available.
No remote document viewer receives the file. PDF.js is lazy-loaded with a same-origin
module worker; `server.mjs` serves `.mjs` as JavaScript and permits `worker-src 'self'`.

Pending or failed uploads block sending/saving; remove failed files or retry first.
Discarding a compose aborts uploads and prevents late results joining a new message.
An ambiguous send locks the exact payload, including attachment IDs. Removing a
selection never deletes history/storage; normal unreferenced-asset retention applies.

CRM integration v1 additions (CRM staging front + back must be deployed together):

- `POST /integrations/v1/crm/email/attachments`: multipart `file`, `requestId`,
  `mailboxId` and the existing four CRM scope fields. Returns the safe MediaAsset DTO.
- `POST .../messages`: optional unique `assetIds` UUID array (maximum 20).
- `GET .../attachments/:attachmentId` and `GET .../messages/:messageId/assets/:assetId`:
  scope query, authenticated `application/octet-stream` attachment response.
- Thread messages expose additive `outgoingAttachments` metadata; existing
  `delivery.attachmentAssetIds` is unchanged. Missing assets are explicit unavailable
  cards. Legacy messages with stored asset references gain names without a backfill.

CRM browser uses the corresponding `/conversations/leads/:leadId/email` proxy.
Lead access and project route are resolved server-side; the browser cannot choose
`crmUserId`, `crmLeadId` or project scope. CRM uploads store the contact/user scope in
MediaAsset providerMetadata atomically, and send validates this scope. Downloads
check the contact-owned thread as well as shared mailbox and message/asset binding.
No database migration, DNS changes or new Resend events are required.

Automated: validation, mailbox/tenant isolation, signatures, duplicate and reordered
events, send idempotency/UNKNOWN, exact threading, drafts, safe HTML/attachments,
reply/timeout races and previous campaign/channel regressions; migrations,
responsive browser tests, lint/typecheck/unit/integration/build/Prisma validation.

Live after deployment: verified MX/webhook, two senders, manual send/reply/file,
campaign reply, Send email → Wait for reply → next step, timeout and second-user
permissions. These require the customer's configured Resend/domain and test address.
Also confirm a different customer/thread cannot release the wait and that a paused
project does not send. Browser mocks are not proof of live provider delivery.

## Troubleshooting

No incoming mail: check the exact recipient/mailbox mode, Receiving MX status,
Resend's webhook delivery log and the API signature secret. Unknown recipient
addresses are intentionally ignored. A disabled/paused route keeps durable receipts
but the worker does not import them until the route is active.

Settings → health lists failed imports and failed automation dispatches. After fixing
configuration, a manager can retry that receipt/dispatch with audit. Import retries
do not duplicate messages or file metadata. Do not keep retrying permanently blocked
attachments or malformed mail. UNKNOWN outbound requires provider reconciliation,
not a new send under a different ID; the UI does not offer a blind retry.
