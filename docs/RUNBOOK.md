# Omnicus operations runbook

Status reviewed: 2026-08-14 for the deployed Railway `main` environment.

## One-time production administrator bootstrap

The development/test seed remains blocked inside Railway and must never be
enabled by changing `APP_ENV` on a production database. A new empty Railway
database is initialized through the dedicated `pnpm db:bootstrap:admin`
command after migrations have succeeded.

The command requires all of the following API service variables:

- `ALLOW_PRODUCTION_ADMIN_BOOTSTRAP=true`;
- `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`,
  `BOOTSTRAP_ADMIN_FIRST_NAME`, and `BOOTSTRAP_ADMIN_LAST_NAME`;
- `BOOTSTRAP_DATABASE_NAME_CONFIRMATION`, exactly matching the database name in
  `DATABASE_URL`;
- `BOOTSTRAP_RAILWAY_PROJECT_NAME_CONFIRMATION`, exactly matching Railway's
  `RAILWAY_PROJECT_NAME`.

The password must contain at least 16 characters. The command is restricted to
an identified Railway service, takes a PostgreSQL advisory transaction lock,
refuses to elevate an existing unassigned user, creates the permissions,
system `Super Admin` role, user, assignment, and audit record atomically, and
does not reset the password when an already initialized matching administrator
is encountered.

For the one bootstrap deployment only, set the API pre-deploy command to:

```text
pnpm db:migrate:deploy && pnpm db:bootstrap:admin
```

After the successful deployment, immediately remove every `BOOTSTRAP_*`
variable and `ALLOW_PRODUCTION_ADMIN_BOOTSTRAP`, then restore the permanent
pre-deploy command to `pnpm db:migrate:deploy`. The administrative bootstrap
files are stripped from API and worker runtime artifacts.

## Automation continuations

Inspect `wait_states` with `status = 'ACTIVE'` and `delayed_actions` with
`status = 'PENDING'` when diagnosing paused executions. The worker scans due
records using `AUTOMATION_CONTINUATION_INTERVAL_MS`; restarting a worker does
not lose them because PostgreSQL is authoritative. Do not mutate continuation
rows manually: use the execution journal and a controlled operational retry
after diagnosing a dependency failure.

## Health probes

- web `/health/live`: static server process is accepting requests;
- API `/health/live`: API process is accepting requests;
- API `/health/ready`: PostgreSQL and Redis answer probes;
- worker `/health/live`: worker HTTP process is accepting requests;
- worker `/health/ready`: a BullMQ queue operation completes through Redis.

Readiness failure must remove a service from traffic; it must not trigger schema
changes or migration commands.

The System Health reset/acknowledge action is presentation-level only. Use it
after the underlying incident is resolved to clear the displayed stale
statistics baseline. It does not delete inbox, outbox, audit, execution or CRM
journal records and must not be used as a substitute for reconciliation.

## Browser session reloads

Production browser API traffic uses the web service's same-origin `/api` proxy.
`VITE_API_URL` remains the server-side upstream target and must resolve to the
public API origin. Login returns `{ token, user }`; the SPA stores that session
under `omnicus-auth` in `localStorage`, validates it through `/api/v1/auth/me`,
and restores it after a page reload.

If a reload unexpectedly returns to login, inspect `omnicus-auth` for a
well-formed token/user object and verify `/api/v1/auth/me`. A `401` deliberately
clears the stored session. Never paste a production JWT into an incident,
repository or logs.

## Graceful shutdown

API shutdown hooks close Prisma and Redis clients. Worker shutdown hooks stop the
BullMQ consumer before closing its queue connection. Railway should send the
normal termination signal and allow the process to exit before force termination.

## Local dependency recovery

```powershell
docker compose ps
docker compose logs postgres redis
docker compose restart postgres redis
```

After recovery, verify API and worker `/health/ready`.

## Database changes

Never use `prisma db push` against shared or production databases. Every schema
change requires:

1. successful `pnpm db:validate`;
2. reviewed generated SQL;
3. tenant constraint review against `docs/DATABASE.md`;
4. an explicit approval and migration report;
5. exactly one `pnpm db:migrate:deploy` release owner.

