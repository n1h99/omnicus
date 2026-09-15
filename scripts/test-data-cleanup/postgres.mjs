import { digest, requireSafe } from './safety.mjs';

// Explicit child-first list. Never TRUNCATE, CASCADE, disable constraints, or
// infer a database-wide reset from project membership.
export const DELETE_TABLES = [
  'tracked_link_clicks',
  'tracked_links',
  'lead_capture_events',
  'email_events',
  'email_asset_references',
  'email_deliveries',
  'email_suppressions',
  'broadcast_recipients',
  'scheduled_messages',
  'telegram_media_group_items',
  'telegram_media_groups',
  'crm_operations',
  'external_http_operations',
  'wait_states',
  'delayed_actions',
  'node_executions',
  'scenario_executions',
  'message_status_events',
  'messages',
  'conversations',
  'channel_identities',
  'contact_tags',
  'contact_custom_field_values',
  'contacts',
  'normalized_events',
  'inbox_records',
  'raw_webhook_events',
  'outbox_records',
  'idempotency_records',
  'audit_logs',
  'media_assets',
];

export const PRESERVE_TABLES = [
  'users',
  'sessions',
  'password_reset_tokens',
  'permissions',
  'global_roles',
  'project_roles',
  'global_role_permissions',
  'project_role_permissions',
  'global_user_roles',
  'project_memberships',
  'global_user_invite_tokens',
  'global_active_invite_reservations',
  'project_user_invite_tokens',
  'project_active_invite_reservations',
  'projects',
  'channel_connections',
  'scenarios',
  'scenario_versions',
  'automation_secrets',
  'whatsapp_message_templates',
  'broadcasts',
  'email_templates',
  'email_template_versions',
  'email_campaigns',
  'message_templates',
  'message_template_versions',
  'telegram_bot_interfaces',
  'crm_project_configs',
  'tags',
  'custom_field_definitions',
  'segments',
  '_prisma_migrations',
];

const CONFIG_TABLES = [
  'channel_connections',
  'scenarios',
  'scenario_versions',
  'whatsapp_message_templates',
  'broadcasts',
  'email_templates',
  'email_template_versions',
  'email_campaigns',
  'message_templates',
  'message_template_versions',
  'telegram_bot_interfaces',
  'crm_project_configs',
  'segments',
];

const MAX_ROWS = 20_000;
const MAX_BYTES = 100 * 1024 * 1024;
export const quote = (name) => {
  requireSafe([...DELETE_TABLES, ...PRESERVE_TABLES].includes(name), 'Unreviewed SQL table.');
  return `public."${name}"`;
};

export async function schemaSnapshot(client) {
  const tables = (
    await client.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`)
  ).rows.map((row) => row.table_name);
  const known = [...DELETE_TABLES, ...PRESERVE_TABLES].sort();
  requireSafe(
    digest(tables) === digest(known),
    'PostgreSQL table inventory differs from the reviewed schema. Stop and review the script; do not add a bypass.',
  );
  const triggers = (
    await client.query(`SELECT t.tgname, t.tgtype, c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal`)
  ).rows;
  requireSafe(
    triggers.every(
      (trigger) =>
        trigger.tgname === 'contacts_normalize_identity' &&
        trigger.relname === 'contacts' &&
        trigger.tgtype === 23,
    ),
    'Unreviewed database triggers found.',
  );
  const features = (
    await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND (c.relrowsecurity OR c.relkind='p')`)
  ).rows;
  requireSafe(
    features.length === 0,
    'Row-security/partitioning requires a separate cleanup review.',
  );
  const foreignKeys = (
    await client.query(`SELECT conname, conrelid::regclass::text AS child,
    confrelid::regclass::text AS parent, pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE contype='f' AND (connamespace='public'::regnamespace OR confrelid IN
      (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)) ORDER BY conname`)
  ).rows;
  // No unreviewed cross-schema child can be removed via ON DELETE CASCADE.
  requireSafe(
    foreignKeys.every((fk) => !fk.child.includes('.')),
    'Cross-schema foreign key found.',
  );
  return { tables, foreignKeys };
}

