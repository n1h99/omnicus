# OMNICUS — Prisma schema and migration design

Current status (reviewed 2026-08-14):
`packages/database/prisma/schema.prisma` is the executable platform schema with
62 models. Reviewed ordered migrations cover Auth/RBAC, contacts, Telegram
inbox/outbox and chat v3.3, automation and continuations, CRM, broadcasts,
media/templates, Automation Studio 2.2 External HTTP, WhatsApp Cloud API,
cross-system merge, lead capture/tracking, WhatsApp mailing eligibility and
email campaigns through `20260814030000_email_campaigns`. Railway applies these migrations
once through the designated release path.

The stage-by-stage prose and model excerpts below record the design evolution.
Where an old paragraph says a later model is only proposed or not deployed,
the executable Prisma schema and migration directory now define the current
truth. The invariants and review checklists remain mandatory.

## Статус

Executable baseline находится в
`packages/database/prisma/schema.prisma` на Prisma 7.9.0. На Этапе 0 он должен
проходить `prisma validate` и SQL diff review, но не является migration и не
применяется к БД.

Initial migration будет stage-sliced. Первый baseline Этапа 1 содержит только
Auth/RBAC/Projects и необходимый audit. Его migration создаётся только из
reviewed fresh diff текущих 16 executable tables; модели последующих этапов не
добавляются.
Contacts, channels, inbox/outbox, automation, CRM и остальные модели ниже
остаются design proposal до соответствующего этапа и не входят в executable
schema. Поэтому первая migration не создаёт около 40 преждевременных таблиц.

## Главные правила

1. PostgreSQL является источником истины.
2. Все tenant-owned models содержат обязательный `projectId`.
3. Каждая строго tenant-owned model объявляет `@@unique([projectId, id])`.
   Dual-scope `AuditLog` использует глобально уникальный primary key и не
   создаёт misleading nullable composite unique.
4. Tenant relation использует composite foreign key
   `fields: [projectId, entityId], references: [projectId, id]`.
5. Cross-project references проверяются PostgreSQL constraints и application
   project guard.
6. Provider identifiers хранятся как `String`, даже если текущий API возвращает
   число.
7. Event, audit, lifecycle и expiry timestamps используют PostgreSQL
   `TIMESTAMPTZ(3)` и хранятся в UTC.
8. Raw webhook body хранится как `Bytes`, чтобы сохранить точные валидные bytes
   и пережить JSON parse errors; parsed payload, safe request/response и mappings
   используют `Json`.
9. Secret plaintext и refresh token plaintext не хранятся.
10. Partial indexes/check constraints, которые нельзя надёжно выразить в
    текущей Prisma schema, сначала фиксируются в reviewed SQL proposal, затем
    добавляются в migration соответствующего этапа.
11. Global и project RBAC не разделяют nullable scope columns: для каждого
    boundary используются отдельные таблицы.
12. Hard delete Project запрещён при наличии tenant-owned role, membership,
    invite либо audit history: все прямые Stage 1 project foreign keys
    используют `RESTRICT`. Audit хранит immutable project name/slug snapshots.

## Stage-sliced migration map

### Stage 1 migration status

`packages/database/prisma/migrations/20260726000100_stage1_auth_rbac_projects/migration.sql`
is the reviewed initial migration for the 16-table Stage 1 baseline. It is an
exact fresh `prisma migrate diff --from-empty` output verified by
`pnpm db:diff:check`; it has not been applied by this repository or deployed to
production. Future domain models remain outside this migration.

### Stage 2 migration status

`packages/database/prisma/migrations/20260726000200_stage2_contacts_tags_fields/migration.sql`
adds exactly five Stage 2 tables: contacts, channel identities, tags, contact
tags and custom-field definitions. The migration was reviewed against a fresh
Prisma diff: every tenant relation uses `(projectId, id)` where both entities
are tenant-owned, all lifecycle timestamps use `TIMESTAMPTZ(3)`, and tag/
custom-field deletion is archival rather than destructive. It is not applied
or deployed by this repository.

### Stage 3B.1 migration status

`packages/database/prisma/migrations/20260726000300_stage3_telegram_persistence/migration.sql`
adds only the Telegram persistence foundation: `ChannelConnection`, valid raw
webhook events, inbox/outbox records, idempotency records, normalized events,
conversations and messages. It does not add an HTTP webhook handler, BullMQ
worker, outbound delivery, channel-management API or frontend.

Every Stage 3 tenant-owned record has `projectId`. Relations to a connection,
contact or conversation use `(projectId, id)` composite foreign keys, so a
record cannot reference an entity from another project. `RawWebhookEvent` is
deduplicated by `(connectionId, externalUpdateId)`; `NormalizedEvent` has one
row per inbox record; incoming provider messages are deduplicated by
`(connectionId, direction, externalMessageId)`; and a Telegram conversation is
stable at `(projectId, connectionId, externalChatId)`. PostgreSQL remains the
source of truth for pending records: the polling indexes are `(status,
nextAttemptAt)` and `(projectId, connectionId, status)` for both inbox and
outbox.

`credentialsEncrypted` and `webhookSecretEncrypted` are JSONB AES-256-GCM
envelopes defined by ADR-025. No plaintext bot token or webhook-secret column
exists. Valid provider payloads are stored as JSONB with `purgeAfter` retention
metadata; invalid webhook attempts are deliberately outside this schema because
their body must not be persisted.

The migration is a reviewed schema artifact and has not been applied or
deployed by this repository.

`20260726000400_stage3_webhook_correlation` adds the correlation ID retained
with each valid raw webhook event. The temporary SQL default only makes the
additive migration safe for an already populated database and is dropped in the
same migration; Prisma's executable schema has no default for this field.

### Stage 3B.3a runtime behavior

The Telegram inbound consumer claims an `InboxRecord` atomically before it
reads its related raw event. `PENDING` and `RETRY` records may be claimed;
`PROCESSING` records are reclaimable only after their lease expires; terminal
`COMPLETED`, `FAILED`, and `DEAD_LETTER` records are no-ops. A claim writes the
worker ID, lock time, and one attempt increment. The persistence transaction
then creates or reuses the single `NormalizedEvent`, resolves the
connection-scoped identity and contact, creates or reuses the stable
conversation/message records, and marks the inbox record completed. On a safe
processing failure it is released as `RETRY` with no provider payload in the
error field. The future recovery scheduler and terminal dead-letter policy are
intentionally not part of this slice.

| Slice            | Executable models                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stage 1 baseline | `User`, `Session`, `PasswordResetToken`, global/project invite history and active-invite reservations, `Permission`, global/project roles and assignments, `Project`, `AuditLog`     |
| Stage 2          | `Contact`, `ChannelIdentity`, `Tag`, `ContactTag` and `CustomFieldDefinition`; contact custom-field values are stored in the contact JSON document and validated against definitions |
| Stage 3B.1–3a    | `ChannelConnection`, valid webhook persistence, `InboxRecord`, `OutboxRecord`, `IdempotencyRecord`, `NormalizedEvent`, `Conversation` and `Message`; inbound processor only          |
| Stage 4          | scenarios and execution journal                                                                                                                                                      |
| Stage 5          | project-specific CRM configuration after the CRM contract gate                                                                                                                       |
| Post-pilot       | broadcasts, Wait, Delay, Subflow and advanced media workflows                                                                                                                        |

