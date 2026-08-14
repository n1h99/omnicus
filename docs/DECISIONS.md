# OMNICUS — Architecture Decision Records

Status reviewed: 2026-08-14. ADR-001 through ADR-056 are the accepted decision
history; superseded implementation-stage language is retained for traceability.

Статус документа: обязательные решения для pilot.  
Дата фиксации: 2026-07-24.

Принятые решения изменяются только новым ADR, который заменяет предыдущий и
описывает миграционные последствия.

## ADR-001. At-least-once, transactional inbox/outbox

**Статус:** Accepted.

**Контекст:** webhook, queue worker и внешняя система не образуют общую
транзакцию. Падение возможно между database commit, enqueue, внешним вызовом и
сохранением ответа.

**Решение:**

- обещается at-least-once processing;
- end-to-end exactly-once не обещается;
- входящие события фиксируются в PostgreSQL `InboxRecord`;
- внешние операции фиксируются в PostgreSQL `OutboxRecord`;
- доменное изменение и создание inbox/outbox записи выполняются в одной
  PostgreSQL transaction;
- relay/recovery process публикует jobs в BullMQ;
- Redis/BullMQ не является источником истины;
- каждый side effect имеет idempotency key;
- состояния side effect:
  `pending → processing → succeeded | failed | unknown`;
- `unknown` обрабатывается reconciliation или ручным retry;
- ручной retry всегда создаёт audit record.

**Последствия:** потребуется outbox relay, lease/lock, recovery scan, retry
classification и reconciliation API/UI. Дубликаты исполнения допустимы, дубликаты
доменного результата предотвращаются idempotency records и provider keys.

## ADR-002. Глобальная CRM-конфигурация и отложенный реальный adapter

**Статус:** Accepted.

**Контекст:** реальный CRM API/OpenAPI не предоставлен.

**Решение:**

- CRM одна для всех проектов;
- `CRM_BASE_URL` и `CRM_AUTH_TOKEN` находятся только в environment variables;
- PostgreSQL хранит `CrmProjectConfig`: `crmProjectId`, field mapping,
  pipeline/stage и дополнительные project-specific параметры;
- до получения контракта создаются только `CrmClient` interface, mock adapter и
  fixtures;
- реальные endpoint, payload, error mapping и rate limits не предполагаются;
- реализация production CRM adapter блокируется требованиями из
  `docs/CRM_CONTRACT_REQUIRED.md`.

**Последствия:** pilot проверяет полный pipeline на mock CRM. Production CRM
интеграция не считается завершённой до contract review.

## ADR-003. JWT access token и opaque rotating refresh token

**Статус:** Accepted.

**Контекст:** refresh JWT усложняет немедленный отзыв и reuse detection.

**Решение:**

- access token — короткоживущий JWT;
- refresh token — криптографически случайный opaque token;
- БД хранит только hash refresh token;
- refresh tokens объединены в family;
- rotation инвалидирует использованный token и выпускает новый;
- повторное использование старого token отзывает всю family и создаёт security
  audit event;
- refresh cookie: `HttpOnly`, `Secure`, explicit `SameSite`, ограниченные
  `Path` и lifetime;
- cookie-based state-changing auth operations требуют Origin/Referer validation
  и synchronizer CSRF token в отдельном header;
- когда Web и API используют разные Railway public sites, refresh cookie
  использует `SameSite=None; Secure`; API принимает refresh/logout только от
  точных `CORS_ALLOWED_ORIGINS`, а SPA хранит на своём origin только
  synchronizer CSRF token;
- отдельный refresh-JWT secret не используется.

**Последствия:** нужны `Session`/token-family fields и `csrfTokenHash`.

## ADR-004. Наследование automation mode

**Статус:** Accepted.

**Решение:** effective mode вычисляется:

```text
Conversation.automationModeOverride
→ Contact.automationMode
→ automation_enabled
```

Conversation хранит nullable override, а не второе обязательное значение.
Изменение contact mode не перезаписывает conversation override.

**Последствия:** API и UI должны показывать effective mode и источник значения.

## ADR-005. Невалидные webhook

**Статус:** Accepted.

**Решение:**

- signature/secret проверяется до сохранения raw body;
- при невалидной подписи payload и секретные headers не сохраняются;
- сохраняется `RejectedWebhookAttempt` либо security log со следующими safe
  metadata: provider, connectionId, timestamp, source IP, allowlisted/redacted
  headers, rejection reason и correlation ID;
- запрос отклоняется без enqueue;
- body size limit применяется до parsing и равен 2 MB.

**Последствия:** invalid attempts пригодны для security monitoring, но не для
повторной обработки.

## ADR-006. Детерминированная семантика automation engine

**Статус:** Accepted.

**Решение:**

- условные branches проверяются по сохранённому integer priority;
- output port имеет максимум одно active edge, кроме schema-marked branching
  nodes;
- `null` не преобразуется в string/number автоматически;
- coercion разрешается только явной node configuration;
- на пару `(conversationId, scenarioId)` допускается один active Wait for Reply;
- inbound event сначала транзакционно пытается разрешить active Wait, затем может
  запускать остальные scenarios;
- reply и timeout соревнуются через conditional update/row lock; выигрывает один;
- subflow pin-ится на конкретный published `ScenarioVersion`;
- по умолчанию все matching scenarios запускаются, порядок между ними не
  гарантируется;
- события одной conversation сериализуются PostgreSQL sequence/lock policy;
- unguarded cycle — цикл без Delay, Wait или явного iteration limit; publish
  запрещён.

**Последствия:** даже если Wait/Subflow не входят в pilot, validator и data model
должны сохранять совместимую семантику.

## ADR-007. Обязательные модели и tenant integrity

**Статус:** Accepted.

**Решение:** модель включает `CustomFieldDefinition`, `Segment`, `MediaAsset`,
`CrmProjectConfig`, `InboxRecord`, `OutboxRecord`, `IdempotencyRecord`,
`PasswordResetToken`, `UserInviteToken`, `GlobalUserRole`, `ChannelConsent` и
`OrphanMessageStatus`.

Все tenant-owned таблицы имеют `projectId`. Tenant-safe relation обеспечивается
composite unique keys `(projectId, id)` и composite foreign keys, а также project
access guards.

**Последствия:** простого наличия `projectId` недостаточно; cross-project link
должен физически отклоняться БД.

## ADR-008. Media lifecycle pilot

**Статус:** Accepted.

**Решение:**

- inbound provider media сначала хранится как metadata/provider media ID;
- download выполняется только по необходимости;
- перед сохранением проверяются MIME, размер и расширение;
- assets шаблонов хранятся в private Railway Bucket;
- доступ выдаётся signed URL с коротким TTL;
- retention и delete выполняются application jobs;
- bucket не считается private network;
- server-side encryption, versioning и lifecycle policies Railway Bucket не
  обещаются.

**Последствия:** расширенная media processing pipeline отложена; чувствительность
данных определяет необходимость application-side encryption отдельным ADR.

## ADR-009. Формальные state machines

**Статус:** Accepted.

**Решение:** состояния и transitions для Project, ChannelConnection, Scenario,
ScenarioExecution, Message, Broadcast, BroadcastRecipient, InboxRecord и
OutboxRecord определяются в `docs/STATE_MACHINES.md`. Каждый transition содержит
from, event, guard, to, side effects и retry policy.

**Последствия:** service methods должны реализовывать events, а не произвольную
запись status.

## ADR-010. Scope первого pilot

**Статус:** Accepted.

**Решение:** pilot включает Auth/RBAC, projects, contacts/tags/custom field
definitions, Telegram, CRM mock, минимальный runtime, execution log,
transactional inbox/outbox и Railway deployment.

Не входят WhatsApp, Instagram, broadcasts, Delay, Wait, Subflows, полноценный
External HTTP Request editor и расширенные media workflows.

**Последствия:** общая архитектура сохраняет extension points, но UI/API и
acceptance pilot не должны требовать отложенные функции.

## ADR-011. Этапы реализации

**Статус:** Accepted.

**Решение:**

1. scaffold и ADR;
2. Auth/RBAC/Projects;
3. Contacts/Tags/Custom Fields;
4. Inbox/Outbox и Telegram adapter;
5. минимальный automation runtime;
6. CRM adapter и Telegram ↔ CRM pilot;
7. последующие функции только после pilot review.

Нумерация в implementation plan начинается с Этапа 0.

**Последствия:** hardening-инварианты не откладываются; безопасность,
идемпотентность и observability baseline входят в соответствующие ранние этапы.

## ADR-012. NFR baseline pilot

**Статус:** Accepted.

**Решение:**

