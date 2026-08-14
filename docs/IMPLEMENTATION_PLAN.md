# OMNICUS — implementation plan

Current status (reviewed 2026-08-14): the pilot and approved post-pilot Telegram,
CRM, broadcasts, media/templates, Automation Studio 2.1 and Automation Studio
2.2 slices are implemented and deployed from `main`. Telegram Chat v3.2 live
acceptance is complete and `userReactionEvents.supported=true`. The approved
WhatsApp Business Cloud API post-pilot slice is implemented; its connected
test route is live-verified while approved-template and production-volume
acceptance remain external. Public website lead capture, tracked links and the
Resend email campaign/automation slice are also implemented. Instagram
remains intentionally deferred until its test account and separate scope are
approved. Earlier stage sections below are retained as implementation
history, not as the current deployment status. Telegram Chat v3.3 implements
the approved reply-keyboard, recurring-schedule and native rich-message slices;
their broad manual/live regression is intentionally grouped into the final
verification stage. Platform completion now also includes Operations/Audit,
account lifecycle, roles, project cloning, System Health and the project-scoped
Automation Activity board with human-readable contact journeys and bounded
charts.

## Stage 3C.2 — Telegram channel UI

The protected web shell includes Telegram channel list, create and details routes.
It uses project-scoped channel queries and mutations, never persists plaintext
tokens in browser storage, renders only the backend masked token, and presents
test-message creation as queued rather than delivered.

## Статус

Этапы 0–4 завершены в рамках pilot scope. Этап 5 реализован для
provider-neutral CRM mock: project configuration, transactional CRM outbox и
deterministic mock worker. Реальный deploy, production CRM adapter и live
Telegram acceptance остаются внешними gates.

## Цель pilot

Доказать надёжный поток:

```text
Telegram webhook
→ PostgreSQL inbox
→ normalized event/contact/message
→ minimal automation runtime
→ CRM mock through PostgreSQL outbox
→ mock CRM result/callback
→ Telegram outbound through PostgreSQL outbox
→ execution and audit visibility
```

Pilot включает:

- Auth/RBAC и project isolation;
- projects;
- contacts, tags и custom field definitions;
- Telegram;
- CRM interface и mock adapter;
- узлы Incoming Message, Condition, Create/Update Lead, Forward to CRM,
  Send Message, Add/Remove Tag;
- transactional inbox/outbox;
- execution journal;
- Railway staging deployment.

Pilot не включает WhatsApp, Instagram, broadcasts, Delay, Wait for Reply,
Subflows, полноценный External HTTP Request editor и расширенные media workflows.

## Сквозные требования каждого этапа

- TypeScript strict и runtime validation внешних данных.
- Tenant-safe composite constraints и project access guards.
- Миграция создаётся до применения изменения schema после появления Prisma.
- Любой внешний side effect проходит через OutboxRecord.
- PostgreSQL является источником истины; BullMQ job можно восстановить.
- Correlation ID проходит через inbox, event, execution, CRM mock и outbound.
- Secrets и PII редактируются в logs/fixtures.
- Acceptance tests используют mocks при отсутствии credentials.
- Security, audit и observability baseline реализуются вместе с функцией, а не
  откладываются в отдельный финальный hardening.

## Этап 0. Scaffold и ADR

### Entry criteria

- Глобальная спецификация и обязательные ADR утверждены.
- Node.js/pnpm target versions выбраны перед созданием lockfile.

### Deliverables

- pnpm workspace и Turborepo;
- `apps/web`, `apps/api`, `apps/worker`;
- packages для database, shared, contracts, config, channel core и test fixtures;
- React/Vite/Ant Design shell;
- NestJS API и worker shell;
- PostgreSQL/Redis local Docker Compose;
- Prisma schema без migration до отдельного review generated SQL; guarded seed
  только для dev/test;
- environment validation;
- health live/ready;
- lint/format/typecheck/test/build pipelines;
- CI;
- Railway service commands;
- архитектурные документы и runbook skeleton.

### Обязательные ADR/checkpoints