### Historical CRM contact-merge reconciliation

Deploy Cyber Pulse backend with `POST /integrations/v1/omnicus/contacts/merge`,
deploy the current Omnicus API/worker, and confirm migration
`20260808000000_crm_contact_merge` succeeded. Then open a shell for the Railway
**Omnicus worker** service and run a project-scoped preview:

```text
node .runtime/worker/dist/crm/contact-merge-backfill.cli.js --dry-run --project-id <omnicus-project-id>
```

Review `scanned`, `candidates`, `queued`, `alreadyQueued`, `conflicts` and
`failed`. Do not execute while either error collection is non-empty. Apply the
same bounded selection with:

```text
node .runtime/worker/dist/crm/contact-merge-backfill.cli.js --execute --project-id <omnicus-project-id>
```

Omitting `--execute` is always a dry run. `--batch-size` defaults to 50 and is
bounded to 1..500. Re-running is safe: each pair has one stable CRM outbox key;
existing successful work is reused and recoverable failed/unknown records are
returned to the ordinary reconciliation path. Confirm afterward that one CRM
lead remains and that its Telegram and WhatsApp histories both load.

## Backup restore

The accepted targets are RPO 24 hours and RTO 4 hours. Railway is deployed, so
backup/restore verification is an ongoing operational gate. Every drill must
record the backup identifier, isolated restore destination, timestamps,
integrity checks, measured RPO/RTO and cleanup confirmation. Never restore over
the active database as a test.

## Telegram inbound recovery and dead letters

`API_PUBLIC_URL` must be the exact public HTTPS origin of the API service.
Channel connect derives `/webhooks/telegram/<connectionId>` from this
server-owned value and never accepts a client-provided webhook base URL.

A valid Telegram webhook first commits `RawWebhookEvent` and a pending
`InboxRecord` to PostgreSQL. The subsequent BullMQ enqueue is best-effort. If
Redis is unavailable, Telegram still receives HTTP 200 and the pending inbox
record remains the source-of-truth recovery candidate. Do not replay the
provider request body or manually alter the raw event.

Worker recovery periodically queries a bounded batch of due `PENDING` and
`RETRY` records, plus `PROCESSING` records whose lease has expired. It adds a
job containing only `inboxRecordId`; BullMQ's stable
`telegram-inbound-<inboxRecordId>` job ID makes concurrent workers safe. An
enqueue failure only creates a safe `recovery_enqueue_failed` log event: the
PostgreSQL record remains due for the next scan.

Retryable processing errors clear the lease, store a safe error code and set a
capped exponential `nextAttemptAt` with bounded deterministic jitter. A
malformed payload, broken required relation, or exhausted `maxAttempts` becomes
`DEAD_LETTER`; the retained raw webhook event is never deleted by this flow.
Unsupported updates complete normally.

The Telegram channel detail page displays the latest 20 safe inbound records
from `GET /projects/:projectId/channels/:connectionId/inbound-events`: update
ID, correlation ID, inbox status, attempts, safe error code, normalized type
and resulting contact ID. The endpoint is project-scoped and requires
`channels:read`; it never selects raw payload or encrypted credentials.

For deeper operations, use the project **Operations & Audit** screen or its
permission-guarded `/api/v1/projects/:projectId/operations` and
`/api/v1/projects/:projectId/audit` APIs. They select bounded safe projections
only (up to the latest 500 rows per selected journal). Never log or copy raw
payloads, bot tokens, webhook secrets, ciphertext,
message content or contact PII into an incident ticket.

Manual retry is available only for eligible `FAILED`/`DEAD_LETTER` inbox rows
and `FAILED` Telegram outbox rows. It requires an operator reason, performs a
conditional state transition and records audit history. Immediate BullMQ
enqueue remains best-effort because the PostgreSQL recovery scan is
authoritative. `UNKNOWN` is never a retry action: record provider evidence as
**Applied** or **Not applied** through reconciliation first. Applied becomes
`SUCCEEDED`; confirmed not-applied permits one durable `RETRY` transition.

On worker crash, an active lease is left untouched until its configured expiry;
then recovery atomically releases it for retry. Lease-token conditional updates
prevent a late pre-crash worker from completing or releasing a newer claim.