- валидный webhook подтверждается без ожидания CRM;
- raw webhook body ≤ 2 MB;
- будущий External API response ≤ 5 MB;
- broadcast size для pilot неприменим;
- technical logs retention — 30 дней;
- audit retention — 180 дней;
- valid raw webhook payload retention — 30 дней;
- RPO — 24 часа;
- RTO — 4 часа;
- backup restore test обязателен и документируется.

**Последствия:** это стартовые значения, которые пересматриваются после
наблюдений pilot новым ADR.

## ADR-013. Stage 0 toolchain и workspace

**Статус:** Accepted.

**Решение:** использовать точно Node.js 24.18.0, pnpm 10.5.0 и Turborepo. Node
pin одновременно хранится в `.node-version`, `engines.node`, CI и generated
runtime manifests; preflight сравнивает полную фактическую версию с
`.node-version`. Приложения
размещаются в `apps/web`, `apps/api`, `apps/worker`; инфраструктурные библиотеки —
в `packages/database`, `packages/shared`, `packages/contracts`,
`packages/config`, `packages/channel-core`, `packages/test-fixtures`. Версии
runtime и package manager фиксируются в корневом `package.json`.

**Последствия:** Telegram, CRM и automation packages не создаются на Этапе 0;
чистая установка должна воспроизводиться из `pnpm-lock.yaml`.

## ADR-014. Prisma ownership и initial migration gate

**Статус:** Accepted.

**Решение:** Prisma schema, configuration, generated client и будущие migrations
принадлежат `packages/database`. Этап 0 создаёт и валидирует schema, но не создаёт
initial migration. Migration допускается только после отдельного отчёта с review
generated SQL. Seed разрешён только для development/test и не создаёт production
данные.

**Последствия:** health probe может проверить соединение `SELECT 1`, но доменные
таблицы не существуют до одобренной migration.

## ADR-015. Stage 0 structured logging

**Статус:** Accepted.

**Решение:** API и worker используют встроенный NestJS `ConsoleLogger` в JSON
режиме и propagation безопасного correlation ID. Дополнительная logging library
не устанавливается до появления измеримой потребности в transport/redaction,
которую встроенный logger не покрывает.

**Последствия:** логи пригодны для Railway ingestion без дополнительной
зависимости; правила PII redaction должны быть расширены вместе с бизнес-полями.

## ADR-016. Stage 0 BullMQ и outbox relay checkpoint

**Статус:** Accepted.

**Решение:** BullMQ на Этапе 0 содержит только disposable
`system-health/demo-job` для проверки consumer lifecycle. Стратегия outbox relay
не реализуется и выбирается перед Этапом 3 вместе с transactional inbox/outbox;
PostgreSQL остаётся источником истины.

**Последствия:** demo job не является durable domain command и не создаёт
архитектурного обещания о polling, notifications или delivery ordering.

## ADR-017. Railway topology и будущий cookie boundary

**Статус:** Accepted.

**Решение:** web, API и worker развёртываются как три Railway services из одного
monorepo с отдельными build/start commands и healthchecks. На Этапе 0 CORS
разрешает явный список web origins. Cookie domain, SameSite и CSRF topology
фиксируются до Auth на Этапе 1.

**Последствия:** Stage 0 не создаёт cookies и auth endpoints; production origins
не выводятся автоматически и задаются environment variables.

## ADR-018. Stage-sliced baseline и физические RBAC boundaries

**Статус:** Accepted.

**Контекст:** первоначальный full-domain Prisma proposal создавал около сорока
таблиц в первой migration. Nullable `Role.projectId` и composite references
позволяли `RolePermission` без фактического parent role, а project invite мог
потерять role boundary.

**Решение:** executable Prisma schema до Этапа 1 содержит только
Auth/RBAC/Projects и audit infrastructure. Последующие домены добавляются
отдельными migrations на своих этапах. Global и project roles, permissions,
assignments и invites представлены разными таблицами. Project relations всегда
включают обязательный `projectId`; project invite → role использует
`ON DELETE RESTRICT`. `AuditLog.project` также использует `RESTRICT` и хранит
immutable project snapshots.

**Последствия:** nullable RBAC scope и orphan assignments невозможны по
структуре. Первая migration остаётся небольшой и reviewable. Полный design
proposal в `docs/DATABASE.md` не является executable schema. Любое изменение
slice требует нового SQL diff review; migration Этапа 0 по-прежнему не
создаётся.

## ADR-019. Минимальный production web server

**Статус:** Accepted.

**Контекст:** исходный Stage 0 static server выполнял `decodeURIComponent`
вне error boundary и не обрабатывал stream errors, поэтому malformed URL либо
ошибка чтения могли завершить process.

**Решение:** сохранить минимальный Node.js HTTP server без новой runtime
зависимости. Весь request pipeline обёрнут единым error boundary; malformed
percent encoding возвращает `400`, отсутствующий asset — `404`, extensionless
route — SPA fallback. File-open/stream errors логируются и изолируются. Server
добавляет baseline security headers и отдельные live/ready endpoints.

**Последствия:** production behavior покрывается regression tests против
собранного Vite artifact. Готовый static-server package не добавляется: текущий
surface мал, а новая dependency не уменьшила бы review scope.

## ADR-020. Stage 0 dependency advisory policy

**Статус:** Accepted.

**Контекст:** audit от 24 июля 2026 обнаружил high advisories
`GHSA-c96f-x56v-gq3h` (`find-my-way <= 9.6.0`),
`GHSA-pm4m-ph32-ghv5` (`js-yaml <= 5.2.1`) и
`GHSA-qwww-vcr4-c8h2` (`react-router >= 7.12.0 < 8.3.0`). Повторная проверка
также выявила moderate `GHSA-5qjj-4xww-7phc` (`valibot <= 1.4.1`).

**Решение:** production audit блокирует high/critical. Для transitive packages
используются узкие pnpm overrides на официально исправленные
`find-my-way 9.7.0`, `js-yaml 5.2.2` и `valibot 1.4.2`; overrides проверяются
полным набором tests/build. React Router обновляется напрямую до `8.3.0`,
потому что patched 7.x не существует. `react-router-dom` удалён согласно
официальному v8 upgrade guide; declarative imports перенесены в `react-router`.

**Последствия:** major Router upgrade принят только как security remediation.
Минимальные v8 requirements выполняются Node 24.18.0, React 19.2.8 и Vite 8.1.
Новые исключения допускаются только по процессу
`docs/DEPENDENCY_EXCEPTIONS.md`; текущих исключений нет.

## ADR-021. Runtime configuration и artifacts разделены по trust boundary

**Статус:** Accepted.

**Контекст:** общий config entry point позволял browser build разрешать
server-only validation code. Загрузка `.env`, зависящая от CWD, и development
fallbacks также делали поведение clean clone, Railway и Prisma CLI
неоднозначным. Полная workspace installation не нужна в runtime artifacts API
и worker.

**Решение:**

- экспортировать browser и server configuration только через
  `@omnicus/config/web` и `@omnicus/config/server`;
- находить корневой `.env` относительно module location, а не CWD; не искать
  CWD fallback в standalone artifact и игнорировать `.env`, когда
  staging/production `APP_ENV` уже задан process environment;
- требовать явные staging/production values и проверять protocol/origin
  allowlists до bootstrap;
- собирать `.runtime` artifacts, в которых API/worker содержат только production
  dependencies, удалять недостижимые entries из pnpm isolated virtual store и
  stale generated/build output, а web source maps отключать;
- позволить Railpack выполнить lockfile installation один раз; service build
  commands выполняют preflight и filtered build без повторного install.

**Последствия:** production build/process рано завершается при отсутствующей или
опасной конфигурации. Web output сканируется на server variable/schema markers.
Prisma validate может использовать явный non-connecting placeholder, но
migration/seed не могут его унаследовать. Текущий размер Stage 0 web chunk принят
без route splitting; lazy route boundaries пересматриваются при добавлении
первых business modules.

## ADR-022. Active invitation reservation вместо partial unique Prisma selector

**Статус:** Accepted.

**Контекст:** partial `@@unique` для active invitations создавал PostgreSQL
partial unique index, но Prisma Client одновременно генерировал обычный
compound `WhereUniqueInput`. После появления historical accepted/revoked rows
`findUnique`, `update` или `delete` по такому selector могли не включать
predicate active-state и обращаться к нескольким history rows.

