# Cyber Pulse CRM integration

Status reviewed: 2026-08-14. Telegram Chat v3.3 is implemented and its core
live acceptance is complete. Channel-aware contract 4.0.0 adds WhatsApp Cloud
API in both directions. The connected WhatsApp test route has passed
open-window automation, interactive reply and CRM-history checks; approved
outside-window templates and production volume remain external gates.

## Verified contract

The checked-in OpenAPI files are the authoritative integration boundary:

- `docs/OMNICUS_TO_CRM_OPENAPI.yaml` mirrors the version-controlled Cyber
  Pulse inbound contract;
- `docs/OMNICUS_CRM_OUTBOUND_OPENAPI.yaml` defines CRM calls into Omnicus;
- both directions use contract 4.0.0 for WhatsApp while preserving Telegram
  v3 compatibility where the channel field was historically omitted.

Omnicus calls only these CRM endpoints:

```text
POST /integrations/v1/omnicus/leads/upsert
POST /integrations/v1/omnicus/messages/inbound
POST /integrations/v1/omnicus/messages/outbound
POST /integrations/v1/omnicus/messages/status
POST /integrations/v1/omnicus/reactions/inbound
POST /integrations/v1/omnicus/messages/edited
POST /integrations/v1/omnicus/contacts/shared
POST /integrations/v1/omnicus/contacts/merge
POST /integrations/v1/omnicus/conversations/automation-state
POST /integrations/v1/omnicus/tracking/clicked
POST /integrations/v1/omnicus/email/events
GET  /integrations/v1/omnicus/operations?crmProjectId=...&idempotencyKey=...
```

The exact normalized inbound message extension is documented in
`docs/OMNICUS_TO_CRM_OPENAPI.yaml`. It preserves the provider-independent
category in `media.type`, the exact channel media kind in `media.kind`, and
provider-neutral callback choices in `interactive`. Contract 3.2.3 also
carries an optional normalized
`replyToMessageId`, which is an Omnicus UUID resolved inside the same project,
connection and conversation rather than a Telegram provider ID.

CRM implementation and deployment requirements for outbound history are in
`docs/CRM_OUTBOUND_HISTORY_HANDOFF.md`.

Every request uses service Bearer authentication and a correlation ID. Mutating
requests also include the durable Omnicus outbox ID as `Idempotency-Key`.

The adapter sends normalized Omnicus data, never Telegram/Meta webhook payloads,
provider credentials or encrypted secret envelopes. When an inbound channel
file can be materialized, `media.downloadUrl` is a private signed URL with a
short expiry. It exists only in the outbound request and is never persisted by
Omnicus. CRM must download it immediately and store its own copy.

Automation, broadcast and other Omnicus-originated messages are sent to the
outbound history endpoint only after the channel worker confirms `SENT`.
CRM-originated messages are not echoed back. The history operation carries the
stable Omnicus message UUID and opaque provider message ID, allowing a
callback that arrived first to resolve its `sourceMessageId` later. Channel
delivery success is not rolled back if CRM history synchronization is delayed.
History creation and recovery additionally require a matching `SUCCEEDED`
channel outbox. Telegram provider IDs are positive decimal `message_id`
values; WhatsApp provider IDs are opaque strings. Synthetic E2E identifiers
are never published as customer-visible history.

## Direction: Omnicus to CRM

The worker is enabled with:

```text
CRM_INTEGRATION_ENABLED=true
```

New CRM connections are paired per project from the application UI. Pairing
stores the exact CRM origin and an encrypted project-scoped credential in
`CrmProjectConfig`; neither secret is exposed to the browser after the
exchange. `CRM_BASE_URL` and `CRM_AUTH_TOKEN` are bounded compatibility inputs
for connections created before ADR-038 and must not be used for new projects.

The PostgreSQL outbox remains the source of truth. A request timeout is
reconciled by idempotency key. If reconciliation cannot determine the result,
the outbox becomes `UNKNOWN`; it is not blindly retried.

An edit to a CRM-linked contact creates a new `CREATE_OR_UPDATE_LEAD` outbox
intent keyed by the contact and its update timestamp. Cyber Pulse resolves the
existing project-scoped contact link and updates that lead's name, email and
phone without fuzzy matching or duplicate creation.