- ADR-001…ADR-012 из `docs/DECISIONS.md`;
- Node/pnpm/package version pinning;
- Prisma migration ownership/location;
- structured logging library;
- outbox relay polling/notification strategy;
- cookie/CORS deployment topology.

### Verification

- clean install из lockfile;
- format, lint, typecheck, unit smoke, build;
- `prisma validate`;
- Docker Compose health;
- API/worker graceful shutdown;
- no secrets in repository scan.

### Exit criteria

- Все три приложения запускаются как пустые shells.
- PostgreSQL/Redis доступны через validated config.
- CI повторяет локальные проверки.
- Никаких Telegram/CRM business flows ещё нет.

### Результат

- pnpm/Turborepo workspace, три application shells и шесть infrastructure
  packages созданы;
- Prisma schema валидна, generated client создаётся, migration отсутствует;
- Docker Compose, CI и Railway service configuration созданы;
- переход к Этапу 1 требует отдельного явного решения.

## Этап 1. Auth, RBAC и Projects

### Scope

- User, Role, Permission, GlobalUserRole, ProjectMembership;
- access JWT;
- opaque refresh token family, hash storage, rotation и reuse detection;
- CSRF synchronizer token и Origin/Referer checks;
- login/logout/logout-all/reset-password/invite;
- project CRUD и state machine;
- project selector и protected shell;
- audit baseline;
- backend project access и permission guards.

### Key tests

- refresh token plaintext отсутствует в БД/logs;
- повтор использованного refresh token отзывает family;
- state-changing cookie operation без CSRF отклоняется;
- пользователь без membership не видит project;
- cross-project ID в URL/body отклоняется;
- global role не подменяется project role;
- paused/archived project transitions соответствуют state machine.

### Exit criteria

- Два проекта имеют изолированные данные и разные роли одного пользователя.
- Auth и project acceptance criteria выполняются в API и UI.

## Этап 2. Contacts, Tags и Custom Fields

### Scope

- Contact и ChannelIdentity foundation without a provider connection or webhook runtime;
- automation mode inheritance;
- Tag/ContactTag;
- CustomFieldDefinition и typed value validation. Contact values remain in the contact JSON document in this slice; deleting a definition archives it and never deletes historical contact JSON values;
- Segment schema и validator; UI saved segments можно отложить до последующей
  функции, но модель не должна блокировать развитие;
- contact list/card/filter;
- basic timeline;
- merge policy foundation;
- ChannelConsent foundation.

### Key tests

- tenant-safe foreign keys отклоняют cross-project ContactTag/Identity;
- normalized tag uniqueness;
- custom value соответствует definition type;
- conversation override имеет приоритет над contact mode;
- merge не выполняется автоматически по имени.

### Exit criteria

- Contacts/tags/custom fields работают на fixtures.
- Project isolation подтверждена integration tests.

## Этап 3. Transactional Inbox/Outbox и Telegram Adapter

### Stage 3B.1 — persistence schema

Implemented persistence-only slice: `ChannelConnection`, valid raw webhook
events, `InboxRecord`, `OutboxRecord`, `IdempotencyRecord`, `NormalizedEvent`,
`Conversation` and `Message`, with a separate reviewed migration. This slice
does not include a webhook endpoint, BullMQ processing, outbound delivery, a
channel-management API or frontend. Those remain subsequent Stage 3 work.

Stage 3B.2 adds the public Telegram webhook acknowledgement boundary: it
verifies the encrypted webhook secret before persisting any body, atomically
stores a valid `RawWebhookEvent` and pending `InboxRecord`, deduplicates on the
provider update ID, and best-effort enqueues an inbox-record-only BullMQ job.
Redis enqueue failure does not roll back PostgreSQL intent; recovery remains a
later Stage 3 slice.

Stage 3B.3a adds the Telegram inbound consumer only. It claims one inbox record
with a bounded lease, parses its PostgreSQL-backed payload, and transactionally
persists the normalized event, connection-scoped contact identity, stable
conversation, and inbound message. Redelivery is safe through the unique inbox
event and message constraints.