**Решение:** хранить invitation history отдельно от active reservation.
`GlobalActiveInviteReservation` использует primary key
`(normalizedEmail, globalRoleId)`; `ProjectActiveInviteReservation` использует
`(projectId, normalizedEmail)`. В обеих моделях `inviteTokenId` уникален и
связан composite FK с historical invitation в том же scope. Future invitation
service создаёт token и reservation в одной transaction; любой terminal
transition обновляет token и удаляет reservation в той же transaction.

**Последствия:** historical invitation могут сосуществовать, но ровно одна
active reservation существует для заданного scope. Prisma preview feature
`partialIndexes` больше не нужна в Stage 1 baseline. Baseline увеличивается с
14 до 16 tables, но остаётся stage-sliced; migration по-прежнему не создана.

## ADR-023. Создание пользователей Stage 1 через временный пароль

**Статус:** Accepted.

**Решение:** до подключения проверенного mail provider `POST /api/v1/users`
требует временный пароль, переданный уполномоченным администратором по
защищённому каналу. Пароль сохраняется только как Argon2id hash и никогда не
возвращается API, в audit или логах. Invite history/reservation модели остаются
зарезервированными для отдельного email-delivery этапа и не используются для
псевдо-email интеграции.

Project roles физически tenant-owned, поэтому нет глобальных role templates в
Stage 1 schema. Project creation transaction создаёт idempotentные system roles
для нового `projectId`; development seed делает то же для уже существующих
проектов. Это сохраняет composite project foreign keys и исключает cross-project
assignment.

**Последствия:** первый administrator и новые users могут входить сразу с
временным паролем; принудительная смена пароля, reset flow и email invitation не
реализуются в Этапе 1.

## ADR-024. Stage 2 custom-field values and archival

**Статус:** Accepted.

**Решение:** Stage 2 stores a contact's custom-field values in `Contact.customFields`
as JSON. Every write is checked against the project-local
`CustomFieldDefinition`; values not matching the declared type, or select values
outside its options, are rejected. This avoids a premature sixth value/indexing
model while channels and segmentation are absent. A deleted definition is
archived (`archivedAt`), never hard-deleted; existing contact JSON is retained
as history and is no longer editable through the API.

**Последствия:** No automatic contact merge or value deletion exists in this
slice. A later indexed-value/segment migration must explicitly backfill and
retain the same validation semantics before it can replace this representation.

## ADR-029. Contacts v2 uses typed projections, saved filters and explicit merge

**Статус:** Accepted.

**Решение:** Contacts v2 keeps `Contact.customFields` as the canonical document
for compatibility, and introduces `ContactCustomFieldValue` as a validated,
typed projection for filtering. The migration backfills valid existing values;
each subsequent contact update updates the document and projection in one
transaction. `Segment` stores a versioned declarative filter — never a copied
recipient/contact list.

Contact merge is manual, project-scoped and transactional. The chosen primary
contact keeps its identity; tags and non-conflicting identities are moved,
dependent conversations, messages, CRM operations and scenario executions are
re-parented, and the secondary contact becomes `MERGED` with an immutable
`mergedIntoContactId`. No matching by name, email or username starts a merge.

The existing `AutomationMode` values remain unchanged in this slice. A separate
automation-policy ADR is required before introducing another user-visible mode,
so existing `ENABLED`/`DISABLED` semantics do not silently change.

**Последствия:** segment predicates are constrained to known fields, tags,
channels and typed custom fields. A merge preserves historical audit and message
records but makes the secondary contact read-only.

## ADR-025. Channel secret encryption envelope

**Статус:** Accepted.

**Решение:** Channel credentials use `CHANNEL_SECRETS_KEY`, an explicit 32-byte
Base64 key, with Node.js AES-256-GCM. `ChannelSecretsService` stores only a
versioned JSON envelope and binds encryption with AAD
`projectId:connectionId:channelType:field`. Tokens and webhook secrets never
appear in reads, logs, validation payloads or audit JSON. Pilot key version is
one; later key rotation may add a previous decrypt key and a re-encryption job.

**Последствия:** API and worker require the same key in every environment,
including an explicit distinct test key. A crypto failure changes the connection
to error and records only a safe audit/security event.

## ADR-026: Telegram outbound timeout is an unknown outcome

Telegram outbound delivery is at-least-once only before a provider confirmation.
If a timeout occurs after request dispatch, Stage 3C.1 stores `UNKNOWN` for the
message and outbox record and does not blindly retry. This avoids a duplicate
customer-facing message. Operators must reconcile an unknown delivery before a
future manual retry. Explicit Telegram `429` and provider `5xx` remain retryable;
invalid credentials and recipient errors are terminal.

## ADR-027: CRM mock reconciliation uses explicit terminal retry

CRM mock operations are delivered through PostgreSQL-backed `OutboxRecord`
entries and retain the same at-least-once boundary as other external side
effects. A safe operation journal exposes only operation type, state, attempt
count, safe error code and safe provider reference.

`FAILED` operations may be requeued by a project integration manager. `UNKNOWN`
requires an explicit confirmation because a future real provider may already
have accepted the request before the observed failure. Retrying creates a new
attempt group, preserves the original idempotency key and records an audit event.
The mock adapter is intentionally not evidence of production provider delivery;
the real reconciliation contract remains blocked by `CRM_CONTRACT_REQUIRED.md`.

## ADR-028: Automation v2 uses durable resumable execution state

Delay, Wait for Reply and awaited Subflow cannot depend on an in-memory timer or
a BullMQ job as their only state. `DelayedAction` and `WaitState` are therefore
PostgreSQL-owned records bound to a tenant-safe `ScenarioExecution`; a worker
polls due records and may use BullMQ only as an execution signal. Lost jobs and
worker restarts are recovered from PostgreSQL.

Only one active wait is permitted for `(projectId, conversationId, scenarioId)`.
Reply and timeout perform a conditional state transition, so at most one wins.
A Subflow always creates a child execution pinned to the concrete published
version selected in the parent graph. A later subflow publication never changes
an already published parent. Awaited child completion resumes its parent through
an explicit persisted continuation; fire-and-forget does not block the parent.

Guarded cycles are allowed only when their cycle contains Delay or Wait; every
execution also has a bounded step budget. A cycle without a durable boundary is
rejected on publish.

## ADR-030: Telegram broadcasts snapshot recipients and delegate delivery to outbox

**Status:** Accepted.

**Decision:** A Telegram broadcast stores a declarative audience only while it is
a draft. Launch transitions it through `PREPARING`, resolves eligible Telegram
identities in bounded chunks and persists `BroadcastRecipient` rows. Every
queued recipient gets a transactionally-created outbound `Message` and
`OutboxRecord`; its idempotency key is derived from the recipient ID. The
existing Telegram outbound worker is the only component allowed to call the
provider.

**Consequences:** Recipient membership is immutable after launch, preserving a
reproducible technical result even if a Segment later changes. Pause and cancel
stop future recipient preparation/queueing; an already claimed outbox retains
its at-least-once outcome. A provider timeout remains `UNKNOWN` and is never
blindly retried by the broadcast coordinator.

## ADR-031: Private media assets and immutable template versions

**Status:** Accepted, 2026-07-27.

**Decision:** inbound Telegram media begins as a provider reference and is
downloaded only on an explicit materialization request. User-uploaded template
assets and materialized provider files are stored in a private S3-compatible
Railway Bucket. The application validates size, detected MIME type and filename
extension before upload, stores no presigned URL, and generates short-lived
download URLs on demand. The cloud Bot API `getFile` download limit is 20 MB.
The first complete media-template contract supports text, photo and PDF/ZIP
document messages.

User-uploaded and materialized JPEG, PNG and WebP photos are decoded and
re-encoded as metadata-free JPEG before storage. Images are proportionally
scaled when Telegram's dimension-sum limit would be exceeded. An aspect ratio
above Telegram's limit is corrected with the minimum white padding required;
content is never cropped implicitly. The outbound worker repeats this
normalization for legacy stored photo assets before provider upload. PDF and ZIP
documents are not rewritten: their signatures and terminal structures are
validated, then their original bytes are retained.

Templates have mutable drafts and immutable published versions. Published
scenario versions and broadcast snapshots pin a concrete published template
version; later template changes cannot alter an already published graph or
prepared broadcast.

Superseded published versions remain executable for existing pins and continue
to retain their media. New scenario/broadcast selections use the current
published version. Template variables are rendered per contact at message
creation; missing variables fail that recipient/execution with a safe code
instead of silently coercing `null` or structured JSON values.

**Consequences:** API and worker require explicit bucket configuration in
staging/production. Bucket credentials and provider tokens never enter database
content, URLs, audit payloads or frontend state. Railway Bucket is not treated
as a private network and no server-side encryption, versioning, object lock or
native lifecycle policy is promised. Retention and deletion are application
jobs.

