import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const pnpmExecutable = process.env.npm_execpath;

if (!pnpmExecutable || !/(?:corepack|pnpm)/i.test(pnpmExecutable)) {
  throw new Error('Run this check through the repository pnpm command');
}

const result = spawnSync(
  process.execPath,
  [
    pnpmExecutable,
    '--filter',
    '@omnicus/database',
    'exec',
    'prisma',
    'migrate',
    'diff',
    '--from-empty',
    '--to-schema',
    'prisma/schema.prisma',
    '--script',
  ],
  {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://prisma_validation:prisma_validation@127.0.0.1:5432/omnicus_validation',
    },
  },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const sql = result.stdout.replaceAll('\r\n', '\n');
const failures = [];
const proposalPath = resolve(repositoryRoot, 'docs/STAGE1_BASELINE_SQL_PROPOSAL.sql');
const proposal = readFileSync(proposalPath, 'utf8').replaceAll('\r\n', '\n');
const proposalSql = proposal.slice(proposal.indexOf('-- CreateSchema')).trim();
const expectedTables = new Set([
  'audit_logs',
  'global_active_invite_reservations',
  'global_role_permissions',
  'global_roles',
  'global_user_invite_tokens',
  'global_user_roles',
  'password_reset_tokens',
  'permissions',
  'project_memberships',
  'project_active_invite_reservations',
  'project_role_permissions',
  'project_roles',
  'project_user_invite_tokens',
  'projects',
  'sessions',
  'users',
  'contacts',
  'channel_identities',
  'tags',
  'contact_tags',
  'custom_field_definitions',
  'contact_custom_field_values',
  'segments',
  'channel_connections',
  'raw_webhook_events',
  'inbox_records',
  'normalized_events',
  'conversations',
  'messages',
  'outbox_records',
  'idempotency_records',
  'scenarios',
  'scenario_versions',
  'scenario_executions',
  'node_executions',
  'crm_operations',
  'crm_project_configs',
  'wait_states',
  'delayed_actions',
  'automation_secrets',
  'external_http_operations',
  'broadcasts',
  'broadcast_recipients',
  'media_assets',
  'message_templates',
  'message_template_versions',
  'message_status_events',
  'scheduled_messages',
  'telegram_bot_interfaces',
  'telegram_media_group_items',
  'telegram_media_groups',
  'whatsapp_message_templates',
  'lead_capture_events',
  'tracked_links',
  'tracked_link_clicks',
  'email_templates',
  'email_template_versions',
  'email_campaigns',
  'email_deliveries',
  'email_events',
  'email_suppressions',
  'email_asset_references',
]);
const generatedTables = new Set(
  [...sql.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1]),
);

if (
  generatedTables.size !== expectedTables.size ||
  [...expectedTables].some((table) => !generatedTables.has(table))
) {
  failures.push(`Executable schema table slice differs: ${[...generatedTables].sort().join(', ')}`);
}

const requiredSql = [
  'CREATE TABLE "global_active_invite_reservations"',
  'CREATE TABLE "project_active_invite_reservations"',
  'CREATE UNIQUE INDEX "global_active_invite_reservations_inviteTokenId_key"',
  'CREATE UNIQUE INDEX "project_active_invite_reservations_inviteTokenId_key"',
  '"correlationId" TEXT NOT NULL',
  'CREATE UNIQUE INDEX "sessions_replacedBySessionId_userId_tokenFamilyId_key"',
  'CREATE INDEX "global_role_permissions_permissionId_idx"',
  'CREATE INDEX "project_role_permissions_permissionId_idx"',
  'CREATE INDEX "global_user_roles_createdById_idx"',
  'CREATE INDEX "project_memberships_createdById_idx"',
  'CREATE INDEX "global_user_invite_tokens_invitedById_idx"',
  'CREATE INDEX "project_user_invite_tokens_invitedById_idx"',
  'ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT',
  'FOREIGN KEY ("replacedBySessionId", "userId", "tokenFamilyId") REFERENCES "sessions"("id", "userId", "tokenFamilyId") ON DELETE RESTRICT',
  'FOREIGN KEY ("projectId", "projectRoleId") REFERENCES "project_roles"("projectId", "id") ON DELETE RESTRICT',
  'FOREIGN KEY ("projectId", "projectRoleId") REFERENCES "project_roles"("projectId", "id") ON DELETE CASCADE',
  'ALTER TABLE "global_role_permissions" ADD CONSTRAINT',
  'REFERENCES "global_roles"("id") ON DELETE CASCADE',
  'ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_projectId_fkey"',
  'REFERENCES "projects"("id") ON DELETE RESTRICT',
  'ALTER TABLE "project_roles" ADD CONSTRAINT "project_roles_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT',
  'ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT',
  'ALTER TABLE "project_user_invite_tokens" ADD CONSTRAINT "project_user_invite_tokens_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT',
  'FOREIGN KEY ("inviteTokenId", "globalRoleId") REFERENCES "global_user_invite_tokens"("id", "globalRoleId") ON DELETE CASCADE',
  'FOREIGN KEY ("projectId", "inviteTokenId") REFERENCES "project_user_invite_tokens"("projectId", "id") ON DELETE CASCADE',
];