## Telegram outbound recovery

The worker scans due `outbox_records` in `PENDING` or `RETRY`, plus expired
`PROCESSING` leases, and re-enqueues a stable `telegram-outbound-<outboxId>` job.
If Redis is unavailable after the database transaction commits, the record stays
recoverable and delivery is not lost. `UNKNOWN` delivery is terminal: reconcile
the provider outcome before any manual resend, because a timeout can occur after
Telegram accepted the request. Do not expose, log, or copy channel credentials
while investigating a record.

## WhatsApp Cloud API recovery

WhatsApp uses separate `whatsapp-inbound` and `whatsapp-outbound` BullMQ queues,
but PostgreSQL `InboxRecord` and `OutboxRecord` rows remain authoritative. The
worker recovery scans re-enqueue due or expired-leased rows by stable record ID.
Never create a second send to compensate for a missing queue job.

For inbound incidents, first confirm that Meta reached the app-level
`/webhooks/whatsapp` callback. An invalid `X-Hub-Signature-256` intentionally
creates no raw or inbox record. A valid event for an unknown or disabled
WABA/phone route is acknowledged and ignored rather than assigned to a guessed
project. Do not paste raw webhook content into support notes.

For outbound incidents, `SENT` means Meta returned a `wamid`; only webhook
evidence advances the same message to `DELIVERED` or `READ`. Delivery statuses
are monotonic, and duplicate/out-of-order events are safe. A transport timeout
after a possible provider call is `UNKNOWN` and must not be resent blindly.

For a failed WhatsApp schedule, first compare `scheduledAt` with the persisted
`serviceWindowExpiresAt`. The flow is one-shot text only; recurrence or media is
a validation failure. If the window expired before worker claim, the safe
failure is expected and no provider request occurred. Do not convert or resend
it automatically as a template.
Use the stable outbox/message identifiers and provider evidence for
reconciliation.

The persisted customer service window comes only from an authoritative inbound
user message. If free-form delivery is rejected as template-required, sync the
connection's Meta templates and select an `APPROVED` template; do not alter the
timestamp or bypass the worker check. Mark-as-read, media upload/download,
reactions and template sends are also project/connection-scoped durable side
effects.

Disabling one WhatsApp phone is a local routing action. Do not manually remove
the WABA app subscription while another phone under that WABA is active. Meta
app secrets, verify tokens, phone registration PINs and access tokens must not
appear in logs, audit JSON, browser storage or CRM responses. The complete
provider setup and live acceptance procedure is in
[WHATSAPP_CLOUD_API.md](WHATSAPP_CLOUD_API.md).

## Telegram broadcasts

Telegram broadcasts persist an immutable recipient snapshot before they create
individual outbound `Message` and `OutboxRecord` rows. The worker prepares due
`SCHEDULED` broadcasts and leased `PREPARING` broadcasts in bounded batches;
the preparation lease makes concurrent worker replicas safe. A Redis failure
after the database commit does not lose recipients: the existing outbox
recovery scan re-enqueues their stable jobs.

Use the broadcast status and recipient status journal for investigation. Do
not modify recipient rows directly. Pausing prevents a queued record from
calling Telegram; cancelling cancels unsent recipients. A provider result that
is `UNKNOWN` is not automatically resent, because Telegram may have accepted
the message before a network timeout. Retry only an explicitly failed
recipient through the audited broadcast operation after confirming the target
is eligible.

## CRM outbox and reconciliation

The production Cyber Pulse adapter supersedes the mock when
`CRM_INTEGRATION_ENABLED=true`. Required variables and the reviewed endpoint
contract are in `docs/CRM_INTEGRATION.md`. With the flag disabled the worker
does not scan CRM outbox rows and no external call is attempted.

For a CRM operation in `UNKNOWN`, query Cyber Pulse reconciliation by the same
idempotency key before any manual retry. Never infer failure from a timeout.
The operator journal requires explicit confirmation before requeuing an
unknown operation.