## ADR-032: Production administrator uses an explicit one-time bootstrap

**Status:** Accepted, 2026-07-28.

**Decision:** The development/test seed remains unavailable inside Railway.
The first production or staging `Super Admin` is created by a dedicated
one-time database command after migrations. The command requires an explicit
opt-in, exact Railway project and database-name confirmations, and administrator
inputs supplied as temporary platform variables. It uses a PostgreSQL advisory
transaction lock and creates permissions, the system role, user, assignment and
audit record atomically.

The bootstrap refuses to elevate an existing unassigned user. A retry for the
single already initialized administrator is a no-op and never resets their
password. Immediately after success, all bootstrap inputs and the opt-in are
removed and the permanent API pre-deploy command returns to migration-only.
Bootstrap code is stripped from API and worker runtime artifacts.

**Consequences:** First-user creation does not weaken seed guards or add a
public registration endpoint. Production bootstrap credentials exist only
during the controlled release step and are not committed, logged or retained
as normal service configuration.

## ADR-033: Production browser API traffic uses a same-origin web proxy

**Status:** Accepted, 2026-07-28.

**Context:** Railway assigns independent public sites to the web and API
services. A refresh cookie set by the API site is therefore a third-party
cookie from the SPA's point of view, and modern browser privacy policies may
block it even when it is correctly marked `SameSite=None; Secure`. That makes
an in-memory access-token session impossible to restore after a page reload.

**Decision:** In production the SPA calls `/api` on its own web origin. The
existing lightweight web server proxies that path to the validated
`VITE_API_URL` upstream and preserves the API response status, body and
`Set-Cookie` headers. The upstream origin is fixed by the built runtime
configuration and cannot be selected by a request. Development continues to
call the configured API origin directly.

The access JWT remains in memory. The opaque rotating refresh token remains in
an `HttpOnly`, `Secure` cookie, and cookie-based operations retain synchronizer
CSRF plus exact Origin/Referer validation. Telegram webhooks continue to target
the API's separate `API_PUBLIC_URL`.

**Consequences:** Refresh cookies are first-party on the production web origin,
so F5 bootstrap does not depend on third-party-cookie support. The web service
becomes a thin browser API ingress and must preserve request bodies and session
cookies without logging them. API and worker business logic and public webhook
topology remain unchanged.

## ADR-034: Browser authentication uses a persistent bearer session

**Status:** Accepted by explicit product-owner direction, 2026-07-28. This
supersedes ADR-003 and ADR-033 only for the SPA's token storage and bootstrap
mechanism; opaque refresh support remains available to non-browser clients.

**Decision:** Login returns `{ token, user }`. The SPA stores that object under
the single `omnicus-auth` `localStorage` key, restores it on startup, and
validates the bearer token through `/auth/me`. Browser requests use
`credentials: omit`; the SPA does not issue cookie refresh requests. A `401`
clears the stored session, and logout revokes server sessions before returning
to the login route.

Browser JWTs have a seven-day default lifetime and contain a server-side
session ID. Every protected request verifies that the session and user remain
active, so disable, logout-all and session revocation invalidate an otherwise
unexpired JWT.

**Consequences:** Reload behavior no longer depends on third-party or
first-party cookies. This intentionally accepts the higher XSS exposure of
browser-readable bearer storage; CSP, dependency controls and avoiding unsafe
HTML become critical. Tokens must never enter query keys, analytics, logs,
URLs, screenshots or support payloads.

## ADR-035: Cyber Pulse uses asymmetric service contracts and durable outboxes

**Status:** Accepted, 2026-07-29.

**Context:** Cyber Pulse previously called ManyChat and customer Telegram
transports directly. Its staging replacement now exposes an authoritative,
versioned Omnicus contract. Both systems can create external side effects, and
a timeout cannot prove whether the receiving system committed an operation.

**Decision:** Omnicus-to-Cyber-Pulse calls use the reviewed Cyber Pulse OpenAPI
at backend commit `48c0d6b98aef09bd051a340e091078963014558b`.
Cyber-Pulse-to-Omnicus calls use
`docs/OMNICUS_CRM_OUTBOUND_OPENAPI.yaml`. Each direction has a different
opaque Bearer credential and independent rotation.

Both directions require project routing, correlation and stable idempotency.
Omnicus PostgreSQL remains the source of truth for CRM and Telegram outbox
intents. Network timeouts are reconciled by idempotency key; unresolved
outcomes become `UNKNOWN` and are never retried blindly. CRM outbound returns
`QUEUED`, while a separate read endpoint reports confirmed delivery state.

**Consequences:** CRM never receives Telegram credentials or raw provider
payloads and no longer sends customer messages directly through ManyChat or
Telegram. Redis outages cannot discard committed intents. Live staging E2E and
separate secret installation remain required before production acceptance or
legacy CRM cleanup.

## ADR-036: Telegram interactive media uses typed assets and durable callback acknowledgement

**Status:** Accepted, 2026-07-29. The live-inbound routing clause is superseded
by ADR-047; the media, callback and initial-history decisions remain active.

**Context:** The product needs Telegram replies, inline choices, audio, voice,
video, video notes and animations in automation, broadcasts and the Cyber Pulse
conversation bridge. Passing arbitrary URLs to Telegram or acknowledging a
callback directly inside the inbound transaction would bypass the existing
media validation and transactional outbox guarantees.

**Decision:** `Message`, `MediaAsset` and immutable template versions use typed
Telegram media kinds: text, photo, document, video, audio, voice, video note and
animation. Files uploaded by users or CRM are validated, stored in the private
bucket and referenced by `mediaAssetId`; CRM cannot instruct Omnicus to fetch an
arbitrary URL. Provider `file_id` references remain scoped to the connection
that created them.

Inline keyboards are stored as a validated, provider-independent structure.
The Telegram adapter maps that structure to `InlineKeyboardMarkup`. Incoming
`callback_query` data is normalized and may be used by deterministic condition
branches. `answerCallbackQuery` is an external side effect and therefore uses
its own stable Telegram outbox intent rather than running inside webhook
processing.

Replies received from CRM identify an Omnicus message. The API resolves that
message to a Telegram provider message ID inside the same project, connection
and conversation; callers cannot inject an arbitrary cross-conversation
provider ID.

Initial CRM history synchronization is bounded and idempotent. After the first
successful lead upsert, Omnicus schedules earlier inbound messages using stable
per-message outbox keys and original timestamps. The current event remains the
responsibility of its normal `Forward to CRM` node. PostgreSQL remains the
source of truth for both live and backfilled delivery.

Telegram video notes use `sendVideoNote`. Pilot uploads must already be a valid
square MPEG-4 video of no more than one minute. Omnicus does not silently invoke
a heavyweight transcoder or distort/crop video; optional video transcoding is a
separate future deployment decision. Reusable Telegram `file_id` values avoid
re-uploading a published greeting when the asset originated from the same bot.

**Consequences:** CRM first uploads outbound files through the authenticated
multipart media endpoint, then references the returned asset from the JSON
message request. A successful HTTP response still means `QUEUED`, not `SENT`.
Short-lived inbound download URLs are generated only after materialization and
must be fetched immediately by CRM, never persisted. Unsupported Telegram
features remain explicit capability-matrix entries instead of silently falling
back to a different message type.

The CRM bridge preserves two media classifications: `media.type` is a broad
rendering category, while `media.kind` is the exact Telegram semantic kind.
Callback queries are transferred as `interactive.callbackQueryId`, `data`,
resolved `displayText` and the original Omnicus `sourceMessageId` when it can be
resolved inside the same project and connection.

Telegram may classify otherwise previewable media as `DOCUMENT`. Omnicus keeps
that exact provider kind, but may materialize the document when its bytes,
declared MIME type and filename match one of the explicitly recognized safe
signatures. This does not reinterpret the provider event as an animation,
audio or video message.

## ADR-037: Confirmed Omnicus outbound messages are synchronized to CRM history

**Status:** Accepted, 2026-07-29.

**Context:** Cyber Pulse receives normalized inbound Telegram events and records
messages created from its own composer, but an outbound message created by an
Omnicus automation or broadcast was absent from CRM history. A callback could
therefore arrive before CRM knew the source message and could not render a
reference preview.

**Decision:** A Telegram outbound message is eligible for CRM history only
after Telegram confirms it as `SENT`. In the same PostgreSQL transaction that
stores the provider message ID and completes the Telegram outbox, Omnicus
creates a separate CRM outbox intent with the stable key
`crm-outbound-history-<messageId>`. CRM-originated messages are excluded to
prevent a synchronization loop.