for (const fragment of requiredSql) {
  if (!sql.includes(fragment)) {
    failures.push(`Generated SQL is missing invariant: ${fragment}`);
  }
}

if (sql.includes('CREATE TABLE "roles"') || sql.includes('CREATE TABLE "role_permissions"')) {
  failures.push('Rejected nullable-scope RBAC tables reappeared');
}

if (sql.includes('CONSTRAINT "sessions_replacedBySessionId_fkey"')) {
  failures.push('Session rotation lost its user/token-family boundary');
}

if (sql.includes('audit_logs_projectId_id_key')) {
  failures.push('Dual-scope audit log regained a misleading nullable composite unique');
}

if (
  sql.includes('WHERE ("acceptedAt" IS NULL AND "revokedAt" IS NULL)') ||
  sql.includes('global_invites_active_email_role_key') ||
  sql.includes('project_invites_active_email_key')
) {
  failures.push('Partial invitation unique selectors reappeared in the Prisma diff');
}

if (sql.includes('TIMESTAMP(3) ') || sql.includes('TIMESTAMP(3),')) {
  failures.push('A lifecycle timestamp was generated without time zone');
}

if (/\bDROP\s+(?:TABLE|TYPE|INDEX|COLUMN)\b/i.test(sql)) {
  failures.push('Fresh schema diff contains a destructive operation');
}

const migrationPath = resolve(
  repositoryRoot,
  'packages/database/prisma/migrations/20260726000100_stage1_auth_rbac_projects/migration.sql',
);
if (!existsSync(migrationPath)) {
  failures.push('Stage 1 initial migration is missing');
} else {
  const migrationSql = readFileSync(migrationPath, 'utf8').replaceAll('\r\n', '\n');
  if (!migrationSql.includes('CREATE TABLE "users"')) {
    failures.push('Stage 1 initial migration is malformed');
  }
}

const stage2MigrationPath = resolve(
  repositoryRoot,
  'packages/database/prisma/migrations/20260726000200_stage2_contacts_tags_fields/migration.sql',
);
if (!existsSync(stage2MigrationPath)) {
  failures.push('Stage 2 contacts migration is missing');
} else {
  const stage2MigrationSql = readFileSync(stage2MigrationPath, 'utf8').replaceAll('\r\n', '\n');
  for (const fragment of [
    'CREATE TABLE "contacts"',
    'CREATE TABLE "channel_identities"',
    'CREATE TABLE "tags"',
    'CREATE TABLE "contact_tags"',
    'CREATE TABLE "custom_field_definitions"',
    'FOREIGN KEY ("projectId", "contactId") REFERENCES "contacts"("projectId", "id")',
    'FOREIGN KEY ("projectId", "tagId") REFERENCES "tags"("projectId", "id")',
    '"customFields" JSONB NOT NULL DEFAULT \'{}\'',
    'TIMESTAMPTZ(3)',
  ]) {
    if (!stage2MigrationSql.includes(fragment))
      failures.push(`Stage 2 migration is missing invariant: ${fragment}`);
  }
}