CRM-to-Omnicus requests create the Telegram message and outbox intent in one
PostgreSQL transaction. A Redis outage may prevent immediate enqueue but does
not lose the intent; Telegram outbound recovery picks it up. A `200 QUEUED`
response is not evidence of Telegram delivery. Cyber Pulse must poll
`GET /integrations/v1/crm/operations/{operationId}` until a terminal state.

CRM operations use the same PostgreSQL-backed outbox principle. The worker
polls bounded due CRM records in `PENDING` or `RETRY`; a Redis outage cannot
discard a committed CRM intent because the record stays eligible for the next
worker scan. The real service credential remains environment-only.

Inspect the project CRM operation journal for `SUCCEEDED`, `RETRY`, `FAILED`,
or `UNKNOWN` state and safe error codes only. A failed operation may be retried
from the journal. An `UNKNOWN` operation requires explicit confirmation because
the provider might already have applied the request; confirm provider state
before requeueing it. The retry resets a new attempt group, is audited, and
never exposes request payload, credentials, or provider raw errors.

For a real CRM, use the reconciliation contract in
`docs/CRM_CONTRACT_REQUIRED.md`; never infer delivery from a timeout alone.

### Pair a CRM without project-specific Railway variables

Railway keeps only platform switches and master encryption keys. Each external
CRM tenant is connected from the applications:

1. In the Omnicus project, open CRM integration, save the external
   `crmProjectId`, and generate a pairing code.
2. Within ten minutes, open the CRM Integrations screen and submit its Omnicus
   API origin, the code, and the same `crmProjectId`.
3. Both backends exchange independent random service credentials. Omnicus
   encrypts the CRM credential with `CHANNEL_SECRETS_KEY`; Cyber Pulse encrypts
   its Omnicus credential with the installation-wide
   `INTEGRATION_SECRETS_KEY`. Only inbound token hashes are searchable.
4. Run **Test connection** from either screen. An active result must contain
   only safe project and lifecycle metadata.

The code is single-use and expires after ten minutes. If the CRM loses the
successful response before persisting it, generate a new code; do not attempt to
recover credentials from logs or the database. Disabling a connection stops
new service authentication but does not delete contacts, messages, operations,
or audit records.

Each external `(provider, crmProjectId)` can belong to only one Omnicus project.
To move a CRM tenant, disable the old connection and perform a controlled
re-pairing after confirming that no old worker is still dispatching operations.
Legacy `CRM_BASE_URL`, `CRM_AUTH_TOKEN`, and `CRM_INBOUND_AUTH_TOKEN` values are
temporary fallback inputs only and must not be copied when onboarding another
project.

## Telegram media and template assets

`MediaAsset` is the lifecycle source of truth. Inbound Telegram photo/document
events initially store only `file_id`, safe metadata and
`PROVIDER_REFERENCE`; an operator materializes the object only when a template
or durable asset needs it. The API calls `getFile`, enforces the 20 MB
application limit, checks magic bytes, MIME and extension, and only then writes
to the private S3-compatible bucket. Provider and bucket credentials must never
be copied into an incident, database query output or browser state.

`AVAILABLE` objects receive signed URLs only on demand. URLs are short-lived and
must not be persisted. The worker scans bounded expired assets according to
`MEDIA_RETENTION_INTERVAL_MS` and `MEDIA_RETENTION_BATCH_SIZE`; assets referenced
by `PUBLISHED` or `SUPERSEDED` template versions are retained. A bucket outage
does not delete the PostgreSQL record: failed upload/materialization/delete
operations remain visible through safe lifecycle status and can be retried
after storage recovery.

Staging and production require `MEDIA_STORAGE_ENABLED=true` plus
`MEDIA_BUCKET`, `MEDIA_BUCKET_ENDPOINT`, `MEDIA_BUCKET_REGION`,
`MEDIA_BUCKET_ACCESS_KEY_ID`, and `MEDIA_BUCKET_SECRET_ACCESS_KEY`. The endpoint
must be HTTPS outside local development. Railway Bucket is authenticated object
storage, not a private network; this runbook does not assume native lifecycle,
versioning or server-side encryption features.

### Telegram interactive media and CRM history

CRM uploads outbound media to the authenticated Omnicus multipart endpoint and
receives a project-bound `mediaAssetId`. It must use that ID in the outbound
message request and must not provide an arbitrary remote URL. Replaying the same
upload idempotency key with different bytes or a different media kind is a
conflict.

