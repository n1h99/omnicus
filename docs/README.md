# Omnicus documentation index

Status reviewed: 2026-08-14. `main` includes Automation Studio 2.2, Telegram
Chat v3.3, WhatsApp Chat v4, public lead capture, per-contact link tracking,
Resend email campaigns, cross-system contact merge, platform operations and
Automation Activity.

## Current product status

- Railway runs the web, API and worker services from `main`; deployments are
  automatic after a push.
- All operator mutations expose action-specific success/failure feedback. Safe
  API codes and validation field names are translated into actionable UI copy;
  internal 5xx details remain hidden behind a correlation reference.
- Project workspaces now include an Operations & Audit Center with safe bounded
  inbox/outbox/automation/broadcast projections, reasoned terminal retry and
  evidence-based `UNKNOWN` reconciliation. Raw payloads, message content and
  credentials are not selected into these responses.
- Account lifecycle is complete for the current operator-delivered model:
  global/project invitations, hashed expiring single-use links, invitation
  acceptance, password-reset requests, one-time admin-generated reset links and
  active-session revocation after reset. Authentication links remain
  operator-delivered; the separate marketing-email provider is not reused
  implicitly for account lifecycle messages.
- Built-in global/project roles remain immutable; authorized operators can
  create custom roles from scope-safe permission catalogs. Project Settings can
  update general metadata and make a safe draft clone containing only general
  settings and custom role definitions.
- Permission-guarded System Health combines PostgreSQL, Redis and worker probes with
  queue pressure, global audit history and current terminal operations from the
  last 24 hours. Older unresolved journal records remain visible separately by
  project and do not make the live platform status look degraded. Each operation
  count links to the matching filtered project journal. The operator reset
  action acknowledges the displayed statistics baseline; it does not delete or
  rewrite the authoritative PostgreSQL journals. Sentry is not used and Railway
  backup configuration remains operator-owned.
- Automation Activity is available only inside each authorized project workspace,
  not as a duplicate global sidebar destination. The board provides paginated
  contact journeys, current steps, safe reasons, per-step timelines, exact status
  totals and bounded trend/scenario/drop-off charts from existing execution
  journals. It never selects contact variables, event payloads or raw provider
  errors.
- Project overview shows project identity, status, locale, timezone and lifecycle
  information only. Tool navigation stays in the dedicated Project sections grid
  and is not duplicated in the overview.
- Project lifecycle controls are kept in Project Settings: editing stays in the
  General settings form, while pause/activate and protected deletion retain their
  explicit status and confirmation flows. The project landing page stays focused
  on information and navigation.
- Permission, audit, health, operation and status codes are translated into
  plain-language UI labels. Action buttons keep accessible names without
  rendering intrusive hover tooltips.
- Public website lead capture accepts project/source-scoped requests with a
  derived ingest key and caller idempotency key. It creates or updates one
  contact, queues the CRM lead projection and starts published
  `WEBSITE_REGISTRATION` scenarios. Telegram deep-link scenarios expose a
  copyable bot start URL.
- Send Message nodes are channel-aware: Automatic is universal text, Telegram
  supports validated media and URL buttons, and WhatsApp supports one
  attachment or up to three quick-reply buttons inside the service window.
  Optional per-contact tracking rewrites message and Telegram-button links;
  clicks appear in Omnicus contact history and the linked CRM lead history.
- Telegram, the connected WhatsApp test path and Cyber Pulse CRM are
  live-verified integration slices. The remaining WhatsApp external gate is an
  approved-template send outside the service window plus production-scale
  acceptance on the customer's Meta account.
- Contact name/email/phone edits queue a durable CRM upsert for the already
  linked lead. Explicit contact merge preserves both channel histories in one
  CRM lead, and migration `20260808000000_crm_contact_merge` plus an idempotent
  worker backfill repairs merges made before that contract was deployed.
- Every normalized Telegram inbound message is queued to an active paired CRM
  independently of Automation Studio. Inbound replies keep a same-conversation
  Omnicus message reference through contract 3.2.3.
- Telegram Chat v3.2 live E2E passed for inbound edits, shared contacts,
  automation/broadcast `sourceContext`, reaction add/change/remove, duplicate
  delivery, reaction-before-source and routing isolation.
- Connection-scoped discovery advertises
  `userReactionEvents.supported=true`.
- Telegram Chat v3.3 adds bounded reply keyboards/Force Reply, application-owned
  DAILY/WEEKLY recurring schedules with revision-safe updates, native Telegram
  rich Markdown messages and rich draft previews that reuse provider media IDs.
- Rich content never accepts arbitrary media URLs; durable media is resolved
  only from a project/connection-scoped Omnicus asset.
- CRM history now requires both a numeric Telegram provider message ID and a
  matching `SUCCEEDED` Telegram outbox; synthetic rows cannot become chat
  bubbles. Channel pipeline failures/unknown outcomes raise safe UI
  notifications when the operator is viewing that channel.
- Automation Studio 2.2 supports incomplete/disconnected drafts, explicit
  operator-controlled saving, edge deletion and durable SSRF-safe External
  HTTP nodes. Editor changes remain local until **Save draft** is pressed. The
  editor now hydrates one stable saved baseline, refreshes version history
  immediately, previews each immutable canvas, keeps connection handles stable,
  and exposes only graph-relevant Safe Test controls.
- Automation authoring validates active tags, custom fields, templates,
  subflows and HTTP secrets before Test/Publish. Incomplete drafts remain
  saveable, while disconnected nodes are blocking issues. **Clear custom
  field** removes one current-contact value without deleting its project field
  definition.
- Automation execution diagnostics distinguish node completion from actual
  Telegram delivery. Send steps persist only safe message/outbox references;
  missing content or channel identity fails the step instead of reporting a
  false success.