const stage3MigrationPath = resolve(
  repositoryRoot,
  'packages/database/prisma/migrations/20260726000300_stage3_telegram_persistence/migration.sql',
);
if (!existsSync(stage3MigrationPath)) {
  failures.push('Stage 3 Telegram persistence migration is missing');
} else {
  const stage3MigrationSql = readFileSync(stage3MigrationPath, 'utf8').replaceAll('\r\n', '\n');
  for (const fragment of [
    'CREATE TABLE "channel_connections"',
    'CREATE TABLE "raw_webhook_events"',
    'CREATE TABLE "inbox_records"',
    'CREATE TABLE "normalized_events"',
    'CREATE TABLE "conversations"',
    'CREATE TABLE "messages"',
    'CREATE TABLE "outbox_records"',
    'CREATE TABLE "idempotency_records"',
    'CREATE UNIQUE INDEX "raw_webhook_events_connectionId_externalUpdateId_key"',
    'CREATE UNIQUE INDEX "normalized_events_inboxRecordId_key"',
    'CREATE UNIQUE INDEX "conversations_projectId_connectionId_externalChatId_key"',
    'CREATE UNIQUE INDEX "messages_connectionId_direction_externalMessageId_key"',
    'CREATE UNIQUE INDEX "messages_projectId_normalizedEventId_key"',
    'FOREIGN KEY ("projectId", "connectionId") REFERENCES "channel_connections"("projectId", "id")',
    'FOREIGN KEY ("projectId", "rawWebhookEventId") REFERENCES "raw_webhook_events"("projectId", "id")',
    'FOREIGN KEY ("projectId", "inboxRecordId") REFERENCES "inbox_records"("projectId", "id")',
    'FOREIGN KEY ("projectId", "contactId") REFERENCES "contacts"("projectId", "id")',
    'FOREIGN KEY ("projectId", "conversationId") REFERENCES "conversations"("projectId", "id")',
    'FOREIGN KEY ("projectId", "normalizedEventId") REFERENCES "normalized_events"("projectId", "id")',
    '"credentialsEncrypted" JSONB NOT NULL',
    '"webhookSecretEncrypted" JSONB NOT NULL',
    'TIMESTAMPTZ(3)',
  ]) {
    if (!stage3MigrationSql.includes(fragment)) {
      failures.push(`Stage 3 migration is missing invariant: ${fragment}`);
    }
  }

  for (const forbidden of ['botToken', 'webhookSecret" TEXT', 'plaintext']) {
    if (stage3MigrationSql.includes(forbidden)) {
      failures.push(`Stage 3 migration contains forbidden secret storage: ${forbidden}`);
    }
  }

  if (/\bDROP\s+(?:TABLE|TYPE|INDEX|COLUMN)\b/i.test(stage3MigrationSql)) {
    failures.push('Stage 3 migration contains a destructive operation');
  }
}

const stage3WebhookMigrationPath = resolve(
  repositoryRoot,
  'packages/database/prisma/migrations/20260726000400_stage3_webhook_correlation/migration.sql',
);
if (!existsSync(stage3WebhookMigrationPath)) {
  failures.push('Stage 3 webhook correlation migration is missing');
} else {
  const stage3WebhookMigrationSql = readFileSync(stage3WebhookMigrationPath, 'utf8').replaceAll(
    '\r\n',
    '\n',
  );
  for (const fragment of [
    'ADD COLUMN "correlationId" TEXT NOT NULL',
    'CREATE INDEX "raw_webhook_events_projectId_correlationId_idx"',
  ]) {
    if (!stage3WebhookMigrationSql.includes(fragment)) {
      failures.push(`Stage 3 webhook migration is missing invariant: ${fragment}`);
    }
  }
}