export async function readState(client, target) {
  const projectId = target.omnicus.projectId;
  const schema = await schemaSnapshot(client);
  const identity = (await client.query('SELECT current_database() AS database')).rows[0];
  requireSafe(
    identity.database === target.omnicus.database,
    'Connected PostgreSQL database mismatch.',
  );
  const project = (
    await client.query('SELECT id, name, status FROM public.projects WHERE id=$1', [projectId])
  ).rows[0];
  requireSafe(project?.name === target.omnicus.projectName, 'Omnicus project ID/name mismatch.');
  requireSafe(
    project.status === 'PAUSED',
    'Pause the selected Omnicus project before preparing the cleanup plan.',
  );

  const rows = {};
  let bytes = 0;
  for (const table of new Set([...DELETE_TABLES, ...CONFIG_TABLES])) {
    const result = await client.query(
      `SELECT row_to_json(t)::text AS document FROM ${quote(table)} t WHERE "projectId"=$1 LIMIT $2`,
      [projectId, MAX_ROWS + 1],
    );
    requireSafe(
      result.rows.length <= MAX_ROWS,
      `Too many rows in ${table}; use a reviewed large-dataset procedure.`,
    );
    rows[table] = result.rows.map((row) => row.document).sort();
    bytes += rows[table].reduce((size, row) => size + Buffer.byteLength(row), 0);
    requireSafe(bytes <= MAX_BYTES, 'Snapshot exceeds 100 MiB. No deletion attempted.');
  }
  const configs = rows.crm_project_configs.map(JSON.parse);
  requireSafe(
    configs.length === 1,
    'Exactly one CRM pairing must exist for the selected Omnicus project.',
  );
  const pairing = configs[0];
  requireSafe(
    pairing.crmProjectId === target.crm.crmProjectId &&
      pairing.baseUrl?.replace(/\/$/, '') === target.crm.baseUrl.replace(/\/$/, ''),
    'Omnicus pairing does not point to the pinned staging CRM.',
  );
  requireSafe(
    pairing.enabled === false,
    'Disable CRM synchronization for this Omnicus project first.',
  );
  for (const table of ['broadcasts', 'email_campaigns']) {
    requireSafe(
      rows[table]
        .map(JSON.parse)
        .every((row) =>
          ['DRAFT', 'COMPLETED', 'CANCELLED', 'FAILED', 'ARCHIVED'].includes(row.status),
        ),
      `Cancel scheduled/running/paused ${table} before cleanup; definitions are retained.`,
    );
  }
  return { schema, identity, project, rows };
}