- External HTTP DNS pinning keeps IPv4 and IPv6 deny lists separate and selects
  a public resolved address when a platform resolver also returns restricted
  addresses. Private, loopback, mapped, reserved and redirect targets remain
  blocked.
- WhatsApp Business Cloud API is implemented through the same durable
  inbox/outbox, CRM and automation boundaries. It includes manual and Meta
  Embedded Signup setup, signed app-level webhooks, normalized message/status
  processing, customer-service-window enforcement, approved templates,
  WhatsApp broadcasts and channel-aware CRM chat. Live testing has verified
  the connected test number, website-triggered automation, open-window text and
  interactive replies, inbound reply routing and CRM history synchronization.
  The closed-window guard is verified; an approved production template is not
  yet available for the final outside-window send.
- CRM can create, update and cancel one-time WhatsApp text schedules while the
  current 24-hour window is open. The worker rechecks that window at delivery;
  WhatsApp recurrence and scheduled media remain intentionally unsupported.
- Telegram and WhatsApp voice recording preserve playable duration metadata.
  Telegram video notes are upload-only; media and sticker inputs are validated
  against channel-specific type, MIME, signature, size and dimension rules.
- `Email & SMS Broadcast` now provides Resend-backed email campaign drafts,
  audience estimates and filters, scheduling, a block editor, test sends,
  reusable versioned templates, suppressions, recipient reports and a project
  analytics table. Automation Studio can pin a published template in `Send
  email`. SMS remains explicitly under construction.
- Email delivery uses the verified `mail.omnicus.app` sending domain,
  `links.mail.omnicus.app` tracking domain and signed Resend webhook. Active
  contacts with a valid non-suppressed address are eligible; consent metadata
  remains auditable but is not an additional campaign filter. Email lifecycle
  events and clicked target URLs are forwarded idempotently to CRM.
- Instagram remains deliberately deferred until its test account and separate
  provider scope exist.

The Telegram channel-detail cache refresh issue found during the current
verification cycle is resolved: disable/connect mutations update the active
detail immediately. Broad manual/live acceptance remains intentionally grouped
into the final verification stage.

## Active references

| Area                                   | Authoritative document                                                 |
| -------------------------------------- | ---------------------------------------------------------------------- |
| Architecture and trust boundaries      | [ARCHITECTURE.md](ARCHITECTURE.md)                                     |
| Product stages and follow-ups          | [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)                       |
| Accepted decisions                     | [DECISIONS.md](DECISIONS.md)                                           |
| Prisma schema and migration invariants | [DATABASE.md](DATABASE.md)                                             |
| Automation semantics                   | [AUTOMATION_ENGINE.md](AUTOMATION_ENGINE.md)                           |
| Durable lifecycle rules                | [STATE_MACHINES.md](STATE_MACHINES.md)                                 |
| Operations and incident recovery       | [RUNBOOK.md](RUNBOOK.md)                                               |
| Railway topology                       | [RAILWAY.md](RAILWAY.md)                                               |
| Test gates                             | [TESTING.md](TESTING.md)                                               |
| Operator workflows                     | [OPERATOR_GUIDE.md](OPERATOR_GUIDE.md)                                 |
| Email campaigns and Resend             | [EMAIL_BROADCASTS.md](EMAIL_BROADCASTS.md)                             |
| Cyber Pulse integration                | [CRM_INTEGRATION.md](CRM_INTEGRATION.md)                               |
| WhatsApp Business Cloud API            | [WHATSAPP_CLOUD_API.md](WHATSAPP_CLOUD_API.md)                         |
| CRM-to-Omnicus OpenAPI                 | [OMNICUS_CRM_OUTBOUND_OPENAPI.yaml](OMNICUS_CRM_OUTBOUND_OPENAPI.yaml) |
| Omnicus-to-CRM OpenAPI                 | [OMNICUS_TO_CRM_OPENAPI.yaml](OMNICUS_TO_CRM_OPENAPI.yaml)             |
| Pairing OpenAPI                        | [CRM_PAIRING_OPENAPI.yaml](CRM_PAIRING_OPENAPI.yaml)                   |

## Historical and handoff references

The following files are retained for audit/history and are not current blockers:

- [CRM_CONTRACT_REQUIRED.md](CRM_CONTRACT_REQUIRED.md): original CRM contract
  gate, satisfied by the published Cyber Pulse contracts.
- [CRM_OUTBOUND_HISTORY_HANDOFF.md](CRM_OUTBOUND_HISTORY_HANDOFF.md): completed
  outbound-history handoff.
- [CRM_TELEGRAM_STICKER_MEDIA_HANDOFF.md](CRM_TELEGRAM_STICKER_MEDIA_HANDOFF.md):
  completed 3.1 media handoff; current capability values come from v3.3
  discovery and OpenAPI.
- [PILOT_EXTERNAL_GATES.md](PILOT_EXTERNAL_GATES.md): gate ledger showing what
  is complete and what remains deliberately deferred.
- [OMNICUS_TELEGRAM_CHAT_V3_IMPLEMENTATION.md](OMNICUS_TELEGRAM_CHAT_V3_IMPLEMENTATION.md):
  retained implementation history; current behavior comes from capability
  discovery, accepted ADRs and the OpenAPI contracts.
- [STAGE1_BASELINE_SQL_PROPOSAL.sql](STAGE1_BASELINE_SQL_PROPOSAL.sql): retained
  Stage 1 SQL review artifact, not the current full schema.

When prose and executable behavior differ, the OpenAPI contracts, Prisma
schema, accepted ADRs and capability response take precedence over historical
handoff text.