Каждый slice получает отдельный generated SQL review. Ни одна будущая модель не
добавляется в Stage 1 baseline «про запас».

## Enum proposal

```prisma
enum UserStatus {
  ACTIVE
  DISABLED
}

enum TokenStatus {
  ACTIVE
  ROTATED
  REVOKED
  REUSED
  EXPIRED
}

enum ProjectStatus {
  DRAFT
  ACTIVE
  PAUSED
  ARCHIVED
}

enum AutomationMode {
  AUTOMATION_ENABLED
  AUTOMATION_PAUSED
  MANUAL_MODE
}

enum ChannelType {
  TELEGRAM
  WHATSAPP
  INSTAGRAM
}

enum ChannelConnectionStatus {
  DRAFT
  CONNECTING
  CONNECTED
  ERROR
  DISABLED
}

enum ConsentStatus {
  UNKNOWN
  OPTED_IN
  OPTED_OUT
}

enum InboxStatus {
  RECEIVED
  PROCESSING
  PROCESSED
  RETRY_WAIT
  DEFERRED
  FAILED
  DEAD_LETTER
  IGNORED
}

enum SideEffectStatus {
  PENDING
  PROCESSING
  SUCCEEDED
  FAILED
  UNKNOWN
}

enum ScenarioStatus {
  DRAFT
  PUBLISHED
  PAUSED
  ARCHIVED
}

Broadcasts use a terminal `ARCHIVED` status for recoverable UI deletion. Archived
broadcasts and their immutable recipient history remain tenant-bound in PostgreSQL
and are excluded from the normal project list. A running or paused broadcast must
be stopped before it can be archived.

enum ScenarioVersionStatus {
  DRAFT
  PUBLISHED
  SUPERSEDED
}

enum ScenarioExecutionStatus {
  QUEUED
  RUNNING
  WAITING
  PAUSED
  COMPLETED
  FAILED
  CANCELLED
}

enum MessageStatus {
  RECEIVED
  PENDING
  PROCESSING
  SUBMITTED
  SENT
  DELIVERED
  READ
  FAILED
  UNKNOWN
  CANCELLED
}

enum MediaAssetStatus {
  PROVIDER_REFERENCE
  PENDING_DOWNLOAD
  PENDING_UPLOAD
  AVAILABLE
  REJECTED
  UNAVAILABLE
  DELETED
}
```

Broadcast enums остаются только в future design proposal и не входят в
executable schema или pilot.

## Auth и RBAC — executable Stage 1 proposal

Executable proposal использует отдельные физические boundaries:

| Global boundary                 | Project boundary                            |
| ------------------------------- | ------------------------------------------- |
| `GlobalRole`                    | `ProjectRole(projectId)`                    |
| `GlobalRolePermission`          | `ProjectRolePermission(projectId)`          |
| `GlobalUserRole`                | `ProjectMembership(projectId)`              |
| `GlobalUserInviteToken`         | `ProjectUserInviteToken(projectId)`         |
| `GlobalActiveInviteReservation` | `ProjectActiveInviteReservation(projectId)` |

Инварианты:

- nullable `projectId` и nullable composite foreign keys в RBAC отсутствуют;
- `GlobalRolePermission` всегда ссылается на существующий `GlobalRole`;
- project permission, membership и invite ссылаются на role по
  `(projectId, projectRoleId)`, поэтому cross-project assignment невозможен;
- project invite имеет обязательный `projectId`; удаление role использует
  `RESTRICT`, а не `SET NULL`, поэтому invite не превращается в orphan и не
  теряет tenant boundary;
- удаление Project не каскадирует role, membership, invite или audit history;
  lifecycle использует archive/state transition, а hard delete требует
  отдельной контролируемой процедуры;
- role assignment unique для `(userId, globalRoleId)` либо
  `(projectId, userId)`;
- invitation token hash уникален глобально; email хранится как display snapshot
  и отдельный `normalizedEmail`;
- session rotation ссылается на replacement по
  `(replacedBySessionId, userId, tokenFamilyId)`, поэтому replacement из другой
  user/token family невозможен; nullable `replacedBySessionId` означает только
  отсутствие следующей rotation, а не orphan reference;
- hard delete User с существующей session family использует `RESTRICT`, чтобы
  cascade не конфликтовал с self-relation и не уничтожал security evidence;
- inviter может быть удалён через `SET NULL`, но immutable email snapshot
  сохраняется для audit;
- все FK, участвующие в delete/restrict/set-null checks, имеют supporting index;
- все lifecycle timestamps используют `TIMESTAMPTZ(3)`;
- historical invitation не объявляет partial `@@unique`: Prisma Client иначе
  трактует его как обычный `WhereUniqueInput`, что небезопасно для historical
  rows;
- `GlobalActiveInviteReservation` имеет primary key
  `(normalizedEmail, globalRoleId)` и `inviteTokenId @unique`. Composite FK на
  `(inviteTokenId, globalRoleId)` гарантирует, что reservation принадлежит
  invitation того же global role;
- `ProjectActiveInviteReservation` имеет primary key
  `(projectId, normalizedEmail)` и `inviteTokenId @unique`. Composite FK на
  `(projectId, inviteTokenId)` гарантирует тот же project boundary;
- будущий invitation service обязан в одной PostgreSQL transaction создать
  historical token и reservation. Accepted/revoked/expired terminal transition
  обязан в той же transaction обновить historical token и удалить reservation;
  это оставляет history и разрешает следующую active invitation;
- фактическая migration всё ещё не создана и требует отдельного approval.

Полная Prisma-форма этих моделей является единственным executable источником в
`packages/database/prisma/schema.prisma`.

### User account profile fields

`User` stores optional `country`, `region` and `city` strings for the account
profile. These fields are global account metadata and are not tenant-owned.
Email changes update both `email` and the unique `normalizedEmail` in the same
transaction. Password changes replace only the Argon2id `passwordHash`; plain
text passwords are never persisted or included in audit records. An
administrator-initiated password change revokes all active sessions for the
account. A self-service profile change preserves the authenticated session that
submitted the change and revokes the account's other active sessions.

### Отклонённая nullable-scope модель

Следующий первоначальный фрагмент сохранён только как контекст review и не
является executable proposal:

```prisma
model User {
  id           String     @id @default(uuid())
  email        String     @unique
  passwordHash String
  firstName    String
  lastName     String
  status       UserStatus @default(ACTIVE)
  lastLoginAt  DateTime?
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt
}

model Session {
  id                  String      @id @default(uuid())
  userId              String
  tokenFamilyId       String
  refreshTokenHash    String      @unique
  csrfTokenHash       String
  status              TokenStatus @default(ACTIVE)
  replacedBySessionId String?
  issuedAt            DateTime    @default(now())
  expiresAt           DateTime
  rotatedAt           DateTime?
  revokedAt           DateTime?
  reuseDetectedAt     DateTime?
  ip                   String?
  userAgent            String?

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, status])
  @@index([tokenFamilyId, status])
  @@index([expiresAt])
}

model PasswordResetToken {
  id        String    @id @default(uuid())
  userId    String
  tokenHash String    @unique
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())
  ip        String?

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, expiresAt])
}

model UserInviteToken {
  id            String   @id @default(uuid())
  projectId     String?
  email         String
  roleId        String?
  tokenHash     String   @unique
  invitedById   String
  expiresAt     DateTime
  acceptedAt    DateTime?
  revokedAt     DateTime?
  createdAt     DateTime @default(now())

  @@unique([projectId, id])
  @@index([projectId, email])
  @@index([expiresAt])
}

model Role {
  id          String   @id @default(uuid())
  projectId   String?
  name        String
  scope       String   // GLOBAL | PROJECT; DB CHECK
  system      Boolean  @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([projectId, id])
  @@index([projectId, scope])
}

model Permission {
  id          String @id @default(uuid())
  code        String @unique
  description String
}

model RolePermission {
  projectId    String?
  roleId       String
  permissionId String

  @@id([roleId, permissionId])
  @@unique([projectId, roleId, permissionId])
}

model GlobalUserRole {
  id        String   @id @default(uuid())
  userId    String
  roleId    String
  createdBy String
  createdAt DateTime @default(now())

  @@unique([userId, roleId])
}

model ProjectMembership {
  id        String   @id @default(uuid())
  projectId String
  userId    String
  roleId    String
  status    String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  role    Role    @relation(fields: [projectId, roleId], references: [projectId, id])

  @@unique([projectId, id])
  @@unique([projectId, userId])
  @@index([userId, status])
}
```

Этот вариант отклонён: migration-level CHECK не компенсирует nullable composite
foreign key. System project roles создаются отдельно для каждого project;
скрытая cross-tenant ссылка на общую mutable role запрещена.

## Project и CRM project configuration

```prisma
model Project {
  id          String        @id @default(uuid())
  name        String
  slug        String        @unique
  description String?
  status      ProjectStatus @default(DRAFT)
  timezone    String
  locale      String
  settings    Json
  version     Int           @default(1)
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt

  @@index([status, createdAt])
}

model CrmProjectConfig {
  id                   String   @id @default(uuid())
  projectId            String   @unique
  crmProjectId         String
  fieldMapping         Json
  defaultPipeline      String?
  defaultStage         String?
  additionalParameters Json
  status               String
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@unique([projectId, id])
  @@unique([projectId, crmProjectId])
}
```

`Project.crmProjectId` удаляется: единственный источник project-specific CRM
настроек — `CrmProjectConfig`. Новые подключения хранят exact base URL и
зашифрованный credential в этой записи; `CRM_BASE_URL` и `CRM_AUTH_TOKEN`
остаются только migration fallback для старого deployment.

## Contacts, fields, tags и consent

```prisma
model Contact {
  id                 String         @id @default(uuid())
  projectId          String
  firstName          String?
  lastName           String?
  displayName        String?
  phone              String?
  email              String?
  status             String
  automationMode     AutomationMode @default(AUTOMATION_ENABLED)
  crmLeadId          String?
  crmContactId       String?
  crmManagerId       String?
  firstInteractionAt DateTime?
  lastInteractionAt  DateTime?
  mergedIntoContactId String?
  createdAt          DateTime       @default(now())
  updatedAt          DateTime       @updatedAt

  @@unique([projectId, id])
  @@index([projectId, status, lastInteractionAt])
  @@index([projectId, crmLeadId])
}

model CustomFieldDefinition {
  id          String   @id @default(uuid())
  projectId   String
  key         String
  name        String
  type        String
  config      Json
  required    Boolean  @default(false)
  archivedAt  DateTime?
  createdBy   String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([projectId, id])
  @@unique([projectId, key])
}

model ContactCustomFieldValue {
  id             String   @id @default(uuid())
  projectId      String
  contactId      String
  definitionId   String
  valueJson      Json
  valueText      String?
  valueNumber    Decimal?
  valueBoolean   Boolean?
  valueDateTime  DateTime?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  contact    Contact               @relation(fields: [projectId, contactId], references: [projectId, id], onDelete: Cascade)
  definition CustomFieldDefinition @relation(fields: [projectId, definitionId], references: [projectId, id], onDelete: Restrict)

  @@unique([projectId, id])
  @@unique([projectId, contactId, definitionId])
  @@index([projectId, definitionId, valueText])
  @@index([projectId, definitionId, valueNumber])
  @@index([projectId, definitionId, valueDateTime])
}

model Segment {
  id           String   @id @default(uuid())
  projectId    String
  name         String
  filterSchemaVersion Int
  filter       Json
  status       String
  createdBy    String
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([projectId, id])
  @@unique([projectId, name])
}

model Tag {
  id             String   @id @default(uuid())
  projectId      String
  name           String
  normalizedName String
  color          String?
  description    String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([projectId, id])
  @@unique([projectId, normalizedName])
}

model ContactTag {
  projectId String
  contactId String
  tagId     String
  source    String
  createdAt DateTime @default(now())

  contact Contact @relation(fields: [projectId, contactId], references: [projectId, id], onDelete: Cascade)
  tag     Tag     @relation(fields: [projectId, tagId], references: [projectId, id], onDelete: Cascade)

  @@id([projectId, contactId, tagId])
}
```

Typed projection columns позволяют фильтровать без небезопасного произвольного
JSON coercion. Runtime и DB CHECK должны гарантировать заполнение только
projection, соответствующей definition type.

### Contacts v2 persistence

`ContactCustomFieldValue` is a project-bound projection of the compatible
`Contact.customFields` JSON document. Its unique
`(projectId, contactId, definitionId)` and composite foreign keys prevent a
definition or contact from another project being used in a segment predicate.
The migration backfills valid Stage 2 values, while all later updates write the
document and its projections in one transaction.

`Segment` persists only a versioned, declarative filter and never materialised
contact membership. It is archived rather than hard deleted. `Contact` gets a
self-relation through `(projectId, mergedIntoContactId)`; a secondary contact is
kept for history with status `MERGED`, while project-bound dependent records are
re-parented to the primary contact transactionally.

## Channels, identities и conversations