Explicit Omnicus merge creates one `MERGE_CONTACTS` operation. The CRM callback
receives both Omnicus contact IDs and optional known CRM lead IDs, selects one
survivor inside the mapped project, reparents contact links and Telegram/
WhatsApp conversation history, then removes the redundant lead. Stable
idempotency makes replay a no-op. Pre-contract merges use the runbook's bounded
backfill after migration `20260808000000_crm_contact_merge` is deployed.

Inbound history delivery is application-owned and does not depend on an
automation node. A linked contact receives a transactional per-message CRM
intent immediately. For an unlinked contact Omnicus queues one stable lead
bootstrap operation and uses the existing bounded history backfill after the
link succeeds. A published `Forward to CRM` node cannot create a duplicate for
the normalized event.

Tracked automation links and email lifecycle events use their own idempotent
CRM operations. A click carries the linked contact, scenario execution, node,
target URL and occurrence time. Email events carry the delivery/event IDs,
source, subject, recipient and optional campaign/automation/target URL context.
Both resolve the existing project-scoped contact link and add a human-readable
lead-history entry. If the link is not ready, CRM returns a retryable pending
result and the Omnicus CRM outbox remains authoritative.

## Direction: CRM to Omnicus

Cyber Pulse calls the contract in
`docs/OMNICUS_CRM_OUTBOUND_OPENAPI.yaml`. This direction uses an independent
credential:

```text
CRM_INBOUND_ENABLED=true
CRM_INBOUND_AUTH_TOKEN=<different random service token>
```

New pairings generate a separate inbound token for every project and store only
its SHA-256 hash. `CRM_INBOUND_AUTH_TOKEN` remains a bounded compatibility
credential for the already deployed legacy connection.

The API validates the configured `crmProjectId` to `omnicusProjectId` mapping,
contact, channel identity and connection before creating a channel-specific
`Message`/`OutboxRecord` transaction. Redis enqueue failure does not remove the
PostgreSQL intent. The matching Telegram or WhatsApp recovery worker eventually
enqueues it.

The create response means `QUEUED`, not `SENT`. Cyber Pulse reconciles the
operation endpoint before displaying a delivery result.

The machine-readable credential exchange is documented in
[`CRM_PAIRING_OPENAPI.yaml`](CRM_PAIRING_OPENAPI.yaml).

CRM uploads outbound files first through
`POST /integrations/v1/crm/media`, then references the returned
`mediaAssetId` from `POST /integrations/v1/crm/messages/outbound`. Replies use
an Omnicus message UUID, never a provider message ID. Inline keyboard
callbacks are provider-independent `{text, callbackData}` values.

The version 3 extension adds capability discovery, formatted entities, quote
and link-preview options, protected content, message effects, durable
edit/delete/reaction/pin operations, explicit retry after terminal `FAILED`,
ephemeral chat actions and 30-second streaming draft previews. The exact
contract is the same versioned OpenAPI document. Draft previews never create a
message and must be finalized through the ordinary outbound endpoint.
Capability discovery explicitly exposes `quote`, `linkPreviewOptions` and
`explicitRetry`; their request fields or retry path must not be used when the
corresponding capability is absent or false.

Telegram user reactions are normalized as standalone `REACTION` events and
forwarded through a transactional CRM outbox to the versioned endpoint in
`OMNICUS_TO_CRM_OPENAPI.yaml`. They do not create synthetic messages. A
reaction received before its target message is available remains retryable.
The paired CRM deployment is live-verified. Connection-scoped capability
discovery advertises `userReactionEvents.supported=true`; duplicate events are
idempotent, reaction-before-source is reconciled onto the source bubble and
incorrect project/contact/connection routing is rejected.

Bot API 10.2 does not expose a bot method for discovering available message
effects. Capability discovery therefore publishes an empty
`availableEffects` list with `BOT_API_EFFECT_CATALOG_UNAVAILABLE`; Omnicus never
invents effect IDs. Empty streaming draft updates are ignored because Telegram
uses them as a Thinking placeholder, not as cancellation.

Conversation automation control exposes `AUTO`, `MANUAL` and temporary
`PAUSED` with revision concurrency and automatic resume. Contract 3.2.0 added
application-owned one-shot scheduling, durable Telegram media groups,
structured contact/location/poll messages, scenario/broadcast `sourceContext`
and bot commands/menu configuration. Contract 3.3.0 adds bounded DAILY/WEEKLY
recurrence, revision-safe schedule updates, reply keyboards/Force Reply, native
Telegram rich Markdown and rich draft previews that reuse existing provider
media IDs. External action callbacks remain unsupported until a separate safe
callback contract is approved.