Stage 3B.3b completes inbound reliability. The worker classifies failures into
safe retryable or permanent codes, applies capped exponential retry delay with
bounded jitter, and terminally dead-letters permanent or exhausted records
without deleting the raw event. Its recovery loop re-enqueues due `PENDING` /
`RETRY` work and expired leases from PostgreSQL using a stable BullMQ job ID.
Lease-token conditional completion prevents a stale worker from completing a
newer claim. An internal, audited manual retry method is reserved for future
operations UI/API. Outbound delivery, channel CRUD, and frontend remain outside
this slice.

### Scope

- InboxRecord, OutboxRecord, IdempotencyRecord, RawWebhookEvent,
  RejectedWebhookAttempt;
- relay/recovery scan и BullMQ signals;
- lease expiry и crash recovery;
- retry classification, unknown и reconciliation foundation;
- Telegram connection validation и webhook registration через outbox;
- webhook secret verification до raw persist;
- body limit 2 MB;
- raw valid event retention metadata;
- Telegram parser для pilot text/command/callback и provider media metadata;
- NormalizedEvent, Message, OrphanMessageStatus;
- lazy media metadata и validation hooks;
- logs/correlation/manual retry foundation.

### Key tests

```text
valid webhook → inbox commit → fast acknowledgement
invalid signature → no raw body/inbox
duplicate update_id → prior acknowledgement, one domain effect
DB commit + missing BullMQ job → relay restores execution
worker crash after claim → lease recovery
provider timeout after possible effect → outbox unknown, no blind retry
status before message → OrphanMessageStatus → later attachment
paused project → deferred inbox → resume processing
```

### Exit criteria

- Реальный или mock Telegram webhook создаёт один normalized event/contact/message.
- Потеря Redis job не теряет PostgreSQL intent.
- Никакой CRM или automation side effect ещё не требуется.

## Этап 4. Минимальный Automation Runtime

### Scope

- Scenario/ScenarioVersion;
- immutable publish и draft;
- compiled deterministic definition;
- ScenarioExecution/NodeExecution;
- Incoming Message trigger;
- Condition с branch priority, strict null/type semantics;
- Add/Remove Tag;
- Send Message через outbox;
- Create/Update Lead и Forward to CRM через `CrmClient` port;
- execution log;
- minimal graph editor/forms только для pilot nodes;
- conversation serialization;
- graph validation, включая ports и unguarded cycles.

### Отложено

- Delay, Wait, Subflow;
- arbitrary iteration loops;
- External HTTP Request;
- advanced test debugger;
- cross-channel nodes.

### Key tests

- один trigger создаёт не более одного execution на idempotency policy;
- все matching scenarios запускаются;
- порядок между scenarios не предполагается;
- события одной conversation исполняются последовательно;
- branch выбирается по priority;
- null не coerced;
- published graph не изменяется при explicit draft save;
- node side effect переживает worker restart без слепого дублирования.

### Exit criteria

- Pilot graph создаётся, валидируется, публикуется и исполняется из Telegram event.
- Execution path и safe node inputs/outputs видны в журнале.

## Этап 5. CRM Adapter и полный Telegram ↔ CRM pilot

### Entry gate

Для production adapter выполнены exit criteria
`docs/CRM_CONTRACT_REQUIRED.md`. Если CRM contract ещё отсутствует, этап
выполняется только с mock adapter и не маркируется production-ready.

### Scope

- environment-only `CRM_BASE_URL`/`CRM_AUTH_TOKEN`;
- CrmProjectConfig;
- CrmClient interface;
- deterministic mock adapter;
- production adapter только после contract review;
- create/update lead и forward message через outbox;
- inbound CRM callback inbox/security после подтверждения контракта;
- reconciliation и manual retry;
- полный execution correlation;
- Telegram outbound response.

### Current mock implementation

The pilot mock includes a per-project configuration, deterministic `CrmClient`
adapter, CRM-specific outbox records, safe retry classification and a project
operation journal. Terminal `FAILED` records can be requeued; `UNKNOWN` requires
explicit operator confirmation because the external side effect may already have
occurred. This is not a production CRM integration and remains gated by
`docs/CRM_CONTRACT_REQUIRED.md`.