```prisma
model ChannelConnection {
  id                    String                  @id @default(uuid())
  projectId             String
  channel               ChannelType
  name                  String
  status                ChannelConnectionStatus
  externalAccountId     String?
  credentialsEncrypted  Bytes
  credentialVersion     Int                     @default(1)
  settings              Json
  capabilities          Json
  lastWebhookAt         DateTime?
  lastErrorAt           DateTime?
  createdAt             DateTime                @default(now())
  updatedAt             DateTime                @updatedAt

  @@unique([projectId, id])
  @@index([projectId, channel, status])
}

model ChannelIdentity {
  id                     String      @id @default(uuid())
  projectId              String
  contactId              String
  connectionId           String
  channel                ChannelType
  externalUserId         String
  externalConversationId String?
  externalThreadId       String?
  username               String?
  phone                  String?
  displayName            String?
  metadata               Json
  blockedAt              DateTime?
  lastInboundAt          DateTime?
  lastOutboundAt         DateTime?
  createdAt              DateTime    @default(now())
  updatedAt              DateTime    @updatedAt

  contact    Contact           @relation(fields: [projectId, contactId], references: [projectId, id], onDelete: Cascade)
  connection ChannelConnection @relation(fields: [projectId, connectionId], references: [projectId, id], onDelete: Restrict)

  @@unique([projectId, id])
  @@unique([projectId, connectionId, externalUserId])
}

model ChannelConsent {
  id                String        @id @default(uuid())
  projectId         String
  channelIdentityId String
  purpose           String
  status            ConsentStatus
  source            String
  evidence          Json?
  effectiveAt       DateTime
  createdAt         DateTime      @default(now())
  updatedAt         DateTime      @updatedAt

  identity ChannelIdentity @relation(fields: [projectId, channelIdentityId], references: [projectId, id], onDelete: Cascade)

  @@unique([projectId, id])
  @@unique([projectId, channelIdentityId, purpose])
}

model Conversation {
  id                     String          @id @default(uuid())
  projectId              String
  contactId              String
  channelIdentityId      String
  connectionId           String
  channel                ChannelType
  externalConversationId String
  externalThreadId       String?
  status                 String
  automationModeOverride AutomationMode?
  crmLeadId              String?
  nextSequence           BigInt          @default(1)
  lastInboundAt          DateTime?
  lastOutboundAt         DateTime?
  createdAt              DateTime        @default(now())
  updatedAt              DateTime        @updatedAt

  @@unique([projectId, id])
  @@unique([projectId, connectionId, externalConversationId, externalThreadId])
  @@index([projectId, contactId, updatedAt])
}
```

Effective automation mode:

```text
Conversation.automationModeOverride
?? Contact.automationMode
?? AUTOMATION_ENABLED
```

## Media

```prisma
model MediaAsset {
  id                 String           @id @default(uuid())
  projectId          String
  connectionId       String?
  source             String
  status             MediaAssetStatus
  providerMediaId    String?
  providerMetadata   Json?
  bucketKey          String?
  originalFilename   String?
  detectedMimeType   String?
  declaredMimeType   String?
  extension          String?
  sizeBytes          BigInt?
  checksumSha256     String?
  retentionUntil     DateTime?
  deletedAt          DateTime?
  createdAt          DateTime         @default(now())
  updatedAt          DateTime         @updatedAt

  @@unique([projectId, id])
  @@index([projectId, status, retentionUntil])
  @@index([projectId, connectionId, providerMediaId])
}
```

Signed URL не хранится: он генерируется на запрос с коротким TTL. Bucket credentials
не находятся в этой таблице.

## Inbox, raw events и idempotency

```prisma
model RawWebhookEvent {
  id               String      @id @default(uuid())
  projectId        String
  connectionId     String
  channel          ChannelType
  externalEventKey String
  safeHeaders      Json
  contentType      String?
  payloadRaw       Bytes
  payloadJson      Json?
  receivedAt       DateTime    @default(now())
  purgeAfter       DateTime

  @@unique([projectId, id])
  @@unique([projectId, connectionId, externalEventKey])
  @@index([projectId, receivedAt])
  @@index([purgeAfter])
}

model RejectedWebhookAttempt {
  id              String      @id @default(uuid())
  projectId       String
  connectionId    String
  channel         ChannelType
  sourceIp        String?
  safeHeaders     Json
  rejectionReason String
  correlationId   String
  receivedAt      DateTime    @default(now())

  @@unique([projectId, id])
  @@index([projectId, receivedAt])
}

model InboxRecord {
  id                String      @id @default(uuid())
  projectId         String
  rawWebhookEventId String?
  provider          ChannelType
  connectionId      String
  externalEventKey  String
  status            InboxStatus
  correlationId     String
  attempts          Int         @default(0)
  maxAttempts       Int
  attemptGroup      Int         @default(1)
  leaseOwner        String?
  leaseExpiresAt    DateTime?
  nextAttemptAt     DateTime?
  lastErrorSafe     Json?
  receivedAt        DateTime    @default(now())
  processedAt       DateTime?
  updatedAt         DateTime    @updatedAt

  @@unique([projectId, id])
  @@unique([projectId, connectionId, externalEventKey])
  @@index([status, nextAttemptAt])
  @@index([leaseExpiresAt])
  @@index([projectId, receivedAt])
}

model IdempotencyRecord {
  id              String           @id @default(uuid())
  projectId       String
  scope           String
  key             String
  requestHash     String
  status          SideEffectStatus
  resourceType    String?
  resourceId      String?
  responseSafe    Json?
  httpStatus      Int?
  expiresAt       DateTime?
  createdAt       DateTime         @default(now())
  updatedAt       DateTime         @updatedAt

  @@unique([projectId, id])
  @@unique([projectId, scope, key])
  @@index([expiresAt])
}

model OutboxRecord {
  id                 String           @id @default(uuid())
  projectId          String
  operationType      String
  aggregateType      String
  aggregateId        String
  idempotencyKey     String
  payload            Json
  status             SideEffectStatus @default(PENDING)
  correlationId      String
  attempts           Int              @default(0)
  maxAttempts        Int
  attemptGroup       Int              @default(1)
  leaseOwner         String?
  leaseExpiresAt     DateTime?
  nextAttemptAt      DateTime?
  externalReference  String?
  resultSafe         Json?
  lastErrorSafe      Json?
  failureClass       String?
  retryable          Boolean?
  unknownReason      String?
  createdAt          DateTime         @default(now())
  updatedAt          DateTime         @updatedAt
  completedAt        DateTime?

  @@unique([projectId, id])
  @@unique([projectId, operationType, idempotencyKey])
  @@index([status, nextAttemptAt])
  @@index([leaseExpiresAt])
  @@index([projectId, aggregateType, aggregateId])
}
```

`RejectedWebhookAttempt` не содержит raw body. IP и headers проходят allowlist,
redaction и retention.

## Events и messages

```prisma
model NormalizedEvent {
  id                String      @id @default(uuid())
  projectId         String
  rawWebhookEventId String
  connectionId      String
  channel           ChannelType
  externalEventId   String
  eventType         String
  payload           Json
  occurredAt        DateTime
  createdAt         DateTime    @default(now())

  @@unique([projectId, id])
  @@unique([projectId, connectionId, externalEventId])
  @@index([projectId, occurredAt])
}

model Message {
  id                  String        @id @default(uuid())
  projectId           String
  conversationId      String
  contactId           String
  connectionId        String
  channel             ChannelType
  direction           String
  type                String
  text                String?
  content             Json?
  externalMessageId   String?
  status              MessageStatus
  source              String
  scenarioExecutionId String?
  broadcastId         String?
  idempotencyKey      String?
  errorSafe           Json?
  createdAt           DateTime      @default(now())
  updatedAt           DateTime      @updatedAt

  @@unique([projectId, id])
  @@unique([projectId, connectionId, direction, externalMessageId])
  @@index([projectId, conversationId, createdAt])
}

model MessageStatusEvent {
  id                String   @id @default(uuid())
  projectId         String
  messageId         String
  status            String
  externalStatusKey String
  externalTimestamp DateTime?
  errorCode         String?
  errorMessageSafe  String?
  rawWebhookEventId String?
  createdAt         DateTime @default(now())

  @@unique([projectId, id])
  @@unique([projectId, messageId, externalStatusKey])
}

model OrphanMessageStatus {
  id                String      @id @default(uuid())
  projectId         String
  connectionId      String
  externalMessageId String
  externalStatusKey String
  status            String
  normalizedPayload Json
  occurredAt        DateTime?
  resolutionStatus  String
  resolvedMessageId String?
  receivedAt        DateTime    @default(now())
  resolvedAt        DateTime?

  @@unique([projectId, id])
  @@unique([projectId, connectionId, externalMessageId, externalStatusKey])
  @@index([projectId, resolutionStatus, receivedAt])
}
```