export function selectDeletion(state) {
  const selected = Object.fromEntries(DELETE_TABLES.map((table) => [table, state.rows[table]]));
  const botOutbox = new Set(
    state.rows.telegram_bot_interfaces.map((row) => JSON.parse(row).outboxRecordId).filter(Boolean),
  );
  selected.outbox_records = selected.outbox_records.filter(
    (row) => !botOutbox.has(JSON.parse(row).id),
  );
  selected.email_asset_references = selected.email_asset_references.filter(
    (row) => JSON.parse(row).ownerType === 'EMAIL_DELIVERY',
  );

  // JSON references in immutable scenario/template/broadcast content matter too;
  // checking only Prisma foreign keys would break retained content.
  const retainedContent = [
    ...CONFIG_TABLES.flatMap((table) => state.rows[table]),
    ...state.rows.email_asset_references.filter(
      (row) => JSON.parse(row).ownerType !== 'EMAIL_DELIVERY',
    ),
    ...state.rows.outbox_records.filter((row) => botOutbox.has(JSON.parse(row).id)),
  ].join('\n');
  // A library-upload audit/idempotency row is not evidence that its file
  // belongs to a contact. Only actual delivery/conversation references count.
  const contactContent = [
    'messages',
    'telegram_media_group_items',
    'email_deliveries',
    'email_asset_references',
    'scheduled_messages',
    'outbox_records',
  ]
    .flatMap((table) => selected[table])
    .join('\n');
  const relatedAssets = state.rows.media_assets.filter((row) => {
    const asset = JSON.parse(row);
    return ['TELEGRAM', 'WHATSAPP'].includes(asset.source) || contactContent.includes(asset.id);
  });
  selected.media_assets = relatedAssets.filter(
    (row) => !retainedContent.includes(JSON.parse(row).id),
  );
  const deletedAssets = new Set(selected.media_assets.map((row) => JSON.parse(row).id));
  const retainedFiles = relatedAssets
    .map(JSON.parse)
    .filter((asset) => asset.bucketKey)
    .map((asset) => ({
      assetId: asset.id,
      bucketKey: asset.bucketKey,
      sharedWithRetainedContent: !deletedAssets.has(asset.id),
      action: 'RETAIN_OBJECT_PENDING_SEPARATE_STORAGE_REVIEW',
    }))
    .sort((a, b) => a.assetId.localeCompare(b.assetId));
  const updateCounts = Object.fromEntries(
    ['broadcasts', 'email_campaigns'].map((table) => [
      table,
      state.rows[table]
        .map(JSON.parse)
        .filter(
          (row) =>
            Object.hasOwn(row.audience ?? {}, 'contactIds') &&
            JSON.stringify(row.audience.contactIds) !== '[]',
        ).length,
    ]),
  );
  return { selected, retainedFiles, updateCounts };
}

export function postgresPlan(state) {
  const { selected, retainedFiles, updateCounts } = selectDeletion(state);
  return {
    dataHash: digest(state),
    deleteCounts: Object.fromEntries(DELETE_TABLES.map((table) => [table, selected[table].length])),
    updateCounts,
    retainedFiles,
    warnings: [
      'Project audit history and test email suppressions are deleted.',
      'Shared media and bucket objects are retained.',
      'No provider, Redis, configuration, user or other-project cleanup is performed.',
    ],
  };
}

export async function deleteProjectData(client, target, state) {
  const projectId = target.omnicus.projectId;
  const { selected, updateCounts } = selectDeletion(state);
  const counts = {};
  // Scope every statement, including partial tables and redundant cascade children.
  for (const table of DELETE_TABLES) {
    let extra = '';
    const params = [projectId];
    if (['email_asset_references', 'outbox_records', 'media_assets'].includes(table)) {
      extra = ' AND id=ANY($2::text[])';
      params.push(selected[table].map((row) => JSON.parse(row).id));
    }
    const result = await client.query(
      `DELETE FROM ${quote(table)} WHERE "projectId"=$1${extra}`,
      params,
    );
    requireSafe(
      result.rowCount === selected[table].length,
      `Delete count mismatch in ${table}; transaction must roll back.`,
    );
    counts[table] = result.rowCount;
  }
  for (const table of ['broadcasts', 'email_campaigns']) {
    const result = await client.query(
      `UPDATE ${quote(table)} SET audience=jsonb_set(audience, '{contactIds}', '[]'::jsonb), "updatedAt"=now()
      WHERE "projectId"=$1 AND audience ? 'contactIds' AND audience->'contactIds' <> '[]'::jsonb`,
      [projectId],
    );
    requireSafe(
      result.rowCount === updateCounts[table],
      `Update count mismatch in ${table}; transaction must roll back.`,
    );
  }
  const remaining = postgresPlan(await readState(client, target));
  requireSafe(
    Object.values(remaining.deleteCounts).every((count) => count === 0),
    'Post-delete verification failed; transaction must roll back.',
  );
  requireSafe(
    Object.values(remaining.updateCounts).every((count) => count === 0),
    'Audience reference cleanup failed.',
  );
  return counts;
}