Both the immediate path and recovery scan require the originating Telegram
outbox to be `SUCCEEDED`; setting a message row to `SENT` is not delivery proof.
The normalized provider message ID must be the positive decimal representation
of the integer Telegram `message_id`. Synthetic identifiers are rejected and cannot
materialize a CRM history bubble.

The explicit service contract is
`POST /integrations/v1/omnicus/messages/outbound`; an outbound event is never
misrepresented as inbound. It carries the stable Omnicus message UUID, the
Telegram provider message ID, original occurrence time, source
(`AUTOMATION`, `BROADCAST`, or `SYSTEM`), normalized text/media/buttons, and
project-scoped identity. A bounded recovery scan creates missing intents for
historical automation/broadcast messages. CRM must accept the source message
after an already stored callback and resolve that reference by
`sourceMessageId`.

**Consequences:** Telegram delivery and CRM history synchronization remain two
independent external side effects with separate retry/unknown states. A CRM
outage cannot roll back a Telegram send. PostgreSQL remains the recovery source
of truth, concurrent worker replicas are harmless, and no Telegram credential,
raw payload, or signed media URL is persisted in the CRM operation journal.

Live v3.2 reaction acceptance additionally established that the CRM reaction
result identifies the affected CRM message rather than a separate reaction
entity. The versioned result is `{applied, crmLeadId, crmMessageId?, mode,
operationId}`: `crmMessageId` is required when `applied=true` and omitted while
reaction-before-source is pending. Omnicus uses `operationId` as the temporary
provider reference for that pending state. This shape must also be preserved
inside reconciliation `result` so a successful CRM write is not classified as
`UNKNOWN` merely because its source message has not arrived yet.

## ADR-038: CRM connections are paired and routed per project

**Status:** Accepted, 2026-07-29.

**Context:** `CrmProjectConfig` already isolates external project mapping, but
the CRM base URL and both service credentials are deployment-wide environment
variables. That permits multiple Omnicus projects to target one CRM deployment,
but it cannot safely connect independent CRM installations without editing
Railway variables and restarting every service.

**Decision:** Each Omnicus project owns at most one active `CrmProjectConfig`.
The record contains the CRM adapter, exact HTTPS origin, external project ID,
connection status, capabilities, a hash of the CRM-to-Omnicus Bearer token and
an AES-256-GCM envelope for the Omnicus-to-CRM Bearer token. Encryption uses the
existing `CHANNEL_SECRETS_KEY`; AAD binds the ciphertext to the Omnicus project,
CRM connection ID, adapter and secret field.

Pairing is an explicit, short-lived handshake:

1. An Omnicus project administrator requests a random, single-use pairing code.
   PostgreSQL stores only its SHA-256 hash and expiry.
2. A CRM administrator submits that code and the Omnicus API origin from the CRM
   integrations screen.
3. The CRM creates its own random inbound credential and sends it, its exact
   public origin and external CRM project ID to the public Omnicus pairing
   endpoint over HTTPS.
4. Omnicus consumes the code atomically, stores the CRM credential encrypted,
   creates a separate CRM-to-Omnicus credential, stores only its hash and
   returns that credential once.
5. The CRM stores the returned credential encrypted with its deployment master
   key. Neither side returns either credential after pairing.

All integration requests authenticate to one connection before project routing
is evaluated. A valid token for one connection cannot address another Omnicus
or CRM project. Test, disable and credential rotation are audited and never
include secrets. Legacy environment credentials may be read only as a bounded
migration fallback for an already deployed connection; new connections never
depend on them.

**Consequences:** Adding another CRM deployment is an application operation,
not a Railway configuration change. Railway retains only infrastructure-wide
master encryption keys and platform resources. A lost pairing response is
treated as an unknown provisioning result: the operator starts a new pairing,
which rotates both credentials and invalidates the unfinished attempt.

## ADR-039: Telegram Chat v3 separates durable mutations from ephemeral signals

**Status:** Accepted, 2026-08-01.

**Context:** The CRM Telegram workspace needs formatting, message mutations,
reactions, pinning, typing indicators and streamed previews. Telegram Bot API
10.2 supports these features with different guarantees. Edit/delete/reaction
and pin calls change durable chat state, while `sendChatAction` lasts at most
five seconds and `sendMessageDraft` is a temporary 30-second private-chat
preview that must be finalized with a normal message.

**Decision:** Durable Telegram mutations use the existing PostgreSQL outbox,
stable CRM idempotency keys, leases, retry/backoff and `UNKNOWN` semantics.
They reference an Omnicus message UUID; Omnicus resolves the provider message
ID only after verifying project, connection, identity, contact and conversation
scope. A terminal `FAILED` operation can be retried through an explicit new
attempt. An `UNKNOWN` operation cannot be retried until reconciliation resolves
the uncertain provider outcome.

Chat actions and streamed drafts are intentionally ephemeral. They are sent
through the Telegram adapter, are never inserted into message history and are
never represented as `QUEUED` or `SENT`. Capability discovery is authoritative:
CRM must hide a feature when the capability is absent or reports
`supported=false`. Omnicus scheduling is application-owned delayed outbox work;
it must not be described as Telegram-native scheduling.

**Consequences:** Redis remains a delivery accelerator and PostgreSQL remains
the source of truth for durable changes. Ephemeral signals may be lost during
an outage without corrupting chat history. Bot tokens are decrypted only
immediately before a Telegram request. Provider payloads, credentials and
message content remain absent from operational/audit logs.

## ADR-040: Telegram reactions are normalized events, effects have no invented catalog

**Status:** Accepted, 2026-08-01.

**Context:** Telegram reaction changes arrive as separate webhook updates and
may race with the source-message history operation. CRM also needs a selectable
message-effect catalog, but Telegram Bot API 10.2 accepts
`message_effect_id` without exposing a bot method that lists effect IDs. The
similarly named `messages.getAvailableEffects` belongs to the user MTProto API
and is explicitly unavailable to bots. Empty `sendMessageDraft` text is an
official “Thinking…” placeholder, not a cancellation operation.

**Decision:** A user reaction is persisted as a `REACTION`
`NormalizedEvent`, never as a synthetic message. Its CRM event references the
stable Omnicus UUID of the reacted-to message and uses its own normalized event
UUID for idempotency. If the provider message mapping is not yet present, the
inbox attempt is retryable. Omnicus-to-CRM delivery uses the ordinary CRM
transactional outbox and can therefore arrive before the separate source
history operation without losing its stable reference.

Omnicus publishes an empty `availableEffects` list plus a stable
`BOT_API_EFFECT_CATALOG_UNAVAILABLE` reason instead of fabricating provider
IDs, labels or emoji. A known effect ID can still be passed through the
provider API, but CRM must not expose a free-form production selector.

Omnicus treats an empty draft update as a local no-op and never calls Telegram
with it. Bot API exposes no explicit draft-cancel method; stopping updates lets
the preview expire within 30 seconds, while the final ordinary outbound
message is the documented finalization operation. Message edits expose only
fields accepted by `editMessageText`/`editMessageCaption`; protection, effect,
reply and quote state are immutable through the edit endpoint and remain
preserved provider state.

**Consequences:** Reactions keep at-least-once/recovery guarantees and cannot
cross project or connection boundaries. Capability discovery remains honest
when Telegram exposes a send feature but withholds catalog discovery. CRM can
render explicit edit semantics without attempting unsupported mutations or
creating a lingering “…” preview during draft cleanup.

## ADR-041: Telegram stickers are typed media; albums require a separate aggregate

**Status:** Accepted, 2026-08-01.

**Context:** The remaining Chat v3 media scope includes stickers, spoiler
presentation, and media albums. Telegram Bot API 10.2 sends a sticker as one
message, while `sendMediaGroup` returns two to ten distinct messages. Treating
an album as repeated independent sends would lose its atomic provider result,
shared caption semantics, and stable relationship between the logical request
and every provider message ID.

**Decision:** `STICKER` is added to the existing typed `Message`/`MediaAsset`
pipeline. Uploaded sticker bytes are signature-checked and constrained to the
documented WEBP, TGS, or WEBM format limits before private storage. Provider
`file_id` reuse remains restricted to the owning connection. Stickers do not
accept captions. `hasSpoiler` is allowed only for photo, video, and animation
messages and is persisted as safe outbound metadata.

Media albums will use a dedicated aggregate and versioned endpoint in the next
slice. Until that aggregate has transactional persistence, an array of uploads
must not be implemented as several ordinary outbound calls and the
`mediaGroups` capability remains disabled.