Nullable `externalMessageId` требует review generated unique index: PostgreSQL
допускает несколько NULL, что желательно для ещё не отправленных messages.

## Scenarios и executions

```prisma
model Scenario {
  id              String         @id @default(uuid())
  projectId       String
  name            String
  description     String?
  status          ScenarioStatus
  activeVersionId String?
  draftVersionId  String?
  createdBy       String
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt

  @@unique([projectId, id])
  @@index([projectId, status])
}

model ScenarioVersion {
  id                 String                @id @default(uuid())
  projectId          String
  scenarioId         String
  version            Int
  status             ScenarioVersionStatus
  graph              Json
  variablesSchema    Json
  compiledDefinition Json?
  validation         Json
  contentHash        String
  createdBy          String
  createdAt          DateTime              @default(now())
  publishedAt        DateTime?

  @@unique([projectId, id])
  @@unique([projectId, scenarioId, version])
  @@unique([projectId, scenarioId, contentHash])
}

model ScenarioExecution {
  id                String                  @id @default(uuid())
  projectId         String
  scenarioId        String
  scenarioVersionId String
  contactId         String
  conversationId    String
  triggerEventId    String
  triggerKey        String
  conversationSequence BigInt
  status            ScenarioExecutionStatus
  currentNodeId     String?
  variables         Json
  correlationId     String
  cancellationRequestedAt DateTime?
  startedAt         DateTime?
  waitingAt         DateTime?
  completedAt       DateTime?
  failedAt          DateTime?
  errorSafe         Json?
  createdAt         DateTime                @default(now())
  updatedAt         DateTime                @updatedAt

  @@unique([projectId, id])
  @@unique([projectId, scenarioId, triggerKey])
  @@index([projectId, conversationId, conversationSequence])
  @@index([projectId, status, updatedAt])
}

model NodeExecution {
  id                  String           @id @default(uuid())
  projectId           String
  scenarioExecutionId String
  nodeId              String
  nodeType            String
  status              SideEffectStatus
  inputSafe           Json
  outputSafe          Json?
  attempt             Int
  attemptGroup        Int
  idempotencyKey      String
  startedAt           DateTime?
  completedAt         DateTime?
  errorSafe           Json?

  @@unique([projectId, id])
  @@unique([projectId, scenarioExecutionId, nodeId, attemptGroup])
  @@unique([projectId, idempotencyKey])
}

model WaitState {
  id                  String   @id @default(uuid())
  projectId           String
  scenarioExecutionId String
  scenarioId          String
  scenarioVersionId   String
  nodeId              String
  conversationId      String
  status              String
  criteria            Json
  expiresAt           DateTime
  resolvedByEventId   String?
  createdAt           DateTime @default(now())
  resolvedAt          DateTime?

  @@unique([projectId, id])
  @@index([projectId, conversationId, scenarioId, status])
}
```

Stage 4 добавляет executable `Scenario`, `ScenarioVersion`,
`ScenarioExecution` и `NodeExecution`. `activeVersionId`, `draftVersionId` и
`scenarioVersionId` ссылаются через composite keys
`(projectId, scenarioId, versionId)`; простая ссылка только по `versionId`
запрещена, так как позволила бы закрепить версию другого scenario того же
tenant. `Conversation.nextAutomationSequence` сериализует execution order для
одного conversation. В этом slice намеренно отсутствует `WaitState`: Wait,
Delay и Subflow не входят в pilot.

### CRM mock outbox (Stage 5)

#### Per-project CRM connection registry

`CrmProjectConfig` is also the durable CRM connection record. In addition to
field mapping it stores `provider`, exact `baseUrl`, lifecycle `status`,
capabilities, `lastTestedAt`/`lastErrorAt`, an AES-256-GCM
`credentialsEncrypted` envelope and a SHA-256 `inboundTokenHash`.
`pairingCodeHash` and `pairingExpiresAt` are short-lived and cleared atomically
when a pairing is consumed.

Both token hashes and `(provider, crmProjectId)` are globally unique, so one
external CRM tenant cannot remain active against two Omnicus projects. All
connection access is then checked against `(projectId, crmProjectId)`. The
encrypted credential AAD is
`projectId:crmConfigId:crm:authToken`; copying its ciphertext to another project
or record therefore fails authentication. Pairing, status and expiry timestamps
use `TIMESTAMPTZ(3)`. The polling index on `(status, pairingExpiresAt)` supports
bounded expiry cleanup without scanning unrelated tenant data.

`CRM_BASE_URL`, `CRM_AUTH_TOKEN` and `CRM_INBOUND_AUTH_TOKEN` are legacy
migration inputs only. New connections are created through application pairing
and never require project-specific Railway variables.

CRM side effects не используют `ChannelConnection`: один `OutboxRecord` имеет
`kind` (`TELEGRAM` или `CRM`), а `connectionId` обязателен только для Telegram
operation. CRM operation хранится отдельно в `CrmOperation` и ссылается на
outbox через composite `(projectId, outboxRecordId)`. `CrmProjectConfig`
содержит project-specific mapping, routing, exact base URL и зашифрованный
service credential. Environment URL/token остаются только ограниченным
fallback для deployment до появления application pairing. Это позволяет mock CRM
обрабатывать те же transactional outbox состояния без утверждений о реальном
provider payload.

Для одного active Wait на `(projectId, conversationId, scenarioId)` требуется
partial unique index `WHERE status = 'ACTIVE'`, добавляемый migration SQL.
Wait/Subflow не реализуются в pilot, но schema reserved для совместимости можно
добавить только на этапе их реализации.

### Automation v2 durable continuation (post-pilot)

`WaitState` and `DelayedAction` are tenant-owned continuation records. Both use
`projectId` plus composite foreign keys to `ScenarioExecution`, `Scenario`,
`ScenarioVersion` and `Conversation`; a record from another project or scenario
cannot resume an execution. All lifecycle fields use `TIMESTAMPTZ(3)`.

`WaitState` has an application-visible status (`ACTIVE`, `RESOLVED`,
`TIMED_OUT`, `CANCELLED`), reply criteria, success/timeout continuation node IDs
and the winning event ID. Migration SQL adds a partial unique index:

```sql
CREATE UNIQUE INDEX "wait_states_one_active_per_conversation_scenario"
ON "wait_states" ("projectId", "conversationId", "scenarioId")
WHERE "status" = 'ACTIVE';
```

`DelayedAction` stores `resumeNodeId`, due time, bounded claim lease, attempts
and a safe error code. Its unique `(projectId, scenarioExecutionId, nodeId)`
prevents duplicate delay scheduling. Due and expired-lease polling uses an index
on `(status, nextAttemptAt)`; PostgreSQL remains the recovery source of truth.

`ScenarioExecution.parentExecutionId` and `resumeNodeId` create a composite
self-reference for awaited subflows. A child is pinned by its already immutable
`scenarioVersionId`; no later draft or publish can alter it.

The worker scans due `DelayedAction` and expired `WaitState` records in bounded
batches. Conditional database updates make concurrent worker replicas safe.

### Automation Studio 2.2 external HTTP boundary

External HTTP calls use the existing transactional outbox with `kind=HTTP` and
a project-owned `ExternalHttpOperation`. The operation references exactly one
`ScenarioExecution`, one node and one outbox record through composite
project-scoped keys. It stores continuation node IDs and safe result metadata,
but never stores a rendered URL, request/response body, authorization value or
raw response headers. Its unique `(projectId, scenarioExecutionId, nodeId)` key
prevents a replayed runtime step from scheduling a second side effect.

`AutomationSecret` stores a project-scoped name and an AES-256-GCM envelope.
The value is accepted only on create/rotation and is never returned. Encryption
AAD is `projectId:secretId:automation:value`, so ciphertext copied between
projects or records cannot be decrypted. Scenario graphs contain only secret
IDs. Publish validates every reference against a non-archived secret in the
same project.

Known HTTP responses may continue through the explicit `success` or `failure`
edge. A transport-ambiguous mutating request becomes terminal `UNKNOWN` and is
not replayed automatically. GET may use bounded retry. Mapped response values
are written only to `ScenarioExecution.variables`; `NodeExecution` and
`ExternalHttpOperation.resultSafe` keep status, byte count, content type and
mapping names without copying mapped values.

## Telegram broadcasts

Post-pilot Telegram broadcasts use two project-owned tables. `Broadcast` pins
the selected Telegram connection, audience definition and immutable text at
launch. `BroadcastRecipient` is a durable recipient snapshot, not a live
segment query. It links the recipient to the eventual outbound `Message` and
`OutboxRecord` through project-safe composite foreign keys.

```text
UNIQUE(projectId, broadcastId, channelIdentityId)
```

Only active Telegram identities of non-merged, non-blocked and non-unsubscribed
contacts enter the snapshot. A recipient is skipped rather than deleted if it
becomes ineligible before its outbox is created. `BroadcastRecipient` owns no
lease: the existing `OutboxRecord` owns delivery claim/retry/unknown state.

The audience is fixed while the broadcast moves from `PREPARING` to `RUNNING`.
Later changes to a saved Segment, tags or contacts never alter recipients.
`Broadcast.preparationLockedAt` and `preparationLockedBy` provide a bounded
lease for the worker-side scheduled/preparation claim, so several worker
replicas cannot materialize the same audience concurrently.

## Audit

```prisma
model AuditLog {
  id                  String   @id @default(uuid())
  projectId           String?
  projectNameSnapshot String?
  projectSlugSnapshot String?
  actorUserId         String?
  actorEmailSnapshot  String?
  actorType           String
  action              String
  entityType          String
  entityId            String?
  beforeSafeJson      Json?
  afterSafeJson       Json?
  ip                  String?
  userAgent           String?
  correlationId       String
  reason              String?
  createdAt           DateTime @default(now()) @db.Timestamptz(3)
  purgeAfter          DateTime @db.Timestamptz(3)
  project             Project? @relation(fields: [projectId], references: [id], onDelete: Restrict)
  actor               User?    @relation("AuditActor", fields: [actorUserId], references: [id], onDelete: SetNull)

  @@index([projectId, createdAt])
  @@index([actorUserId, createdAt])
  @@index([correlationId])
  @@index([purgeAfter])
}
```

`projectId` nullable только для действительно global auth/security actions.
Project action всегда обязана иметь `projectId`,
`projectNameSnapshot` и `projectSlugSnapshot`. Relation использует
`ON DELETE RESTRICT`, а не `CASCADE`: проект нельзя hard-delete до завершения
audit retention/purge workflow. Actor может стать `NULL`, но
`actorEmailSnapshot` остаётся immutable.

## Migration review checklist

Перед первой migration:

- подтвердить, что generated SQL создаёт только Stage 1 slice;
- сверить committed SQL proposal с повторным `prisma migrate diff`;
- проверить отсутствие nullable RBAC composite foreign keys;
- проверить project role/invite/member FKs по `(projectId, projectRoleId)`;
- проверить active-invite reservation PK/unique и composite FKs к historical
  invitation; partial `@@unique` для invitation не добавлять;
- проверить `AuditLog.project ON DELETE RESTRICT` и immutable snapshots;
- проверить, что lifecycle timestamps сгенерированы как
  `TIMESTAMP(3) WITH TIME ZONE`;
- заменить string state/type fields на enums, если provider extensibility не
  требует string;
- проверить все generated foreign keys и `ON DELETE`;
- active Wait partial uniqueness добавить только в Stage 4 migration;
- добавить CHECK для Role scope и typed custom values;
- проверить nullable unique semantics;
- добавить index для outbox/inbox relay без full-table scan;
- проверить, что tenant relation использует `(projectId, id)`;
- проверить raw payload/audit purge indexes;
- проверить, что CRM URL/token отсутствуют в tables;
- выполнить `prisma format`, `prisma validate` и review SQL;
- миграцию не применять автоматически к production.

## Telegram outbound records

`outbox_records` is the transactional source of truth for Telegram delivery.
Stage 3C.1 adds the `RETRY` state; its JSONB payload contains only internal
`messageId` and `channelIdentityId`. It never carries a Telegram token, webhook
secret, or plaintext credential. `projectId + idempotencyKey` makes a test-send
request idempotent. `PENDING`/`RETRY` records whose `nextAttemptAt` is due, and
expired `PROCESSING` leases, are recoverable by the worker; `SUCCEEDED`,
`FAILED`, and `UNKNOWN` are terminal. `UNKNOWN` deliberately requires manual
reconciliation rather than a blind resend.

## Executable media and template slice

The executable advanced-media slice uses `MediaAsset`, `MessageTemplate` and
`MessageTemplateVersion`. Every row is project-owned and every optional
connection, message, asset and template-version relation uses a project-bound
composite foreign key. `MediaAsset.bucketKey` is unique, but presigned URLs and
bucket credentials are never persisted. Provider references may remain
`PROVIDER_REFERENCE`; only validated objects become `AVAILABLE`.

Published template versions are immutable application records. Scenario graphs
and prepared broadcasts reference a concrete `(projectId, templateId,
templateVersionId)` tuple. Archiving a template does not delete its versions or
media, so existing execution and audit history remains reproducible. All media
lifecycle timestamps use `TIMESTAMPTZ(3)` and provider metadata/content use
`JSONB`.