const stage4MigrationPath = resolve(
  repositoryRoot,
  'packages/database/prisma/migrations/20260726220043_stage4_automation_runtime/migration.sql',
);
if (!existsSync(stage4MigrationPath)) {
  failures.push('Stage 4 automation migration is missing');
} else {
  const stage4MigrationSql = readFileSync(stage4MigrationPath, 'utf8').replaceAll('\r\n', '\n');
  for (const fragment of [
    'CREATE TABLE "scenarios"',
    'CREATE TABLE "scenario_versions"',
    'CREATE TABLE "scenario_executions"',
    'CREATE TABLE "node_executions"',
    '"nextAutomationSequence" BIGINT NOT NULL DEFAULT 0',
    '"automationModeOverride" "AutomationMode"',
    'FOREIGN KEY ("projectId", "scenarioId", "scenarioVersionId") REFERENCES "scenario_versions"("projectId", "scenarioId", "id")',
    'FOREIGN KEY ("projectId", "contactId") REFERENCES "contacts"("projectId", "id")',
    'FOREIGN KEY ("projectId", "conversationId") REFERENCES "conversations"("projectId", "id")',
    'FOREIGN KEY ("projectId", "triggerEventId") REFERENCES "normalized_events"("projectId", "id")',
    'TIMESTAMPTZ(3)',
  ]) {
    if (!stage4MigrationSql.includes(fragment)) {
      failures.push(`Stage 4 migration is missing invariant: ${fragment}`);
    }
  }
  if (/\bDROP\s+(?:TABLE|TYPE|INDEX|COLUMN)\b/i.test(stage4MigrationSql)) {
    failures.push('Stage 4 migration contains a destructive operation');
  }
}

const stage5MigrationPath = resolve(
  repositoryRoot,
  'packages/database/prisma/migrations/20260726222037_stage5_crm_mock_outbox/migration.sql',
);
if (!existsSync(stage5MigrationPath)) {
  failures.push('Stage 5 CRM mock outbox migration is missing');
} else {
  const stage5MigrationSql = readFileSync(stage5MigrationPath, 'utf8').replaceAll('\r\n', '\n');
  for (const fragment of [
    'CREATE TABLE "crm_project_configs"',
    'CREATE TABLE "crm_operations"',
    'ALTER COLUMN "connectionId" DROP NOT NULL',
    '"kind" "OutboxKind" NOT NULL DEFAULT \'TELEGRAM\'',
    'FOREIGN KEY ("projectId", "outboxRecordId") REFERENCES "outbox_records"("projectId", "id")',
    'TIMESTAMPTZ(3)',
  ]) {
    if (!stage5MigrationSql.includes(fragment)) {
      failures.push(`Stage 5 migration is missing invariant: ${fragment}`);
    }
  }
}

const automationContinuationMigrationPath = resolve(
  repositoryRoot,
  'packages/database/prisma/migrations/20260726230957_automation_v2_continuations/migration.sql',
);
if (!existsSync(automationContinuationMigrationPath)) {
  failures.push('Automation v2 continuation migration is missing');
} else {
  const automationContinuationSql = readFileSync(
    automationContinuationMigrationPath,
    'utf8',
  ).replaceAll('\r\n', '\n');
  for (const fragment of [
    'CREATE TABLE "wait_states"',
    'CREATE TABLE "delayed_actions"',
    "ADD VALUE 'WAITING'",
    'FOREIGN KEY ("projectId", "scenarioExecutionId") REFERENCES "scenario_executions"("projectId", "id")',
    'FOREIGN KEY ("projectId", "conversationId") REFERENCES "conversations"("projectId", "id")',
    'CREATE UNIQUE INDEX "wait_states_projectId_scenarioExecutionId_nodeId_key"',
    'CREATE UNIQUE INDEX "delayed_actions_projectId_scenarioExecutionId_nodeId_key"',
    'TIMESTAMPTZ(3)',
  ]) {
    if (!automationContinuationSql.includes(fragment)) {
      failures.push(`Automation v2 continuation migration is missing invariant: ${fragment}`);
    }
  }
}

const automationWaitConstraintMigrationPath = resolve(
  repositoryRoot,
  'packages/database/prisma/migrations/20260726231000_automation_v2_wait_constraint/migration.sql',
);
if (!existsSync(automationWaitConstraintMigrationPath)) {
  failures.push('Automation v2 wait-state constraint migration is missing');
} else {
  const automationWaitConstraintSql = readFileSync(
    automationWaitConstraintMigrationPath,
    'utf8',
  ).replaceAll('\r\n', '\n');
  if (
    !automationWaitConstraintSql.includes(
      'CREATE UNIQUE INDEX "wait_states_one_active_per_conversation_scenario"',
    ) ||
    !automationWaitConstraintSql.includes('WHERE "status" = \'ACTIVE\'')
  ) {
    failures.push('Automation v2 active wait partial uniqueness is missing');
  }
}