### Cyber Pulse production adapter (2026-07-29)

The authoritative Cyber Pulse staging contract is now available. The worker
uses the real authenticated HTTP `CrmClient`, PostgreSQL CRM outbox, safe
retry/unknown classification and reconciliation by idempotency key. The API
also exposes the independently authenticated CRM-to-Omnicus Telegram queue and
delivery reconciliation contract. See `docs/CRM_INTEGRATION.md`.

Live staging E2E and Railway credential installation remain external acceptance
gates; the legacy CRM cleanup must not run before those checks pass.

### Per-project CRM connection registry (2026-07-29)

- `CrmProjectConfig` owns the adapter, exact CRM origin, external project ID,
  connection status and per-direction credentials.
- A short-lived one-time pairing code replaces manual project-specific Railway
  variables.
- Omnicus-to-CRM credentials are encrypted with the existing application master
  key; CRM-to-Omnicus credentials are stored only as hashes.
- API authentication resolves the connection before validating project routing.
- The worker resolves a fresh project-scoped `CrmClient` from PostgreSQL for
  every CRM outbox attempt.
- The Cyber Pulse staging integrations screen completes pairing and stores its
  side of the credentials encrypted in MongoDB.
- Legacy environment routing is a migration fallback only and is not used for
  newly paired projects.

### Key tests

- CRM mock success;
- retryable/permanent/unknown outcomes;
- duplicate CRM operation idempotency key;
- project mapping не доверяет caller-provided internal projectId;
- CRM outage не блокирует webhook acknowledgement;
- callback duplicate не создаёт повторный Telegram message;
- response отправляется через outbox.

### Exit criteria pilot

- Telegram → Omnicus → CRM mock → Omnicus → Telegram работает end-to-end.
- Failure/retry/unknown видны оператору.
- Backup restore procedure выполнена и задокументирована.
- Railway staging deployment соответствует RPO 24h/RTO 4h baseline.
- Проведён pilot review и принято решение о следующих функциях.

### External validation gates

The mock pipeline is the only CRM path that can be completed without outside
access. `docs/PILOT_EXTERNAL_GATES.md` lists the exact CRM contract, Telegram
test bot, Railway staging and backup-restore inputs required before a real
provider/deployment acceptance run. WhatsApp and Instagram remain explicitly
outside this pilot.

## После pilot

Последовательность определяется отдельным review. Исходный backlog:

1. Production CRM adapter, если pilot был mock-only.
2. Wait/Delay и advanced automation semantics.
3. WhatsApp adapter и template policy.
4. Broadcasts и consent workflows.
5. External HTTP Request node.
6. Subflows.
7. Расширенный media pipeline.
8. Instagram только после отдельного подтверждения.

Каждый пункт требует отдельного scope, threat review, NFR и acceptance criteria.

## Automation v2 — approved post-pilot slice

This slice is limited to the existing Telegram channel and adds a React Flow
canvas, explicit draft persistence/local history, durable Delay, Wait for Reply, and Subflow
continuations. The worker recovers due delays and wait timeouts from PostgreSQL;
it never relies on a process-local timer. The slice does not add External HTTP,
WhatsApp/Instagram, broadcasts, templates or media workflows.

Acceptance requires deterministic graph validation, a published-version pin for
subflows, one active wait per conversation/scenario, transactional reply versus
timeout resolution, worker-crash recovery, execution journal visibility, and
protected project-scoped UI/API operations.

Implementation includes deterministic graph validation, a React Flow draft editor,
published-version execution, durable Delay/Wait continuations and pinned
Subflows. External HTTP, broadcasts, templates, extra channels and advanced
media remain outside this slice.

## Automation Studio 2.1 — approved authoring and diagnostics slice

This Telegram-only increment improves the existing versioned editor and runtime:

- project-scoped tag and custom-field selectors replace raw identifiers;
- condition authoring exposes the full deterministic operator set and typed
  comparison values;
- Delay and Wait durations are authored in seconds, minutes, hours or days while
  the compiled graph keeps integer seconds;