Inbound Telegram media is materialized only when CRM forwarding needs the
bytes. Omnicus validates and stores the object, then generates a short-lived
signed URL for immediate CRM ingestion. The URL must never be stored in CRM,
logs or audit data. If materialization fails, the CRM operation follows normal
retry/permanent classification while the original provider reference remains
visible in PostgreSQL.

Callback acknowledgement is a Telegram outbox action. If Redis is unavailable,
the stable outbox record remains recoverable; webhook acknowledgement and
automation processing do not wait for Telegram.

After a lead is first created, the CRM worker schedules a bounded set of earlier
inbound messages with `crm-history-<messageId>` keys. Repeated lead updates do
not create duplicate history. Investigate history failures through the same CRM
operation journal; never re-import messages manually without checking the
stable message ID and provider result.

For an already linked contact, every new normalized inbound Telegram message
creates that stable CRM history intent inside the inbound transaction; it does
not wait for a `Forward to CRM` scenario node. If automation runs as well, the
normalized event is reused and no second CRM delivery is created. Inbound reply
references are Omnicus UUIDs resolved within the same conversation; a missing
preview in CRM must be diagnosed by the source-message mapping, not by retrying
the customer message.

### Telegram Chat v3 operations

CRM message edit/delete/reaction/pin requests create ordinary Telegram
`OutboxRecord` rows. Inspect `status`, `attempts`, `nextAttemptAt` and the safe
`lastError` code exactly as for outbound messages. A Redis outage after commit
does not lose the operation; the existing Telegram outbound recovery scan
re-enqueues it by stable outbox ID.

Only a terminal `FAILED` operation may use
`POST /integrations/v1/crm/operations/{operationId}/retry`. The caller supplies
a new stable retry request ID, creating at most one descendant attempt. Never
retry `UNKNOWN`: first reconcile the original operation, because Telegram may
already have applied the mutation.

Chat actions and draft previews are intentionally absent from PostgreSQL. A
failed typing indicator can be ignored. A draft preview expires after about 30
seconds and the final text must always be sent through the durable outbound
message endpoint. Capability discovery is scoped to the CRM project,
connection and optional identity; clients must not enable a feature when its
capability is absent or false.

An empty draft update is ignored by both the API service and Telegram adapter:
Bot API treats empty text as a Thinking placeholder (`...`) and provides no
explicit cancellation method. Final outbound delivery completes the user flow,
while Telegram expires the ephemeral preview automatically.

Inbound reaction events are visible as `NormalizedEvent.type = REACTION` and,
when CRM integration is active, as `CrmOperation.type =
FORWARD_REACTION_EVENT`. `telegram_inbound_reaction_target_pending` means the
reaction arrived before the target message mapping and will be retried. A
terminal identity mismatch is stored only as the safe code
`telegram_inbound_reaction_identity_mismatch`.

Existing Telegram connections must run **Connect webhook** once after the
reaction-event release. This re-registers the webhook with
`message_reaction` in `allowed_updates`; rotating secrets is not required.
New connections include this update type automatically.

### Telegram stickers and media spoilers

Contract 3.1.0 treats a sticker as a typed `MediaAsset` and `Message`, not as a
document with UI-only metadata. Static WEBP is limited to 512 KiB and must have
one 512-pixel side; animated TGS is limited to 64 KiB; video WEBM is limited to
256 KiB. Validation rejects MIME/extension/signature mismatches before an
outbox operation is created. Telegram remains the final validator for the full
TGS/VP9 encoding profile.

Spoilers are accepted only for PHOTO, VIDEO and ANIMATION. A safe
`CRM_MEDIA_SPOILER_UNSUPPORTED` or `telegram_media_spoiler_not_supported` code
indicates that the caller used another kind. Stickers never accept captions.
Do not diagnose failures by logging file bytes, captions or provider payloads.

Inbound `mediaGroupId` is grouping metadata. Outbound albums are supported only
through the v3.2 durable media-group aggregate; multiple independent sends do
not have Telegram album atomicity or reconciliation semantics.