**Consequences:** Sticker delivery inherits the ordinary durable outbox,
lease, retry, `UNKNOWN`, recovery, and CRM history guarantees. Spoilers do not
change media identity. Albums remain honestly capability-gated rather than
claiming provider atomicity that PostgreSQL does not represent.

## ADR-042: CRM provider extensions use durable aggregates and normalized events

**Status:** Accepted, 2026-08-02.

**Context:** Cyber Pulse requested source metadata, client-originated edits,
temporary automation pause, application scheduling, Telegram albums, contact
shares and bot-interface configuration. Telegram Bot API 10.2 was rechecked on
2026-08-02. It exposes `edited_message`, `sendMediaGroup` (2-10 items),
`sendContact`, `setMyCommands` and `setChatMenuButton`, but no native scheduled
message lifecycle and no reliable update for arbitrary external deletion.

**Decision:** Provider contract 3.2.0 adds these facilities behind
connection-scoped capability discovery. Application scheduling uses PostgreSQL
due records and the existing Telegram outbox. Albums use one aggregate and one
provider call. Conversation state uses revision-based optimistic concurrency;
automatic resume is a PostgreSQL recovery scan. Edits and contact shares use
normalized inbox events and transactional CRM outbox intents. Scenario and
broadcast history carries a safe optional `sourceContext` object with stable
identifier, display name and an allow-listed Omnicus web URL.

CRM schedule enumeration, lookup and cancellation are lead-scoped rather than
project-wide. The public route requires both `connectionId` and
`omnicusContactId`; optional `channelIdentityId` and `crmLeadId` further narrow
the same database query. Responses expose those routing identifiers but never
the stored request JSON or message content. A mismatched scope is reported as
not found, including when a valid `scheduleId` belongs to another lead.

External Telegram deletion stays `supported=false`. External actions stay
`supported=false` until Cyber Pulse publishes the callback ownership,
authentication and retry contract. Telegram-native rich messages are not used
as a portability layer; structured contact/location/poll requests have an
explicit normalized fallback and capability entry.

**Consequences:** `QUEUED` still does not mean `SENT`; `UNKNOWN` cannot be
blindly retried. All new records and lookups include project, connection,
identity and contact scope. Provider payloads, signed URLs and credentials are
not persisted or returned.

## ADR-043: Automation Studio 2.1 keeps authoring metadata in scenario versions

**Status:** Accepted, 2026-08-02.

**Decision:** Automation Studio 2.1 improves the existing Telegram-only runtime
without adding another side-effect boundary or changing published scenario
versions. Condition values, human-readable duration choices and Wait for Reply
criteria are compiled into the existing versioned graph. Durable waits continue
to store a copy of their normalized criteria in `WaitState.criteria`; no process
memory or BullMQ job becomes authoritative.

Wait criteria are a bounded discriminated contract: any supported customer
reply, text comparison, callback-data comparison, or an allowlisted media type.
Regular expressions are intentionally excluded from this slice to avoid an
unbounded evaluation surface. Empty criteria from older published versions are
interpreted as any supported customer reply.

Condition groups are deliberately flat and bounded to 20 rules. A connection may
carry either one legacy condition or one AND/OR group, never both. Exactly one
unconditioned connection may act as the fallback when configured branches exist.
Legacy scenario versions that keep their condition on the node remain executable.

Draft autosave uses the scenario `updatedAt` value as an optimistic concurrency
token. A stale writer receives `SCENARIO_DRAFT_CONFLICT` and autosave stops instead
of overwriting the other draft. Undo/redo and clipboard history remain local UI
state and are not added to the published graph or database schema.

The execution inspector may expose only safe diagnostic metadata such as event
type, selected output, next node, suspension state and timestamps. Customer
message bodies, template text, contact values, secrets and raw provider payloads
must not be copied into `NodeExecution.inputSafe` or `outputSafe`.

Test run and replay are pure graph simulations. Replay may reuse a stored
execution's normalized event/contact context, but it never calls Telegram or CRM,
changes contacts/tags, or creates durable Delay/Wait state. A replay audit records
only the execution ID, completion flag and step count.

**Consequences:** Existing published graphs remain executable. Editor resource
selectors resolve tags and active custom-field definitions through existing
project-scoped APIs, while the saved graph keeps stable IDs/keys. Regex matching,
side-effecting retry/replay, arbitrary HTTP actions and additional channels remain
separate reviewed slices.

## ADR-044: External HTTP is a durable, SSRF-safe automation continuation

**Status:** Accepted, 2026-08-02.

**Decision:** Automation Studio 2.2 adds `EXTERNAL_HTTP_REQUEST` as an explicit
two-branch continuation. Runtime execution transactionally creates one
project-scoped HTTP outbox operation keyed by scenario execution and node, then
suspends. A stateless worker validates and pins DNS, performs the request and
resumes exactly one `success` or `failure` edge. A mutating request whose
transport outcome is uncertain remains `UNKNOWN`; it is never retried blindly.
Every request carries the stable outbox ID as `Idempotency-Key`.

Production requests require HTTPS, reject URL credentials, loopback, private,
link-local, multicast, reserved and cloud-metadata targets, pin the validated IP
for the connection, and revalidate every permitted redirect. Hop-by-hop and
forwarding headers are blocked. Time, request-body and 5 MB response limits are
hard bounds. Responses are never persisted wholesale. Only explicitly mapped
JSON paths enter execution variables, while diagnostics retain safe status and
size metadata.

Secrets are separate encrypted project records and scenario versions contain
only their IDs. Secret values are write-only, use record-bound AES-GCM AAD and
are never returned in API responses, graph JSON, execution diagnostics or logs.
Publish rejects missing, archived or cross-project references.

Draft persistence and publish validation are separate boundaries. Structurally
valid graphs may be autosaved with missing connections or incomplete node
configuration and retain validation errors. Publish and test run still require a
fully valid graph. Autosave reports a quiet status and does not animate the
manual Save button; selected connections have an explicit delete action.

**Consequences:** PostgreSQL remains authoritative for the pending continuation;
worker loss cannot lose it. The first release supports bounded methods, headers,
query/body templates, response mapping, safe test requests and explicit outcome
edges. It does not provide arbitrary code, `eval`, unrestricted redirects,
cookies, raw response retention or automatic retry of uncertain mutations.

## ADR-045: Telegram 10.2 rich content and recurrence extend the existing outbox

**Status:** Accepted, 2026-08-02.

**Decision:** Contract 3.3 adds reply keyboards, Force Reply, application-owned
recurring schedules and Telegram-native rich messages without creating a second
delivery path. Reply markup is a bounded discriminated value stored with the
ordinary message metadata and delivered by the existing Telegram outbox. The
first reply-keyboard slice supports text, request-contact and request-location
buttons; arbitrary Web Apps and user/chat request payloads remain outside this
contract.

Recurring schedules keep exactly one future occurrence durable at a time. A
successful occurrence transactionally creates the next `Message`,
`OutboxRecord` and `ScheduledMessage` in the same series. PostgreSQL remains the
source of truth; worker timers only wake due outbox rows. The reviewed recurrence
rule is `DAILY | WEEKLY`, an interval from 1 through 30, and an optional total
count or inclusive `until` bound. Occurrences retain the original IANA timezone
and local wall-clock intent across DST. Cancellation of the current queued
occurrence terminates the series. A revision guards schedule updates and no
update may rewrite a processing or terminal occurrence.

Telegram Bot API 10.2 is the authoritative rich-message provider contract.
Omnicus accepts bounded rich Markdown and at most one typed CRM-owned media
asset in the first release. Rich Markdown may contain links, but external media
URLs are rejected; Telegram receives either the already scoped provider media
ID or bytes read from Omnicus private storage. `sendRichMessageDraft` is
ephemeral and never creates a message. Because Telegram forbids direct uploads
in rich drafts, a media-rich draft is accepted only when that asset already has
a reusable media ID for the same connection. Capability discovery exposes this
restriction explicitly.

External action callbacks remain disabled. They require a separate decision on
public endpoint ownership, authentication, replay window and retry semantics.

**Consequences:** all durable rich sends and recurring occurrences preserve the
ordinary `QUEUED → PROCESSING → SENT | FAILED | UNKNOWN` lifecycle and
idempotency rules. No provider token, signed URL, raw Telegram response or
arbitrary remote media URL is persisted. CRM can safely gate each feature and
must finalize a draft through the ordinary durable outbound endpoint.

## ADR-046: Automation drafts are saved only by an explicit operator action

**Status:** Accepted, 2026-08-02. Supersedes the editor-autosave clauses of
ADR-043 and ADR-044.

