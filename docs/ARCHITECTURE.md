# Omnicus architecture

Status reviewed: 2026-09-17.

## Runtime topology

Email Inbox (ADR-060, local implementation 2026-09-15) uses the same services:
API authenticates signed receiving events and saves receipts; worker imports
bounded mail/attachments and dispatches continuations; web renders an isolated
sanitized reader. `email-core` provides provider validation, while its `/server`
export provides the fixed-origin Resend read client. The database helper links
queued EmailDelivery and EmailMessage atomically. No second mail server, queue
authority or automation engine is introduced. See [EMAIL_INBOX.md](EMAIL_INBOX.md).

Omnicus is a pnpm/Turborepo monorepo deployed to Railway as three services:

- `apps/web`: React/Vite SPA plus a hardened Node static server and same-origin
  `/api` reverse proxy;
- `apps/api`: NestJS API, authenticated management endpoints, public
  lead/redirect/unsubscribe routes, CRM service API and signed provider
  webhooks;
- `apps/worker`: BullMQ consumers for channel, CRM, lead-capture, automation and
  email work plus a small readiness/liveness HTTP server.

Shared business boundaries live in packages. Applications import public
package exports and never another application's source. Important packages are
`database`, `contracts`, `automation-core`, `automation-http`,
`channel-telegram`, `channel-whatsapp`, `crm-core`, `media-core` and
`email-core`.

## Unified communications boundary

`apps/web` exposes one project-scoped Communications route, but the backend is
a facade over existing domain services rather than a new provider runtime.
Contact discovery and normalized channel history come from PostgreSQL. Telegram
and WhatsApp sends enter the same durable channel outbox and validation paths
used by CRM; Email opens the existing mailbox/thread boundary. The facade adds
no second conversation/message tables and does not import Cyber Pulse frontend
components. Read/send permissions are independent, while Email and media retain
their stricter resource permissions.

The facade may create a missing WhatsApp identity only for an active contact,
active connection, granted consent and a normalized phone that is not already
owned by another contact on that connection. Official Meta templates remain
connection-scoped provider projections. Free-form service-window checks,
reachability, blocked status and project isolation are not UI decisions and
are repeated by the service layer. See [COMMUNICATIONS.md](COMMUNICATIONS.md)
and ADR-062.

## Durable processing model

PostgreSQL is authoritative. Redis/BullMQ accelerates execution and may be
reconstructed from committed records. External processing is at-least-once:

```text
provider/web/API request
  -> PostgreSQL inbox or durable intent
  -> recoverable BullMQ job
  -> normalized domain mutation
  -> PostgreSQL outbox operation
  -> provider/CRM/HTTPS side effect
  -> SUCCEEDED | FAILED | UNKNOWN
```

Stable idempotency keys prevent duplicate logical effects. A confirmed safe
failure may retry according to policy. `UNKNOWN` is never retried blindly and
requires reconciliation or an audited operator decision.

Telegram and WhatsApp webhooks acknowledge after durable inbox commit and do
not wait for automation, CRM or outbound delivery. WhatsApp verifies the exact
request bytes with the global Meta app secret before it resolves a tenant from
the WABA and phone-number identifiers. A multi-account envelope is split into
one connection-owned raw/inbox item per message or status before persistence.
Scenario waits, delays, schedules and external HTTP continuations are stored in
PostgreSQL, so worker restarts do not lose them.

## Public lead capture and attribution

An authenticated operator configures a `WEBSITE_REGISTRATION` trigger and
receives a project/source-specific public endpoint plus a derived ingest key.
The website backend must also provide a caller-owned `Idempotency-Key`. The API
normalizes email/phone, serializes concurrent duplicate registration attempts,
creates or updates one contact and persists a `LeadCaptureEvent` in the same
durable flow. The worker then starts matching published scenarios and the CRM
lead projection independently; an accepted HTTP request does not claim that
either downstream side effect is complete.

Tracked message links use opaque tokens with a stored project/contact/scenario
target. Redirect handling records an idempotent click before forwarding the
browser to the original HTTP(S) URL. The CRM receives only normalized click
context and the target URL, never an ingest secret or scenario variables.

## Tenant and secret boundaries

Every tenant-owned record carries `projectId`. Composite database relations and
application guards prevent cross-project contact, channel, scenario, message
and operation references.

Server and browser configuration use separate package exports. Browser bundles
accept only reviewed `VITE_*` values. Telegram tokens, WhatsApp access tokens,
CRM credentials and project HTTP secrets are encrypted or one-way hashed as
appropriate, never returned after creation, and excluded from logs, audit
metadata and runtime artifacts. The Meta app secret and webhook verify token
are application-level server configuration; only the public app/configuration
IDs needed by Embedded Signup may cross the authenticated setup boundary.

CRM inbound and outbound credentials are independent. Provider payloads pass
runtime validation and are normalized before business logic sees them.

## Cross-system contact lifecycle

Omnicus owns contact/channel identity and Cyber Pulse owns the operational lead
projection. Editing a linked contact creates a durable CRM upsert for the same
lead. An explicit project-scoped merge moves Omnicus conversations, messages,
identities and dependent records to the selected primary contact and queues one
idempotent CRM merge. CRM keeps one surviving lead and reparents both Telegram
and WhatsApp histories before removing the redundant lead.