The executable changes are recorded by
`20260727002750_telegram_media_templates`; the follow-up
`20260727004642_template_content_hash_index` changes `contentHash` from a Prisma
unique selector to a normal lookup index so identical historical content can be
restored without manufacturing uniqueness. Tenant-safe version and asset
constraints remain unique. `PUBLISHED` and `SUPERSEDED` template versions both
retain referenced media because existing scenarios can pin either state.

## Telegram interactive media extension

Migration `20260729000100_telegram_interactive_media` extends the existing
PostgreSQL enums without replacing tables or rewriting historical rows:

- `NormalizedEventType` and `MessageType` add `VIDEO`, `AUDIO`, `VOICE`,
  `VIDEO_NOTE` and `ANIMATION`;
- `MessageTemplateKind` adds the same five media kinds;
- existing `TEXT`, `PHOTO` and `DOCUMENT` values remain unchanged.

`MediaAsset.kind` continues to share the immutable template/media kind enum, so
an asset cannot be interpreted as a different Telegram method after
publication. Outbound messages reference the asset through the existing
tenant-safe `(projectId, mediaAssetId)` foreign key. Inline keyboard and reply
configuration remains validated JSON in immutable template content/message
metadata; credentials, signed URLs and raw provider responses are never stored.

Migration `20260801000200_telegram_sticker_media` additionally adds `STICKER`
to `NormalizedEventType`, `MessageType`, and `MessageTemplateKind`. A sticker
continues to use one `Message` and one optional `MediaAsset`; its provider
`file_id` remains scoped to the owning connection. Static WEBP, animated TGS,
and video WEBM uploads are distinguished by detected MIME type and extension.
Media spoiler state is stored as a boolean in safe message metadata because it
changes presentation rather than relational identity.

Callback acknowledgement uses an `OutboxRecord` with `kind=TELEGRAM` and an
action-discriminated JSON payload containing only the internal connection and
Telegram callback query identifier. The stable
`callback-answer-<normalizedEventId>` idempotency key prevents duplicate
acknowledgements. Normal message outboxes retain their internal `messageId` and
`channelIdentityId` payload.

CRM history synchronization creates no history snapshot table. It uses existing
`CrmOperation` and `OutboxRecord` rows with stable
`crm-history-<messageId>` keys. Only bounded, earlier inbound messages with a
normalized event are eligible. This makes repeated lead upserts and concurrent
worker replicas harmless while retaining the normal CRM retry/unknown journal.

Confirmed outbound CRM history uses the same journal with a distinct
`FORWARD_OUTBOUND_MESSAGE` operation. `CrmOperation.messageId` has a tenant-safe
foreign key `(projectId, messageId) -> Message(projectId, id)` with
`ON DELETE RESTRICT`; it cannot point to another project. Each successfully sent
non-CRM Telegram message receives at most one CRM operation through the unique
outbox relation and stable `crm-outbound-history-<messageId>` key.

The CRM intent is created transactionally with the Telegram `SENT` transition.
A bounded recovery query covers earlier `SENT` automation/broadcast messages
that predate this migration. The journal stores only internal IDs and safe
source metadata; signed download URLs are generated immediately before the CRM
request and are not persisted.

## Telegram reaction events

Migration `20260801000100_telegram_reaction_events` extends the existing enums
with `NormalizedEventType.REACTION` and
`CrmOperationType.FORWARD_REACTION_EVENT`. It does not rewrite prior messages
or webhook rows.

A Telegram `message_reaction` update remains an ordinary deduplicated
`RawWebhookEvent`/`InboxRecord`. The processor creates exactly one
`NormalizedEvent` and resolves the reacted-to Telegram provider message inside
the same project and connection before storing its Omnicus message UUID in the
normalized JSONB payload. Reactions do not create synthetic `Message` rows.

When a CRM connection is enabled, the same transaction creates one CRM outbox
intent using `crm-reaction-<normalizedEventId>`. `CrmOperation` references the
normalized event and target contact through existing tenant-safe composite
foreign keys. A reaction that races ahead of its source message stays
retryable until the source mapping exists; after exhaustion the raw webhook is
retained in dead-letter state for safe replay.

## Telegram Chat v3.2 CRM provider extension

Migration `20260802000100_telegram_chat_v32` adds only project-owned provider
state. `Conversation` receives an explicit `AUTO | MANUAL | PAUSED` state,
`automationResumeAt`, a safe reason code and an integer revision. The revision
is the optimistic-concurrency token; `PAUSED` rows are resumed by a bounded
PostgreSQL scan, never by a Redis-only timer.

`ScheduledMessage` owns an immutable normalized outbound request, IANA
timezone, due time and its current `Message`/`OutboxRecord`. Each relation
includes `projectId`. Contract 3.2 releases one-shot scheduling only;
`recurrence` remains null and is reserved for a separately reviewed contract
and state machine. Cancellation uses a conditional database transition and
cannot convert `PROCESSING`, `SENT` or `UNKNOWN` into a safe-to-retry state.

`TelegramMediaGroup` and `TelegramMediaGroupItem` represent one logical album
and its ordered 2-10 PHOTO/VIDEO, all-AUDIO, or all-DOCUMENT items. The group
owns one outbox operation and records every returned provider message ID in
item order. It is never decomposed into independent CRM outbound requests.
An uncertain provider outcome makes the complete aggregate `UNKNOWN`.

`TelegramBotInterface` stores a connection-scoped normalized commands/menu
configuration and revision. Provider changes use the ordinary Telegram outbox
and stable CRM idempotency key. No bot token, provider response or arbitrary
callback payload is stored.

`IdempotencyRecord.resultSafe` optionally stores a provider-independent result
for synchronous state mutations that must replay the original response. The
Telegram automation-state endpoint uses it with the request's normalized
state fields; message bodies, provider identifiers and credentials are not
stored there.

Inbound `edited_message` and contact shares remain ordinary deduplicated
`RawWebhookEvent`/`InboxRecord` rows. They add `MESSAGE_EDITED` and
`CONTACT_SHARED` normalized types. An edit updates the already scoped source
`Message` and creates an idempotent CRM intent; it never creates a second chat
message. A contact share is stored as a typed message and forwarded as an
explicit value object. It never triggers phone-based contact merge.

## Telegram Chat v3.3 provider extension

Migration `20260802000300_telegram_chat_v33` adds `MessageType.RICH` and a
`revision` column to `ScheduledMessage`. Rich Markdown and its normalized typed
media reference use the existing `Message.content`, `Message.metadata` and
optional tenant-safe `mediaAssetId` relation. Reply keyboards and Force Reply
are bounded JSON metadata on the same message. No remote media URL or provider
credential is stored.

`ScheduledMessage.recurrence` changes from a reserved nullable value to the
reviewed `{frequency, interval, count?, until?}` rule. Every occurrence remains
a separate project-owned message and outbox operation with the same `seriesId`
and monotonically increasing `occurrence`. The unique
`(projectId, seriesId, occurrence)` constraint makes concurrent completion
harmless. Only one future occurrence is created; cancellation therefore stops
the series without a Redis-owned recurring job. `revision` is incremented by a
conditional queued-only update and is the public optimistic-concurrency token.