const contactsV2MigrationPath = resolve(
  repositoryRoot,
  'packages/database/prisma/migrations/20260726232847_contacts_v2_segments_merge/migration.sql',
);
if (!existsSync(contactsV2MigrationPath)) {
  failures.push('Contacts v2 persistence migration is missing');
} else {
  const contactsV2Sql = readFileSync(contactsV2MigrationPath, 'utf8').replaceAll('\r\n', '\n');
  for (const fragment of [
    'CREATE TABLE "contact_custom_field_values"',
    'CREATE TABLE "segments"',
    'ALTER TYPE "ContactStatus" ADD VALUE \'MERGED\'',
    'FOREIGN KEY ("projectId", "mergedIntoContactId") REFERENCES "contacts"("projectId", "id")',
    'FOREIGN KEY ("projectId", "contactId") REFERENCES "contacts"("projectId", "id")',
    'FOREIGN KEY ("projectId", "definitionId") REFERENCES "custom_field_definitions"("projectId", "id")',
    'CREATE UNIQUE INDEX "contact_custom_field_values_projectId_contactId_definitionI_key"',
    'CREATE UNIQUE INDEX "segments_projectId_name_key"',
    'TIMESTAMPTZ(3)',
  ]) {
    if (!contactsV2Sql.includes(fragment))
      failures.push(`Contacts v2 migration is missing invariant: ${fragment}`);
  }
}

const contactsV2BackfillMigrationPath = resolve(
  repositoryRoot,
  'packages/database/prisma/migrations/20260726232900_contacts_v2_custom_field_backfill/migration.sql',
);
if (!existsSync(contactsV2BackfillMigrationPath)) {
  failures.push('Contacts v2 custom-field projection backfill migration is missing');
} else if (
  !readFileSync(contactsV2BackfillMigrationPath, 'utf8').includes(
    'INSERT INTO "contact_custom_field_values"',
  )
) {
  failures.push('Contacts v2 custom-field projection backfill is malformed');
}

const broadcastsMigrationPath = resolve(
  repositoryRoot,
  'packages/database/prisma/migrations/20260726234301_telegram_broadcasts/migration.sql',
);
const broadcastConnectionScopeMigrationPath = resolve(
  repositoryRoot,
  'packages/database/prisma/migrations/20260726234411_broadcast_recipient_connection_scope/migration.sql',
);
const broadcastPreparationLeaseMigrationPath = resolve(
  repositoryRoot,
  'packages/database/prisma/migrations/20260726235509_broadcast_preparation_lease/migration.sql',
);
if (
  !existsSync(broadcastsMigrationPath) ||
  !existsSync(broadcastConnectionScopeMigrationPath) ||
  !existsSync(broadcastPreparationLeaseMigrationPath)
) {
  failures.push('Telegram broadcast persistence migrations are missing');
} else {
  const broadcastsSql = readFileSync(broadcastsMigrationPath, 'utf8').replaceAll('\r\n', '\n');
  const scopeSql = readFileSync(broadcastConnectionScopeMigrationPath, 'utf8').replaceAll(
    '\r\n',
    '\n',
  );
  const leaseSql = readFileSync(broadcastPreparationLeaseMigrationPath, 'utf8').replaceAll(
    '\r\n',
    '\n',
  );
  for (const fragment of [
    'CREATE TYPE "BroadcastStatus"',
    'CREATE TYPE "BroadcastRecipientStatus"',
    'CREATE TABLE "broadcasts"',
    'CREATE TABLE "broadcast_recipients"',
    'CREATE UNIQUE INDEX "broadcast_recipients_projectId_broadcastId_channelIdentityI_key"',
    'FOREIGN KEY ("projectId", "broadcastId") REFERENCES "broadcasts"("projectId", "id")',
    'FOREIGN KEY ("projectId", "channelIdentityId") REFERENCES "channel_identities"("projectId", "id")',
    'TIMESTAMPTZ(3)',
  ]) {
    if (!broadcastsSql.includes(fragment))
      failures.push(`Telegram broadcast migration is missing invariant: ${fragment}`);
  }
  if (
    !scopeSql.includes(
      'FOREIGN KEY ("projectId", "connectionId") REFERENCES "channel_connections"("projectId", "id")',
    )
  )
    failures.push('Broadcast recipient connection lost its tenant boundary');
  for (const pattern of [
    /ADD COLUMN\s+"preparationLockedAt" TIMESTAMPTZ\(3\)/,
    /ADD COLUMN\s+"preparationLockedBy" TEXT/,
  ]) {
    if (!pattern.test(leaseSql)) {
      failures.push(
        `Broadcast preparation lease migration is missing invariant: ${pattern.source}`,
      );
    }
  }
}