## External HTTP automation recovery

External HTTP nodes persist `ExternalHttpOperation` and a matching HTTP outbox
intent before any network call. Inspect the execution ID, node ID, operation
status, attempt count, lease and safe error code. Do not copy rendered URLs,
headers, request/response bodies or project secret values into an incident.

Safe terminal failures may follow the configured failure branch. A timeout or
ambiguous transport result is `UNKNOWN` and must not be retried blindly. First
determine whether the remote service supports reconciliation using the stable
idempotency key; otherwise require an audited operator decision.

If DNS, redirect or SSRF validation fails, fix the scenario target rather than
relaxing network policy. Private, loopback, link-local and cloud metadata
addresses are intentionally blocked. Rotating a project secret creates a new
write-only value; old values must not be recovered from logs or operation
metadata.

## Automation Activity diagnostics

Automation Activity is a read-only project view over durable execution
journals. A missing journey should first be checked against the selected
7/30/90-day period, status, automation and contact search filters. The table is
paginated and exact summary counts come from PostgreSQL.

Trend and drop-off charts use at most the latest 2,000 matching executions. The
UI labels a sampled chart; do not treat a sampled daily bar as an exact export.
Use the journey drawer for the safe step timeline and the existing Automation
execution diagnostics or Operations Center for deeper recovery work. Never add
variables, normalized event payloads, node input/output, message content or
provider errors to the Board to diagnose an incident.

## Public lead capture recovery

Confirm that migration `20260814000000_lead_capture_tracking` is applied before
investigating worker failures. Use the project Operations Center and the safe
`LeadCaptureEvent` status, source key, attempt/lease and contact reference. Do
not log the `X-Omnicus-Ingest-Key` or full registration body.

- `401/403`: rotate or recopy the project/source ingest key and keep it on the
  website backend only.
- Missing `Idempotency-Key`: fix the caller. Do not synthesize one in a proxy.
- Idempotency conflict: the caller reused one key for another payload; generate
  a new key for the new registration.
- `PENDING/PROCESSING` after a worker restart: confirm worker readiness and let
  the expired lease recovery scan reclaim it.
- Contact exists but CRM lead is missing: inspect the contact's CRM outbox and
  reconcile by stable operation key before retrying.
- Contact/lead exists but no automation ran: confirm that a published scenario
  has `WEBSITE_REGISTRATION` with the exact same `sourceKey`. A draft does not
  run.

## Tracked-link recovery

Tracked redirect tokens are opaque and must not contain PII. A `HEAD` request
may resolve the target without recording a click; a browser `GET` records the
click and redirects. Duplicate CRM forwarding is safe by tracked-link/event
identity. If the Omnicus timeline has the click but CRM does not, inspect the
CRM outbox and the project-scoped contact link rather than replaying the public
URL manually.

## Email and Resend recovery

Confirm migration `20260814030000_email_campaigns`, worker
`RESEND_API_KEY`/sender variables, API `RESEND_WEBHOOK_SECRET`, verified sending
domain and webhook subscriptions. Never paste these values into an incident.

- Campaign stuck in `SCHEDULED`: compare the project timezone and saved UTC
  launch time, then check worker readiness.
- Campaign stuck in `PREPARING`: inspect recipient snapshot attempts and lease;
  do not launch it again under a new campaign ID.
- Delivery stuck in `PROCESSING`: wait for lease expiry/recovery and reconcile
  using the stable Resend idempotency/provider email ID.
- `FAILED`: use the safe error classification. Retry only confirmed retryable
  failures through the campaign action.
- `SUPPRESSED`: inspect the project suppression reason. Removing it is an
  operator policy decision and does not resend an old terminal delivery.
- Missing delivery/click event: verify the Resend webhook endpoint
  `https://api.omnicus.app/webhooks/resend`, signing secret and event
  subscriptions. Replayed valid webhook IDs are intentionally no-ops.
- Email event visible in Omnicus but absent from CRM: reconcile the email CRM
  outbox after confirming the contact-to-lead link.

Cancel/pause stops new claims but cannot recall a provider request already
accepted. `SENT` is not `DELIVERED`; clicks and other later statuses require
signed provider evidence.