- Wait for Reply supports bounded text, callback and media criteria, with old
  empty criteria remaining compatible as any supported customer reply;
- execution inspection exposes safe per-node timing and branch metadata without
  copying customer content or provider payloads.
- condition connections support bounded nested-free AND/OR rule groups plus one
  explicit fallback branch, while legacy node-level conditions remain executable;
- Send Message provides a project-aware variable picker and deterministic sample
  preview;
- the editor provides a 50-step local undo/redo history, node copy/paste and
  duplication, grid snapping, explicit draft save, optimistic concurrency
  and navigation guards;
- safe test run and execution replay simulate the pinned graph and branch choices
  without creating Telegram, CRM, tag, contact, delay or wait side effects.

The slice does not add regular expressions, arbitrary external HTTP requests,
side-effecting execution replay, WhatsApp or Instagram. Published versions remain
immutable and all durable continuation state remains PostgreSQL-owned.

## Contacts v2 — approved post-pilot slice

Contacts v2 adds saved segments, typed custom-field projections and an explicit,
manual contact merge. It keeps the existing Telegram identity model and does
not introduce broadcasts, import/export, another channel or media workflows.
The primary contact is selected by an operator; merge never starts from a fuzzy
match. Segment membership is calculated at query time from project-scoped
filters and is not stored as a mutable recipient list.

## Telegram Broadcasts — approved post-pilot slice

Telegram Broadcasts add project-scoped drafts, scheduled or immediate launch,
an audience snapshot, recipient technical status and pause/resume/cancel
controls. The snapshot creates one transactional `Message` plus `OutboxRecord`
per eligible Telegram identity, with a stable broadcast-recipient idempotency
key. Existing Telegram outbound retry, 429 handling and `UNKNOWN` delivery
semantics remain authoritative; a broadcast never calls Telegram directly.

This slice is Telegram text only. It excludes templates, WhatsApp, Instagram,
advanced media, analytics funnels and consent workflows beyond the current
blocked/unsubscribed eligibility guard.

## Telegram media, templates and visual automation completion

This post-broadcast slice adds lazy Telegram photo/document materialization,
private object storage, signed access, application retention jobs and media
delivery through the existing transactional outbox. It also adds project-scoped
text/photo/document templates with immutable published versions and pins those
versions from scenarios and broadcasts.

The existing React Flow editor is completed with typed node forms, port-aware
connections, validation feedback, template selection, version history and a
node-by-node execution inspector. This slice remains Telegram-only and does not
introduce CRM provider endpoints, WhatsApp, Instagram or deployment.

Implementation additionally preserves branch output/priority/conditions during
canvas round-trips, pins both template and subflow versions, renders broadcast
templates per recipient, and rejects save/publish while deterministic graph
validation has errors. Media remains a provider reference until requested;
validated materialization, signed delivery and retention all use PostgreSQL
lifecycle state rather than an in-memory assumption.

## Pilot NFR

| Requirement                  | Initial target                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| Webhook acknowledgement      | После signature/size validation и durable inbox commit; без ожидания CRM/runtime/outbound |
| Raw webhook body             | Максимум 2 MB                                                                             |
| Future External API response | Максимум 5 MB                                                                             |
| Broadcast size               | Неприменимо для pilot                                                                     |
| Technical logs retention     | 30 дней                                                                                   |
| Audit retention              | 180 дней                                                                                  |
| Valid raw payload retention  | 30 дней                                                                                   |
| RPO                          | 24 часа                                                                                   |
| RTO                          | 4 часа                                                                                    |
| Restore verification         | Обязательная документированная проверка                                                   |

До production необходимо дополнить нагрузочные цели наблюдениями pilot:
ожидаемые connections/projects, webhook rate, queue latency и объём хранения.

## Внешние blockers

- Production CRM contract/OpenAPI.
- Реальные Telegram credentials для live acceptance.
- Railway staging project и environment access.
- Решение владельца данных по необходимости application-side media encryption.

## Stage 3C.1 — Telegram channel backend and transactional outbound