## Operations and account-lifecycle completion

The Operations/Audit, role authoring, invitation, password-reset, project clone
and System Health slice introduces no new table or column. It intentionally
reuses these existing records:

- `InboxRecord`, `OutboxRecord`, `ScenarioExecution`, `Broadcast` and
  `CrmOperation` for bounded safe operational projections;
- `AuditLog` for every retry, reconciliation, role, invitation, reset and clone
  mutation;
- `PasswordResetToken`, `GlobalUserInviteToken`,
  `ProjectUserInviteToken` and their active-reservation rows for hashed,
  expiring, one-time links;
- `GlobalRole`, `ProjectRole` and their permission join tables for custom roles.

Raw webhook payloads, outbox payloads, message content, password/reset/invite
tokens and encrypted credentials are never selected into the new list APIs.
Because the Prisma schema is unchanged, this slice has no migration.

## Automation Activity projection

Automation Activity introduces no table, column or migration. PostgreSQL remains
authoritative through the existing `ScenarioExecution`, `NodeExecution`,
`WaitState`, `DelayedAction`, `ScenarioVersion`, `Scenario` and `Contact`
relations. The API applies `projectId` to the root execution query, supports a
bounded 7/30/90-day period and paginates journeys at no more than 50 rows.

Exact summary and scenario counts use database aggregation. Trend and safe
drop-off-reason charts inspect at most the most recent 2,000 matching
executions and explicitly report when that chart source is sampled. Responses
exclude execution variables, normalized event payloads, node input/output,
provider payloads, message content and credentials. Only allow-listed contact
display fields and human-safe error categories leave the API.

## CRM contact merge and channel-aware schedules

Migration `20260808000000_crm_contact_merge` completes the durable merge path.
The secondary contact becomes `MERGED` with `mergedIntoContactId`; conversations,
messages, identities, scenario executions and related project-owned records
are reparented to the selected primary inside the project boundary. A
`MERGE_CONTACTS` CRM operation and matching outbox record preserve recovery and
idempotency. The historical backfill uses the same shape and never invents a
fuzzy contact match.

Scheduled-message persistence remains provider-neutral. Telegram occurrences
may carry bounded DAILY/WEEKLY recurrence. WhatsApp rows have no recurrence,
carry one text occurrence and use `OutboxKind.WHATSAPP` when due. The service
window is still derived from `Conversation.lastInboundAt` and
`serviceWindowExpiresAt`; scheduled delivery does not extend it.

## WhatsApp Business Cloud API provider extension

Migration `20260803000100_whatsapp_cloud_api` extends the existing
provider-neutral channel journal; it does not create a second WhatsApp-only
message store.

- `OutboxKind.WHATSAPP` separates provider delivery workers without changing
  the generic `OutboxRecord` state machine.
- `MessageStatus` adds `DELIVERED`, `READ` and `DELETED`. A successful Graph
  messages response containing a `wamid` maps to the existing `SENT` state.
  Provider status callbacks may advance a message monotonically; an older
  callback is retained as a fact but cannot regress the current message status.
- `MessageType.INTERACTIVE`, `NormalizedEventType.MESSAGE_STATUS` and
  `NormalizedEventType.INTERACTIVE` preserve provider-independent WhatsApp
  button/list replies and delivery events. Unsupported provider types remain
  explicit `UNSUPPORTED` events/messages rather than being dropped.
- `MediaAssetSource.WHATSAPP` reuses the private media lifecycle. A provider
  media ID is connection-scoped; the temporary Meta download URL is never
  persisted and is fetched only by the authenticated adapter.
- `Conversation.lastInboundAt` and `serviceWindowExpiresAt` are the durable
  authority for WhatsApp's customer-service window. Free-form sends require an
  open window; an approved template is required otherwise. Redis never owns
  this boundary.
- `MessageStatusEvent` stores one safe normalized status fact with a stable
  provider event key, timestamp and optional safe error code. It contains no
  raw provider error payload or message content.
- `CrmOperationType.FORWARD_MESSAGE_STATUS` journals every normalized
  WhatsApp status fact before its provider-neutral CRM callback is attempted.
- `WhatsAppMessageTemplate` stores the latest safe Meta projection by project,
  connection, name and language: provider template ID, category, normalized
  status, normalized components, quality/rejection summary and sync time.
  Meta remains the status authority. Raw template payloads and credentials are
  not stored or returned.

`ChannelConnection` remains provider-neutral. WhatsApp access tokens are
encrypted per connection. Global Meta App secret and webhook verification
token remain server configuration because Meta signs and verifies the one
app-level callback before a tenant connection can be resolved. Safe provider
account/identity IDs are indexed columns: for WhatsApp they mean WABA ID and
phone-number ID. The unique `(type, providerIdentityId)` mapping lets a verified
change resolve exactly one project connection without scanning encrypted or
JSON data. Display phone data, configured Graph API version and webhook state
live in bounded `webhookMetadata`. No secret is selected into API responses,
logs or audit metadata.

One Meta webhook delivery may contain changes for several phone numbers and
projects. After global signature verification the API splits it into exact
bounded individual message/status/reaction items. Every matched item creates
its own `RawWebhookEvent` plus one-to-one `InboxRecord`; only that item's
connection-owned slice is persisted. Unknown phone IDs are acknowledged
without raw storage. `RawWebhookEvent.externalUpdateId` is the stable
provider-derived item key, so a retry or another provider envelope cannot
create a second domain effect. The existing Telegram one-to-one relation and
semantics remain unchanged.

## Current acquisition and email schema addendum

- `LeadCaptureEvent` is the durable idempotent registration fact. It stores the
  project/source/contact relationship, a request fingerprint and processing
  lifecycle without storing an ingest credential.
- `TrackedLink` stores an opaque redirect token and bounded original HTTP(S)
  target for one contact/scenario node. `TrackedLinkClick` deduplicates observed
  clicks and supplies the safe Omnicus/CRM timeline projection.
- WhatsApp consent belongs to `Contact`; reachability evidence belongs to the
  exact WhatsApp `ChannelIdentity`. These values must not be collapsed into one
  boolean because consent, provider availability and service-window state are
  independent facts.
- `EmailTemplate` owns the mutable draft identity;
  `EmailTemplateVersion` is immutable after publication.
- `EmailCampaign` owns the saved audience definition and launch lifecycle.
  `EmailDelivery` is the per-recipient snapshot and lease/retry authority.
- `EmailEvent` deduplicates signed provider lifecycle events and preserves
  monotonic delivery evidence. `EmailSuppression` is project/address scoped and
  takes precedence over consent or campaign filters.
- `EmailAssetReference` pins project-owned media used by a campaign/template so
  retention cannot remove an asset while a delivery may still need it.

The ordered migrations `20260814000000_lead_capture_tracking`,
`20260814020000_whatsapp_mailing_eligibility` and
`20260814030000_email_campaigns` must be applied before the corresponding API
and worker artifacts start.