The reverse profile path is deliberately asymmetric. Cyber Pulse lead
create/update/archive/restore writes one latest-state MongoDB delivery record
per lead and calls the authenticated Omnicus contact-upsert endpoint. Omnicus
matches only `(projectId, crmLeadId)`, applies a snapshot only when its CRM
`updatedAt` is not older than `Contact.crmSourceUpdatedAt`, and records a safe
idempotent result. It does not echo the update through the Omnicus-to-CRM outbox.
This prevents loops while allowing either product to originate an explicit
profile edit. CRM lifecycle changes cannot erase Omnicus `BLOCKED` or
`UNSUBSCRIBED` policy state. See [CRM_CONTACT_SYNC.md](CRM_CONTACT_SYNC.md) and
ADR-063.

Merge is never inferred from a matching name, email, phone or username. Earlier
merges are reconciled by a bounded idempotent worker CLI after the reviewed
database migration; PostgreSQL outbox state remains the recovery authority.

## WhatsApp provider boundary

WhatsApp uses the official Meta-hosted Cloud API only. Every connection stores
an explicit Graph API version and safe WABA/phone-number identifiers; Omnicus
does not infer a version from provider examples. New Embedded Signup numbers
are validated against their WABA, registered with a write-only six-digit PIN,
subscribed to the app and only then activated.

The last authoritative inbound user message advances the persisted customer
service window. Free-form text, media and interactive messages re-check that
window immediately before the provider call. An approved connection-scoped
Meta template is required outside the window. Delivery callbacks are
idempotent and monotonic: accepted/SENT evidence cannot claim DELIVERED or READ,
and an older callback cannot regress a newer status.

Application-owned WhatsApp scheduling is one-shot text only. Creation requires
an open service window and a scheduled time no later than its current expiry;
the worker repeats the window guard immediately before the provider call.
Telegram scheduling remains the only recurring DAILY/WEEKLY implementation.

### WhatsApp management extension (2026-09-10)

Native Meta template authoring, review samples, health and billing reads use
project-scoped API routes and existing encrypted connection credentials. The
UI never owns Meta secrets. Same-WABA template updates stay project-scoped
locally and do not rewrite prepared broadcast snapshots or message history.
Provider template status, Omnicus channel status and past delivery errors are
independent facts. Unknown costs/currency cannot become a zero-cost claim.

Payments remain direct to Meta: Omnicus provides instructions/navigation and
reporting, not a wallet, card vault, credit line or checkout. Broadcast
list-rate estimates and webhook paid/free facts are separate from Meta's final
invoice. See [WHATSAPP_MANAGEMENT.md](WHATSAPP_MANAGEMENT.md) and ADR-058 in
[DECISIONS.md](DECISIONS.md).

## Email delivery boundary

Email is a separate provider path and is not represented as a chat channel.
The API owns campaign/template authoring, audience estimation, launch control,
suppression management, unsubscribe pages and signed Resend webhooks. The
worker owns recipient snapshotting, per-contact rendering, S3 media loading,
Resend calls, bounded retry and lease recovery. PostgreSQL models campaign,
delivery and event state; Redis is only a wake-up mechanism.

Recipient addresses are normalized and deduplicated per campaign. The current
eligibility rule is active contact plus valid email plus no project
suppression. Provider callbacks are deduplicated and monotonic, and their safe
lifecycle projections are forwarded through the CRM outbox. Inline images use
CID references; attachment bytes are loaded only when a delivery is claimed.

## Automation and external HTTP

Published scenario versions are immutable. Editing produces a draft version;
drafts may be incomplete or disconnected, while publish and test execution
remain strict.

External HTTP nodes create durable HTTP outbox operations. Only HTTPS is
accepted. DNS results and every redirect are validated and pinned; private,
loopback, link-local and cloud metadata targets are blocked. Request/response
limits are bounded, project secrets are write-only, and raw bodies, rendered
URLs and secret values are absent from technical metadata.

## HTTP and health model

The API applies correlation IDs, exact-origin CORS, reviewed proxy trust,
security headers, runtime DTO validation and a stable safe error envelope. The
web server rejects malformed paths, applies CSP and distinguishes missing
assets from SPA routes.

| Process | Liveness                | Readiness                              |
| ------- | ----------------------- | -------------------------------------- |
| Web     | HTTP process responds   | built assets are present               |
| API     | NestJS process responds | PostgreSQL and Redis probes pass       |
| Worker  | health server responds  | BullMQ producer and consumer are ready |

Shutdown stops HTTP intake, consumers and connections in a bounded order.

## Production artifacts

`pnpm build` emits `.runtime/web`, `.runtime/api` and `.runtime/worker`.
Production artifacts exclude source maps, test/build tooling, Prisma CLI and
secret-bearing source configuration. Railway builds each service from the same
lockfile and applies migrations only through the designated API pre-deploy
step. See [RAILWAY.md](RAILWAY.md) and [RUNBOOK.md](RUNBOOK.md).