Implemented backend-only channel management for Telegram: project-scoped channel
permissions, encrypted token/secret handling, `getMe` validation, webhook
connect/disable/secret rotation, and a test-message endpoint. The outbound path
creates `Message` and `OutboxRecord` transactionally, then enqueues only the
outbox ID. The worker claims records with a lease, records retryable failures as
`RETRY`, preserves uncertain timeout outcomes as `UNKNOWN`, and periodically
re-enqueues pending/retry and stale-lease records. Frontend channel screens and
all non-Telegram providers remain outside this sub-stage.

## Telegram Messaging & Interactive Flows

This accepted post-deployment slice completes the relevant Telegram Bot API
surface for the existing product:

- reply to an Omnicus message;
- inline keyboard authoring and callback-data condition branches;
- durable `answerCallbackQuery`;
- video, audio, voice, video note and animation metadata, assets, templates and
  outbound delivery;
- CRM multipart media upload followed by asset-referenced outbound delivery;
- materialized inbound media URLs for immediate CRM ingestion;
- bounded idempotent history synchronization after initial CRM lead creation.

It does not add WhatsApp, Instagram, arbitrary URL fetching, user-account
Telegram behavior, secret-chat access, an FFmpeg runtime dependency or
unbounded Telegram history retrieval. Every provider call continues through
PostgreSQL inbox/outbox state and existing retry/unknown rules.

## Omnicus outbound history synchronization

Confirmed Telegram messages created by automation and broadcasts are mirrored
to CRM through a dedicated outbound-history contract. The Telegram worker
creates the CRM outbox intent transactionally with `Message=SENT`; a bounded
CRM recovery scan backfills earlier sent automation/broadcast messages.
CRM-originated outbound messages are excluded to prevent loops. This slice does
not add a new channel, CRM provider behavior, or UI.

## Workspace lifecycle and UI consistency

Project, automation, and broadcast deletion is implemented as audited archival
so relational history remains intact. Archived records are excluded from normal
workspace lists. The web application exposes project-name-aware breadcrumbs,
modal project editing, lifecycle confirmation dialogs, consistent entity
headers, accessible locale labels, and a canvas lock that also disables zoom.

## Telegram Chat v3 provider contract

The first v3 provider slice exposes connection-scoped capabilities and adds
durable edit/delete/reaction/pin operations, explicit retry of terminal failed
operations, rich text entities, quote/link-preview/protect-content options,
ephemeral chat actions, ephemeral streaming drafts and conversation-level
AUTO/MANUAL automation control. All durable changes reuse the Telegram outbox;
ephemeral signals never create messages. Scheduling, albums,
structured location/contact/poll messages, reply keyboards, bot-interface
configuration, paused auto-resume and rich-message blocks remain disabled in
the capability response until their persistence and contracts are implemented.

The next provider increment adds first-class Telegram stickers (WEBP, TGS and
WEBM) plus spoiler presentation for photo, video and animation. Inbound album
membership is normalized as `mediaGroupId`, while outbound albums stay disabled
until a durable multi-message aggregate and reconciliation model is released.

The provider follow-up adds transactional normalization and CRM outbox delivery
for private-chat Telegram user reaction events, but keeps the advertised
capability disabled until the paired CRM endpoint passes live E2E. Outbound
automation/broadcast history now preserves entities, link preview, protected
content, message effect, reply and quote metadata. Empty streaming drafts are
ignored to avoid Telegram's Thinking placeholder. Edit capability limits
explicitly distinguish editable and immutable fields. Since Bot API 10.2 has
no effect-catalog discovery method for bots, Omnicus advertises an empty catalog
with a stable reason code instead of inventing effect identifiers.

Live reaction acceptance fixes the response boundary to the deployed CRM shape:
immediately applied reactions return the affected `crmMessageId`; pending
reaction-before-source returns `applied=false` without a message ID and remains
reconcilable by `operationId`. Both direct and reconciliation responses use the
same versioned result so a successful CRM side effect cannot be left `UNKNOWN`
because Omnicus expected a synthetic reaction-record identifier.