const mediaTemplatesMigrationPath = resolve(
  repositoryRoot,
  'packages/database/prisma/migrations/20260727002750_telegram_media_templates/migration.sql',
);
const templateHashIndexMigrationPath = resolve(
  repositoryRoot,
  'packages/database/prisma/migrations/20260727004642_template_content_hash_index/migration.sql',
);
if (!existsSync(mediaTemplatesMigrationPath) || !existsSync(templateHashIndexMigrationPath)) {
  failures.push('Telegram media and template migrations are missing');
} else {
  const mediaTemplatesSql = readFileSync(mediaTemplatesMigrationPath, 'utf8').replaceAll(
    '\r\n',
    '\n',
  );
  const templateHashIndexSql = readFileSync(templateHashIndexMigrationPath, 'utf8').replaceAll(
    '\r\n',
    '\n',
  );
  for (const fragment of [
    'CREATE TABLE "media_assets"',
    'CREATE TABLE "message_templates"',
    'CREATE TABLE "message_template_versions"',
    '"providerMetadata" JSONB',
    '"retentionUntil" TIMESTAMPTZ(3)',
    'FOREIGN KEY ("projectId", "connectionId") REFERENCES "channel_connections"("projectId", "id")',
    'FOREIGN KEY ("projectId", "mediaAssetId") REFERENCES "media_assets"("projectId", "id")',
    'FOREIGN KEY ("projectId", "templateVersionId") REFERENCES "message_template_versions"("projectId", "id")',
    'CREATE UNIQUE INDEX "media_assets_projectId_connectionId_providerMediaId_key"',
    'CREATE UNIQUE INDEX "message_template_versions_projectId_templateId_version_key"',
  ]) {
    if (!mediaTemplatesSql.includes(fragment))
      failures.push(`Telegram media/template migration is missing invariant: ${fragment}`);
  }
  for (const forbidden of ['botToken', 'webhookSecret', 'credentialsEncrypted']) {
    if (mediaTemplatesSql.includes(forbidden))
      failures.push(`Telegram media/template migration contains secret material: ${forbidden}`);
  }
  if (
    !templateHashIndexSql.includes(
      'CREATE INDEX "message_template_versions_projectId_templateId_contentHash_idx"',
    )
  )
    failures.push('Template content hashes are not represented by a non-selector index');
}

if (!proposalSql.includes('CREATE TABLE "users"')) {
  failures.push('Committed Stage 1 SQL proposal is malformed');
}

const crmOutboundHistoryMigrationPath = resolve(
  repositoryRoot,
  'packages/database/prisma/migrations/20260729000200_crm_outbound_history/migration.sql',
);
if (!existsSync(crmOutboundHistoryMigrationPath)) {
  failures.push('CRM outbound history migration is missing');
} else {
  const crmOutboundHistorySql = readFileSync(crmOutboundHistoryMigrationPath, 'utf8').replaceAll(
    '\r\n',
    '\n',
  );
  for (const fragment of [
    'ALTER TYPE "CrmOperationType" ADD VALUE \'FORWARD_OUTBOUND_MESSAGE\'',
    'ADD COLUMN "messageId" TEXT',
    'CREATE UNIQUE INDEX "crm_operations_messageId_key"',
    'CREATE INDEX "crm_operations_projectId_messageId_idx"',
    'FOREIGN KEY ("projectId", "messageId") REFERENCES "messages"("projectId", "id")',
    'ON DELETE RESTRICT ON UPDATE CASCADE',
  ]) {
    if (!crmOutboundHistorySql.includes(fragment))
      failures.push(`CRM outbound history migration is missing invariant: ${fragment}`);
  }
  if (/\bDROP\s+(?:TABLE|TYPE|INDEX|COLUMN)\b/i.test(crmOutboundHistorySql))
    failures.push('CRM outbound history migration contains a destructive operation');
}