**Context:** A graph round-trip can mark an editor session dirty immediately
after loading. Background PATCH attempts then repeat an unsuccessful save,
produce avoidable API traffic and make the manual **Save draft** button appear
active even though the operator did not request persistence.

**Decision:** Automation Studio keeps graph, form and undo/redo changes in local
React state until the operator presses **Save draft**. Dirty state remains
visible and protects browser unload/navigation. The explicit save sends the
latest graph once, carries `expectedUpdatedAt` for optimistic concurrency and
shows its spinner only for that user-triggered request. A conflict remains
terminal for the current editor state until reload/merge; it is never retried
in the background.

**Consequences:** PostgreSQL remains authoritative only for the last confirmed
save. Closing or reloading with unsaved changes can discard local edits after
the existing warning. Structurally incomplete drafts remain saveable, while
publish and test validation stay strict. There are no timer-driven scenario
update requests.

## ADR-047: Active CRM pairings receive Telegram inbound messages independently of automation

**Status:** Accepted, 2026-08-02. Supersedes only the ADR-036 statement that the
current inbound event is the responsibility of a `Forward to CRM` node.

**Context:** A valid Telegram Force Reply response reached the transactional
inbox and triggered its automation, but it was absent from CRM history because
the active test scenario did not contain `Forward to CRM`. Changing or pausing
an automation must not silently remove customer messages from the operator's
conversation history.

**Decision:** When CRM integration and the project pairing are active, the
Telegram inbound transaction creates the CRM intent independently of scenario
execution. A linked contact uses the stable `crm-history-<messageId>` key. An
unlinked contact first uses one stable `crm-contact-bootstrap-<contactId>` lead
operation; its existing bounded history backfill then schedules the stored
messages. A legacy `Forward to CRM` node reuses the already queued normalized
event instead of creating a second delivery.

The Telegram adapter normalizes `reply_to_message.message_id`. The worker
resolves it to an Omnicus message UUID only inside the same project, connection,
conversation and contact, then contract 3.2.3 sends the optional
`replyToMessageId`. CRM rejects a known cross-conversation target, stores a
same-conversation or not-yet-materialized reference, and renders the preview
only when the source is present in that conversation.

**Consequences:** CRM chat completeness no longer depends on the published
automation graph. PostgreSQL inbox/outbox durability, at-least-once delivery,
per-message idempotency, media materialization and reconciliation rules stay
unchanged. No Telegram payload, message text or credential is added to safe CRM
operation metadata.

## ADR-048: Automation authoring and delivery diagnostics use one stable human model

**Status:** Accepted, 2026-08-02.

**Context:** Hydrating API graphs into canvas defaults could immediately mark an
unchanged draft dirty. Version history required a reload, validation and Safe
Test exposed raw graph IDs, and a successful `SEND_MESSAGE` node did not prove
that its Telegram outbox had delivered anything. External HTTP also used one
Node `BlockList` for both address families; the IPv4-mapped IPv6 deny range then
matched public IPv4 checks and rejected safe public targets.

**Decision:** The editor computes its saved signature from the hydrated graph,
keeps version detail synchronized after explicit save, previews immutable graph
JSON directly, and uses stable human node labels throughout validation, test
simulation and execution inspection. Safe Test exposes only outcomes used by
the current graph and remains blocked by concrete validation issues. Canvas
lock covers every mutation, connection handles have stable enlarged hit areas,
and the palette is searchable. A scenario cannot offer itself as a Subflow.

`SEND_MESSAGE` and `SEND_TEMPLATE` must either queue one message/outbox pair or
fail. Their node journal stores only those IDs; the API resolves current scoped
statuses for operator diagnostics. IPv4 and IPv6 target deny lists are separate.
Mixed DNS answers may select and pin one validated public address, while a set
with no public address remains forbidden and redirects repeat the same check.

**Consequences:** Reloading an untouched draft stays clean, saved versions are
visible immediately, and `Step completed` is distinct from Telegram delivery.
No payload, rendered message, HTTP body, secret or credential is added to
diagnostics. SSRF protections remain fail-closed when no public target exists.

## ADR-049: Automation resource validation is proactive and custom-field clearing is explicit

**Status:** Accepted, 2026-08-03.

**Context:** A saved draft may outlive a tag, custom field, template, subflow or
HTTP secret it references. Waiting for Publish to reject that stale reference
leaves Test/Publish looking available and returns only a safe server code. A
contact value also needs an explicit removal action distinct from changing or
deleting the project field definition.

**Decision:** Automation Studio validates loaded active project resources in
addition to structural graph validation. Unreachable nodes and stale resource
references block Test/Publish, focus the affected node or connection, and keep
explicit draft saving available. The server repeats every project-scoped check
as the authority for races. `CLEAR_CUSTOM_FIELD` identifies one active field by
key and transactionally removes only the current contact's JSON value and typed
projection.

Editor dirty comparison is semantic: graph ordering and editor-only connection
IDs do not change the saved signature. Empty optional descriptions are omitted
on create and explicitly cleared on update.

**Consequences:** Operators see actionable validation before a request, while
stale clients cannot bypass server isolation. Clearing a value cannot archive a
field definition or affect another contact/project. Incomplete drafts remain a
supported authoring state; only execution and publication require a fully
reachable, resource-valid graph.

## ADR-050: Operations, account lifecycle and system health reuse durable journals

**Status:** Accepted, 2026-08-03.

**Context:** Omnicus already persists inbox, outbox, execution and audit records,
but operators have to inspect several feature-specific screens. Password-reset
and invitation token tables also exist without a complete product workflow, and
project roles cannot be authored from the application. Platform health is
available only through service probes and does not explain queue or terminal
operation pressure.

**Decision:** The Operations Center reads bounded, project-scoped projections
from the existing inbox, outbox, scenario, broadcast and CRM journals. It never
returns raw webhook bodies, outbox payloads, credentials, customer content or
secret values. Terminal retries are conditional state transitions with a reason
and audit record. `UNKNOWN` is never treated as a failure: an operator must
record provider evidence as applied or not applied before the journal can move
to `SUCCEEDED` or `RETRY`.

Audit history is exposed as a separately permission-guarded safe projection.
Custom global/project roles may contain only permissions from their matching
scope; seeded system roles remain immutable. Invitation and password-reset links
are random, hashed at rest, time-bounded, single-use and returned only at their
creation boundary for delivery by an authorized operator. Acceptance never
reveals whether another account exists and revokes active sessions after a
password reset.

Project cloning copies only project configuration and custom role definitions.
It creates a new project-admin membership for the actor and never copies
contacts, identities, messages, executions, channels, CRM credentials, media,
automation secrets or history.

System Health is a `roles:manage`-guarded projection over dependency probes, a bounded
BullMQ worker round-trip, queue counts and safe database aggregates. Active terminal
operation alerts use records updated within the last 24 hours. Older terminal
records remain visible as historical attention items grouped by project, with
links to scoped Operations filters, but do not degrade current platform status.
Alerts are derived from authoritative state rather than becoming another source
of truth. Sentry and backup management are explicitly outside this slice;
Railway backup policy remains operator-owned.

**Consequences:** PostgreSQL journals remain authoritative and Redis remains an
execution/health signal only. Operations UI cannot leak stored payloads or turn
an uncertain side effect into a blind retry. No Prisma schema change is required
because the reviewed token, role, project, audit and operation models already
contain the necessary durable state.

## ADR-051: Automation Activity is a bounded read model over execution journals

**Status:** Accepted, 2026-08-03.

**Context:** Operators need to understand which contacts entered an automation,
where each journey is now, how it ended and why it stopped without opening every
scenario version or interpreting internal enum/error values. Product-level
charts must not create a second analytics source of truth or expose stored event
payloads and variables.

**Decision:** Automation Activity reads existing project-owned
`ScenarioExecution`, `NodeExecution`, `WaitState` and `DelayedAction` records.
The route requires `automation:read`, applies the active `projectId` at the root
query, limits the selected period to 7, 30 or 90 days and paginates at no more
than 50 journeys. Exact counts use PostgreSQL aggregation. Trend and drop-off
charts use a declared bounded sample of the latest 2,000 matching executions.

The response contains contact display fields, scenario/version identity,
human-safe status/reason categories and a step timeline. It never selects
execution variables, trigger payloads, node input/output, provider responses,
message text, secrets or credentials. Internal permission, audit, entity,
status and error codes remain machine contracts but are translated before
display. Accessible action names use `aria-label`; intrusive visual hover
tooltips are not part of the operator UI.

**Consequences:** PostgreSQL remains the only source of execution truth and no
schema migration is required. The Board can refresh safely without touching
runtime state. Exact totals remain reliable even when a high-volume chart is
sampled, and a sampled chart is labelled as such in the UI.