The full reaction capability is live-verified: add/change/remove update the
source bubble, duplicate `normalizedEventId` delivery is idempotent,
reaction-before-source attaches after the source arrives, invalid project/contact/
connection routing is rejected, and a post-fix production worker operation
completed `SUCCEEDED` on its first attempt. Connection-scoped capability
discovery now advertises `userReactionEvents.supported=true`.

The active CRM pairing now owns complete inbound history independently of
automation graphs. Telegram inbound persistence creates a stable CRM intent in
the same transaction when the contact is linked, or one contact-bootstrap
intent followed by bounded history backfill when it is not. Contract 3.2.3
preserves a same-conversation inbound reply reference as an Omnicus UUID.

## Automation Studio 2.2 — external HTTP and incomplete-draft authoring

This approved slice adds an SSRF-safe `EXTERNAL_HTTP_REQUEST` node with bounded
HTTPS request configuration, project secret references, stable idempotency,
transactional HTTP outbox persistence, explicit success/failure branches,
response mapping into execution variables, safe test preview and execution
diagnostics. DNS and every redirect are validated and pinned; raw request and
response bodies, rendered URLs and secret values are not persisted in technical
operation metadata.

Drafts may retain publish-validation errors, disconnected nodes and empty paths.
The server stores those validation results while publish/test remain strict.
The editor keeps changes local with an `Unsaved changes` indicator and writes
only after an explicit **Save draft** action. Connections can be removed
explicitly or with the Delete/Backspace keys and restored through the existing
local undo history.

Provider contract 3.2.0 adds the CRM-requested durable boundary for safe
scenario/broadcast `sourceContext`, client edit/contact events, temporary
conversation pause with automatic resume, application-owned scheduling,
Telegram media-group aggregates, structured contact/location/poll messages and
bot commands/menu configuration. External callbacks and external deletion
remain capability-gated because no safe provider contract exists for them.
Scheduled-message create/get/list/cancel responses carry safe routing IDs, and
all public read/cancel operations require connection/contact scope so CRM lead
managers cannot enumerate another lead's schedule.

## Resolved UI follow-ups

- Telegram channel mutations synchronize the returned connection into both the
  project channel list and active channel-detail cache before invalidating them.
  After **Disable channel**, the same page immediately renders the disabled
  state and **Connect webhook** action; reconnecting restores the active state
  without navigation or reload.
- Automation Studio derives its clean baseline from the same hydrated graph it
  renders, so reload no longer produces a false `Unsaved changes` state. Save
  invalidates scenario detail/version history immediately without requiring F5.
- Version history has an immutable canvas preview; validation, Safe Test and
  execution diagnostics use human node labels while keeping technical IDs in
  opt-in details.
- Node settings share one compact layout, palette search exposes every node,
  Safe Test inputs are limited to node types present on the canvas, the current
  scenario is excluded from Subflow choices, and canvas lock disables all edit
  actions.
- Connection handles use stable positions and enlarged hit targets with
  click-to-connect support and a conventional grab/grabbing cursor.
- Empty optional descriptions are omitted or cleared explicitly, saved-state
  comparison ignores editor-only edge IDs and canonicalizes graph order, and
  reverting exactly to the saved graph restores the **Saved** state.
- Disconnected nodes and unavailable project resources block Test/Publish in
  the editor while **Save draft** stays available. Validation issues focus the
  affected node or connection and server race errors remain human-readable.
- `CLEAR_CUSTOM_FIELD` clears one contact value transactionally from JSON and
  typed projections without deleting the field definition.
- Automation Activity remains an explicit project tool guarded by
  `automation:read`, but the duplicate global sidebar destination is removed. The
  board avoids a desktop table scrollbar while retaining bounded horizontal
  scrolling on small screens.
- System Health uses a responsive status summary, distinct dependency cards and
  a contained alerts/background-work/audit workspace with operator-facing service
  names and recovery guidance. Current alerts use a 24-hour operation window;
  older unresolved records are separated by project and link to filtered journals.
- Project detail keeps its overview informational and leaves all tool navigation
  in Project sections. Project Settings aligns its heading with the centered
  General and safe-cloning workspace, owns project lifecycle controls, then
  stacks those cards responsively.