const telegramChatV32MigrationPath = resolve(
  repositoryRoot,
  'packages/database/prisma/migrations/20260802000100_telegram_chat_v32/migration.sql',
);
if (!existsSync(telegramChatV32MigrationPath)) {
  failures.push('Telegram Chat v3.2 migration proposal is missing');
} else {
  const telegramChatV32Sql = readFileSync(telegramChatV32MigrationPath, 'utf8').replaceAll(
    '\r\n',
    '\n',
  );
  for (const fragment of [
    'CREATE TABLE "scheduled_messages"',
    'CREATE TABLE "telegram_media_groups"',
    'CREATE TABLE "telegram_media_group_items"',
    'CREATE TABLE "telegram_bot_interfaces"',
    'ALTER TABLE "idempotency_records" ADD COLUMN "resultSafe" JSONB',
    'FOREIGN KEY ("projectId", "connectionId") REFERENCES "channel_connections"("projectId", "id")',
    'FOREIGN KEY ("projectId", "contactId") REFERENCES "contacts"("projectId", "id")',
    'FOREIGN KEY ("projectId", "channelIdentityId") REFERENCES "channel_identities"("projectId", "id")',
    'FOREIGN KEY ("projectId", "outboxRecordId") REFERENCES "outbox_records"("projectId", "id")',
    'TIMESTAMPTZ(3)',
  ]) {
    if (!telegramChatV32Sql.includes(fragment))
      failures.push(`Telegram Chat v3.2 migration is missing invariant: ${fragment}`);
  }
  if (/\bDROP\s+(?:TABLE|TYPE|INDEX|COLUMN)\b/i.test(telegramChatV32Sql))
    failures.push('Telegram Chat v3.2 migration contains a destructive operation');
}

const automationStudio22MigrationPath = resolve(
  repositoryRoot,
  'packages/database/prisma/migrations/20260802000200_automation_studio_22_http/migration.sql',
);
if (!existsSync(automationStudio22MigrationPath)) {
  failures.push('Automation Studio 2.2 HTTP migration proposal is missing');
} else {
  const automationStudio22Sql = readFileSync(automationStudio22MigrationPath, 'utf8').replaceAll(
    '\r\n',
    '\n',
  );
  for (const fragment of [
    'ALTER TYPE "OutboxKind" ADD VALUE \'HTTP\'',
    'CREATE TABLE "automation_secrets"',
    'CREATE TABLE "external_http_operations"',
    'CREATE UNIQUE INDEX "automation_secrets_projectId_normalizedName_key"',
    'CREATE UNIQUE INDEX "external_http_operations_projectId_scenarioExecutionId_nodeId_key"',
    'FOREIGN KEY ("projectId", "outboxRecordId") REFERENCES "outbox_records"("projectId", "id")',
    'FOREIGN KEY ("projectId", "scenarioExecutionId") REFERENCES "scenario_executions"("projectId", "id")',
    '"valueEncrypted" JSONB NOT NULL',
    'TIMESTAMPTZ(3)',
  ]) {
    if (!automationStudio22Sql.includes(fragment))
      failures.push(`Automation Studio 2.2 migration is missing invariant: ${fragment}`);
  }
  for (const forbidden of ['renderedUrl', 'requestBody', 'responseBody', 'secretValue']) {
    if (automationStudio22Sql.includes(forbidden))
      failures.push(`Automation Studio 2.2 migration contains unsafe persistence: ${forbidden}`);
  }
  if (/\bDROP\s+(?:TABLE|TYPE|INDEX|COLUMN)\b/i.test(automationStudio22Sql))
    failures.push('Automation Studio 2.2 migration contains a destructive operation');
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`- ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify({
    check: 'prisma-sql-diff',
    migrationCreated: true,
    status: 'passed',
    tables: [...generatedTables].sort(),
  })}\n`,
);