Recurring occurrences are created transactionally in PostgreSQL after the
previous occurrence reaches `SENT`; Redis does not own the series. Series use
stable `seriesId` plus `occurrence`, preserve the configured IANA timezone wall
clock, and stop at the required `count` or `until` bound. A schedule update is
QUEUED-only, uses `expectedRevision`, `Idempotency-Key` and correlation audit,
and cannot be replayed into a second state transition.

The same schedule routes are channel-aware. Telegram may use one-shot or
bounded DAILY/WEEKLY recurrence. WhatsApp accepts only one text occurrence,
requires its timestamp inside the current open customer-service window and
rechecks that window at worker delivery. WhatsApp recurrence or scheduled media
returns a stable safe validation code.

Reply markup is bounded to text, contact and location buttons. Rich Markdown is
limited to Telegram Bot API 10.2 limits and at most one CRM-owned media asset;
arbitrary remote rich-media URLs and direct media upload in draft previews are
rejected.

Contract 3.1.0 exposes stickers and media spoilers separately. CRM must gate
sticker UI on `stickers.supported` and spoiler UI on
`mediaSpoilers.supported`. Contract 3.2.0 advertises
`mediaGroups.supported=true` for its bounded aggregate contract; clients must
still use the media-group endpoint rather than emulate an album with repeated
single-message sends.

## WhatsApp contract 4.0.0

CRM selects WhatsApp with `identity.channel=whatsapp`; omission remains the
backward-compatible Telegram path only where the v3 contract allowed it.
Capabilities are resolved against the exact project, connection, identity and
contact route. They publish the effective 24-hour customer-service window,
provider API version and media limits. CRM must not infer a capability that is
absent or has `supported=false`.

Inside an open service window CRM can send text, same-conversation replies,
validated media, one normalized contact or location, button/list interactive
messages and one standard Unicode reaction. Outside that window only a stored,
synced and `APPROVED` Meta template is accepted. The API checks the window
before creating the intent and the WhatsApp worker checks it again immediately
before the provider call.

WhatsApp media is validated with WhatsApp-specific signatures and effective
limits. The released subset is JPEG/PNG photos, the documented audio/document/
video formats, OGG/Opus voice and static 512x512 WEBP stickers. Animated
stickers, format guessing and server-side transcoding are not supported. Media
responses expose only normalized `validationChannel`; raw provider metadata and
temporary Meta download URLs are never returned or persisted.

`PUT /messages/{messageId}/read`, reactions and ordinary sends create durable,
idempotent WhatsApp outbox operations. `QUEUED` never means delivered. A
definitive `FAILED` operation may be retried with a new stable
`retryRequestId`; `UNKNOWN` remains reconciliation-only and must never be
blindly resent. Project, connection, contact and source-message isolation is
rechecked for every mutation and reply.

Recurring schedules, scheduled media, media groups, message edit/delete/pin,
streaming drafts, chat actions, bot menus, Telegram quote fragments, formatting
entities, reply keyboards, link-preview controls and message effects are
explicitly unsupported for WhatsApp. One-time text scheduling is advertised
only while the route/window constraints can be satisfied. The CRM UI must hide
or disable other controls rather than emulate them.

## Live acceptance status

The core Telegram/CRM path and Chat v3.2 acceptance scenarios have passed live
E2E on 2026-08-02. The retained checklist is the regression gate:

1. Telegram contact creates one CRM lead.
2. A repeated lead operation is idempotent.
3. An inbound Telegram message appears once in CRM.
4. CRM queues a reply and reconciles it to `SENT`.
5. A forced timeout is reconciled without duplicate side effects.
6. Available media is downloaded from its short-lived URL and stored by CRM;
   expired/unavailable files remain metadata-only with a safe status.
7. Neither service logs either service token or message payload.

WhatsApp live acceptance is partial rather than blocked on missing credentials.
The connected test number has verified website registration, open-window
automation, quick-reply interaction, inbound continuation and CRM history in
both directions. The retained final gate is a real `APPROVED` template outside
the window, production-scale broadcast/rate behavior, remaining media/status
cases, duplicate delivery and deliberate cross-route rejection. No code or
contract change is required merely to supply an approved customer template.