## Platform operations completion — implemented

The final non-provider platform slice is implemented as four connected product
areas:

1. **Operations & Audit Center.** A project-scoped screen combines bounded safe
   projections from inbound, outbound, automation and broadcast journals with
   filters, status summaries and audit history. `FAILED`/`DEAD_LETTER` recovery
   is explicit, reasoned and audited. `UNKNOWN` requires provider evidence and
   cannot be blindly retried.
2. **Account lifecycle and RBAC.** Global/project invitations use hashed,
   expiring single-use tokens. Existing accounts authenticate before accepting;
   new accounts establish their profile and password at acceptance. Password
   reset is enumeration-safe, operator-mediated until an email provider is
   approved, and revokes active sessions. Custom global/project roles are
   editable while seeded roles remain immutable.
3. **Project settings and clone.** General name, locale, timezone and optional
   description are editable. A safe clone starts in `DRAFT`, gives the actor a
   project-admin membership and copies only general settings plus custom role
   definitions—never contacts, channels, credentials, messages, media,
   automations, executions or history.
4. **System Health.** A `roles:manage`-guarded page combines live PostgreSQL/Redis/worker
   checks, BullMQ counts, recent durable failure/unknown aggregates, historical
   terminal-record context, derived alerts and global audit history. PostgreSQL
   remains authoritative and Redis remains an execution signal.

This slice adds no Prisma migration. Sentry and in-product backup management
are deliberately excluded; Railway backups remain an operator configuration.
WhatsApp/Instagram and provider-limited Telegram capabilities remain separately
deferred. Automated gates run before deployment; broad live acceptance remains
the final combined user verification stage.

## Cross-system completion update - 2026-08-08

- Contact edits now queue a durable update of the already linked Cyber Pulse
  lead; identity is the project-scoped Omnicus contact link, not fuzzy PII.
- Explicit contact merge is implemented end to end. Omnicus keeps one primary
  contact, Cyber Pulse keeps one surviving lead, and Telegram plus WhatsApp
  histories remain usable on that survivor.
- Migration `20260808000000_crm_contact_merge` and the idempotent worker
  `contact-merge-backfill` command reconcile merges created before the callback
  contract existed.
- WhatsApp CRM scheduling is implemented for one future text occurrence inside
  the open service window. Recurrence and scheduled media are rejected; the
  worker repeats the window guard.
- CRM chat supports Telegram/WhatsApp voice recording with duration metadata,
  channel-specific attachment validation and normalized stickers. Telegram
  video notes are uploaded files; the removed browser camera recorder is not a
  supported feature.
- Cyber Pulse Kanban persists same-column card order. Email & SMS Broadcast is
  present as an explicit under-construction tool, not a working sender.

## Acquisition, tracking and email completion update - 2026-08-14

- Public project/source-scoped lead ingestion accepts a server-side ingest key
  and required caller idempotency key, creates or updates one contact, queues
  the CRM projection and starts matching published website-registration flows.
- Automation Studio generates website endpoint/header examples and Telegram
  deep links. Send Message supports channel-specific Telegram media/URL buttons
  and WhatsApp attachment-or-quick-reply content, with service-window guards.
- Optional tracked links record per-contact clicks, redirect to the original
  target and forward normalized click history to Cyber Pulse CRM.
- WhatsApp consent and evidence-based reachability are stored separately.
  Delivery/read or inbound evidence marks availability; Meta recipient error
  `131026` marks unavailability. The product does not invent a bulk number
  lookup capability that Meta does not provide.
- The Omnicus `Email & SMS Broadcast` project tool is now a working email
  product. The earlier Cyber Pulse placeholder statement above is historical:
  CRM still has no native sender, while Omnicus owns drafts, scheduling, the
  block editor, templates/versions, suppressions, analytics and Resend delivery.
- `Send email` automation pins a published template version. Signed Resend
  events and tracked URLs update Omnicus analytics and linked CRM lead history.
- SMS, Zoom attendance and Instagram remain outside the implemented provider
  scope. Link clicks can be measured; webinar attendance cannot yet be claimed.