Automation Activity is presented as a project workspace tool only. The global
sidebar does not duplicate it or require a project-selection detour; the protected
project route and its permission boundary remain unchanged.

## ADR-052: WhatsApp Cloud API reuses the durable channel journal and enforces the service window

**Status:** Accepted, 2026-08-03.

**Context:** WhatsApp differs from Telegram in credential/onboarding shape,
batched signed webhooks, delivery/read receipts, approved templates and the
customer-service window. Treating it as a renamed Telegram bot would bypass
Meta policy or lose provider status facts. A Meta App and test WABA are not yet
available, so a live signup result cannot be invented.

**Decision:** Omnicus integrates only the official WhatsApp Business Platform
Cloud API. The provider adapter was reviewed against Meta's official Cloud API,
Webhook Payload Reference, Media, Templates and Embedded Signup Postman
collections on 2026-08-03. Those official collections use a `{{Version}}`
placeholder rather than proving a current numeric version. Graph API version is
therefore explicit configuration required before WhatsApp connection and is
never guessed or sent as an unversioned Graph URL.

Meta owns one app-level `GET/POST /webhooks/whatsapp` callback rather than a
callback per phone connection. Valid POST webhooks require the exact raw bytes
and a timing-safe `X-Hub-Signature-256` HMAC-SHA256 match using the global Meta
App secret. GET verification uses the independent global verify token. Both
values are server-only environment configuration. Invalid bodies create no
raw/inbox record.

Only after signature verification does the API resolve
`value.metadata.phone_number_id` and entry WABA ID against unique indexed
connection fields. A multi-account envelope is split into bounded exact
individual message/status/reaction items; one project's raw table never
receives another project's change. Unknown phone IDs are acknowledged without
payload storage. Each matched item gets one raw event and one inbox record with
a stable provider-derived key before the 200 response.

All inbound messages, outbound sends, media fetch/upload and status updates
reuse project/connection-scoped PostgreSQL inbox/outbox/message records.
Outbound provider calls use `/{phone-number-id}/messages`; media uses the
official media endpoints. Timeouts after a possible side effect become
`UNKNOWN` and are not blindly retried. Meta `sent`, `delivered`, `read` and
`failed` status callbacks are stored as safe facts and update the message
projection monotonically.

Free-form messages are allowed only while the persisted WhatsApp service
window is open. Outside that window the request must reference a currently
approved, connection-scoped Meta template. Template sync stores only an
allow-listed normalized projection; Meta remains the status authority.

This accepted post-pilot decision supersedes the earlier provisional WhatsApp
notes that limited onboarding to manual setup, placed a callback in each
connection URL, stored app-level webhook secrets per connection, or named a
`SUBMITTED` state without provider evidence. Those shapes do not match the
approved product request and the verified Meta app-level boundary.

Connection setup supports a safe manual DRAFT path immediately. Embedded
Signup setup/complete endpoints are capability-gated by server-side Meta App
ID, app secret and configuration ID. Until those authoritative values exist,
the API returns `WHATSAPP_META_CONFIGURATION_REQUIRED`; it never fabricates an
OAuth URL, authorization code, WABA, phone number or successful subscription.
Per-connection access tokens are write-only encrypted values. The app secret
and webhook verify token remain server-only deployment configuration and are
never returned by the API.

WABA subscription is shared by every phone number under that WABA. Disabling a
single connection stops its local processing but does not unconditionally call
`DELETE /subscribed_apps`; Omnicus may unsubscribe only when no other active
connection depends on that WABA. Repeated or out-of-order status callbacks are
deduplicated by connection, provider message ID, status and provider timestamp.
The current projection advances `SENT < DELIVERED < READ`; `FAILED` cannot
overwrite later delivery/read evidence. A successful messages response with a
`wamid` is accepted/sent evidence only, never delivered/read evidence.

Cyber Pulse contract `4.0.0` extends the existing routes with discriminated
`identity.channel = telegram | whatsapp`. Every CRM-originated send verifies
project, contact, connection and identity together. WhatsApp inbound/outbound
history and normalized status events use the existing independent CRM
credential, transactional outbox and idempotency/reconciliation boundaries.

**Consequences:** Telegram behavior remains backward-compatible. WhatsApp can
be implemented and automatically tested without live credentials, while real
signup, template approval and delivery/read acceptance remain explicit final
external gates. Provider payloads, temporary media URLs and secrets do not
enter business records or CRM contracts.

## ADR-053: Explicit contact merge is reconciled across Omnicus and Cyber Pulse

**Status:** Accepted, 2026-08-08.

**Context:** One person may have separate Telegram and WhatsApp contacts and
therefore separate CRM leads. Removing only the secondary Omnicus contact leaves
a duplicate CRM lead, while fuzzy merging by name, email or phone can combine
different people. Merges completed before the CRM callback also require repair
without replaying unrelated customer data.

**Decision:** Merge remains an explicit project-scoped operator action. Omnicus
transactionally selects a primary contact, reparents its dependent records,
marks the secondary as `MERGED` and creates one stable `MERGE_CONTACTS` CRM
outbox operation. Cyber Pulse selects one surviving project lead, repoints both
Omnicus links and preserves Telegram and WhatsApp conversations/messages before
removing the redundant lead. Replays return the existing result.

Migration `20260808000000_crm_contact_merge` records the required persistence.
A bounded worker CLI scans only durable historical merge evidence, defaults to
dry-run, supports a project filter and uses one idempotency key per pair. It
does not infer pairs from PII.

**Consequences:** After convergence each explicit pair appears as one contact
and one CRM lead with both channel histories. PostgreSQL outbox and CRM
idempotency remain the recovery boundary. Ambiguous/conflicting records stop
the backfill for operator review rather than guessing.

## ADR-054: WhatsApp scheduling is one-shot and bounded by the service window

**Status:** Accepted, 2026-08-08.

**Context:** Cyber Pulse needs the existing schedule workflow for WhatsApp, but
Meta free-form policy is still governed by the last authoritative inbound user
message. Telegram recurrence cannot be copied to WhatsApp without creating
future sends outside the known service window.

**Decision:** The shared schedule API is channel-aware. Telegram keeps one-shot
and bounded DAILY/WEEKLY recurrence. WhatsApp accepts one text occurrence only,
requires `scheduledAt` inside the currently open service window and repeats the
guard when the worker claims the due outbox. Recurrence, media and interactive
scheduled content are rejected with safe codes; an expired window never causes
an implicit template conversion or provider call.

**Consequences:** CRM can offer a consistent Schedule action without overstating
Meta capabilities. PostgreSQL owns the schedule, optimistic revision and
recovery. Capability discovery advertises no WhatsApp frequencies and a maximum
count of one.

## ADR-055: Public lead capture and tracked links use durable opaque boundaries

**Status:** Accepted, 2026-08-14.

**Context:** Website registrations must create/update contacts, start an
automation and synchronize CRM without letting a public caller impersonate an
operator or create duplicate effects. Webinar links need per-contact click
evidence without exposing PII in URLs.

**Decision:** Each website source uses a project/source-derived ingest key and a
required caller idempotency key. The API persists `LeadCaptureEvent` and contact
state before asynchronous CRM/automation work. Tracked links use opaque tokens,
store the original allowlisted HTTP(S) target server-side and forward normalized
click facts through the CRM outbox. Reusing an idempotency key with another
fingerprint is rejected.

**Consequences:** Website retries and worker restarts are safe, but an accepted
request is not downstream delivery evidence. The ingest key is server-only.
Omnicus can prove link clicks, not attendance inside Zoom or another external
platform.

## ADR-056: Email is a separate durable Resend delivery channel

**Status:** Accepted, 2026-08-14.

**Context:** Marketing email needs campaign drafts, scheduling, templates,
attachments, analytics, unsubscribe and CRM history. Modeling it as Telegram or
WhatsApp would invent a chat identity and reuse incompatible provider states.

**Decision:** Email owns dedicated campaign, delivery, event, suppression and
asset-reference models. The worker calls Resend with stable idempotency and
lease recovery; the API verifies signed webhooks and hosts unsubscribe flows.
Published template versions are immutable. Current eligibility is active
contact plus valid email plus no project suppression; consent metadata remains
auditable but is not an extra product filter. Provider events are monotonic and
forwarded through the CRM outbox.

**Consequences:** SMS remains a separate unimplemented provider scope. Auth
invitation/reset delivery is not implicitly coupled to marketing email. A
campaign snapshot is recoverable and deduplicated, while provider acceptance,
delivery and clicks remain distinct evidence.
