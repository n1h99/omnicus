import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  DELETE_TABLES,
  PRESERVE_TABLES,
  deleteProjectData,
  postgresPlan,
  readState,
  schemaSnapshot,
} from '../postgres.mjs';
import { checkSnapshot, makePlan } from '../safety.mjs';
import { consoleResetSql } from '../postgres-console.mjs';

test('actual migrations: full project cleanup, rollback, FK ordering and other-project isolation', async () => {
  // In-memory WASM PostgreSQL only: no environment variables or external URI.
  const db = new PGlite();
  const client = {
    query: async (sql, params) => {
      const result = await db.query(sql, params);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  try {
    const migrations = new URL('../../../packages/database/prisma/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).sort()) {
      if (!/^\d/.test(name)) continue;
      await db.exec(await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8'));
    }
    await db.exec('CREATE TABLE public._prisma_migrations (id text PRIMARY KEY)');
    await schemaSnapshot(client);

    const database = (await db.query('SELECT current_database() AS name')).rows[0].name;
    const projectA = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const projectB = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
    const target = {
      omnicus: { projectId: projectA, projectName: 'Cleanup fixture', database },
      crm: { crmProjectId: 'crm-fixture', baseUrl: 'https://crm-staging.example.test' },
    };

    // Populate every required scalar from actual migrated columns; explicit
    // overrides below describe relationships, not an imitation of the schema.
    let sequence = 0;
    async function insert(table, overrides = {}) {
      const columns = (
        await db.query(
          `SELECT column_name, is_nullable, column_default, data_type, udt_name
        FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
          [table],
        )
      ).rows;
      const row = { ...overrides };
      for (const col of columns) {
        if (
          Object.hasOwn(row, col.column_name) ||
          col.is_nullable === 'YES' ||
          col.column_default !== null
        )
          continue;
        let value;
        if (col.data_type === 'USER-DEFINED') {
          value = (
            await db.query(
              'SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_type.oid=enumtypid WHERE typname=$1 ORDER BY enumsortorder LIMIT 1',
              [col.udt_name],
            )
          ).rows[0].enumlabel;
        } else if (col.data_type.includes('timestamp')) value = '2026-09-15T00:00:00Z';
        else if (col.data_type === 'boolean') value = false;
        else if (['integer', 'bigint', 'numeric'].includes(col.data_type)) value = 1;
        else if (col.data_type === 'jsonb') value = '{}';
        else value = `${table}-${col.column_name}-${++sequence}`;
        row[col.column_name] = value;
      }
      const keys = Object.keys(row);
      await db.query(
        `INSERT INTO public."${table}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(',')})`,
        keys.map((key) => row[key]),
      );
      return row;
    }

    async function seed(projectId, suffix) {
      const id = (name) => `${suffix}-${name}`;
      const add = (table, values = {}) => insert(table, { id: id(table), projectId, ...values });
      await insert('projects', {
        id: projectId,
        name: suffix === 'a' ? 'Cleanup fixture' : 'Untouched project',
        status: 'PAUSED',
        slug: suffix,
      });
      await add('crm_project_configs', {
        crmProjectId: suffix === 'a' ? 'crm-fixture' : 'crm-other',
        baseUrl: 'https://crm-staging.example.test',
        enabled: false,
      });
      await add('contacts', { email: `${suffix}@fixture.test` });
      await add('contacts', { id: id('merged-contact'), mergedIntoContactId: id('contacts') });
      await add('channel_connections');
      await add('channel_identities', {
        contactId: id('contacts'),
        connectionId: id('channel_connections'),
      });
      await add('raw_webhook_events', { connectionId: id('channel_connections') });
      await add('inbox_records', {
        connectionId: id('channel_connections'),
        rawWebhookEventId: id('raw_webhook_events'),
      });
      await add('normalized_events', {
        connectionId: id('channel_connections'),
        inboxRecordId: id('inbox_records'),
      });
      await add('conversations', {
        connectionId: id('channel_connections'),
        contactId: id('contacts'),
      });
      await add('media_assets', { source: 'TELEGRAM', bucketKey: `${projectId}/inbound.jpg` });
      await add('media_assets', {
        id: id('shared-asset'),
        source: 'TELEGRAM',
        bucketKey: `${projectId}/shared.jpg`,
      });
      await add('media_assets', {
        id: id('unrelated-upload'),
        source: 'USER_UPLOAD',
        bucketKey: `${projectId}/library.jpg`,
      });
      await add('messages', {
        contactId: id('contacts'),
        connectionId: id('channel_connections'),
        conversationId: id('conversations'),
        normalizedEventId: id('normalized_events'),
        mediaAssetId: id('media_assets'),
      });
      await add('message_status_events', {
        messageId: id('messages'),
        connectionId: id('channel_connections'),
        normalizedEventId: id('normalized_events'),
      });
      await add('outbox_records', { connectionId: id('channel_connections') });
      await add('outbox_records', {
        id: id('bot-outbox'),
        connectionId: id('channel_connections'),
      });
      await add('telegram_bot_interfaces', {
        connectionId: id('channel_connections'),
        outboxRecordId: id('bot-outbox'),
      });
      await add('scenarios');
      await add('scenario_versions', {
        scenarioId: id('scenarios'),
        graph: JSON.stringify({ assetId: id('shared-asset') }),
      });
      const execution = {
        scenarioId: id('scenarios'),
        scenarioVersionId: id('scenario_versions'),
        contactId: id('contacts'),
        conversationId: id('conversations'),
        triggerEventId: id('normalized_events'),
      };
      await add('scenario_executions', execution);
      await add('scenario_executions', {
        ...execution,
        id: id('child-execution'),
        parentExecutionId: id('scenario_executions'),
      });
      await add('node_executions', { scenarioExecutionId: id('scenario_executions') });
      for (const table of ['wait_states', 'delayed_actions'])
        await add(table, {
          scenarioExecutionId: id('scenario_executions'),
          scenarioId: id('scenarios'),
          scenarioVersionId: id('scenario_versions'),
          ...(table === 'wait_states' ? { conversationId: id('conversations') } : {}),
        });
      await add('external_http_operations', {
        scenarioExecutionId: id('scenario_executions'),
        outboxRecordId: id('outbox_records'),
      });
      await add('crm_operations', {
        contactId: id('contacts'),
        outboxRecordId: id('outbox_records'),
        messageId: id('messages'),
        normalizedEventId: id('normalized_events'),
      });
      await add('broadcasts', {
        connectionId: id('channel_connections'),
        status: 'CANCELLED',
        audience: JSON.stringify({ mode: 'CONTACTS', contactIds: [id('contacts')] }),
      });
      const recipient = {
        contactId: id('contacts'),
        channelIdentityId: id('channel_identities'),
        connectionId: id('channel_connections'),
        outboxRecordId: id('outbox_records'),
        messageId: id('messages'),
      };
      await add('broadcast_recipients', { ...recipient, broadcastId: id('broadcasts') });
      await add('scheduled_messages', recipient);
      await add('telegram_media_groups', {
        contactId: id('contacts'),
        channelIdentityId: id('channel_identities'),
        connectionId: id('channel_connections'),
        outboxRecordId: id('outbox_records'),
      });
      await add('telegram_media_group_items', {
        mediaGroupId: id('telegram_media_groups'),
        mediaAssetId: id('media_assets'),
      });
      await add('email_campaigns', {
        status: 'CANCELLED',
        audience: JSON.stringify({ mode: 'CONTACTS', contactIds: [id('contacts')] }),
      });
      await add('email_deliveries', {
        campaignId: id('email_campaigns'),
        contactId: id('contacts'),
      });
      await add('email_events', { deliveryId: id('email_deliveries') });
      await add('email_asset_references', {
        ownerType: 'EMAIL_DELIVERY',
        ownerId: id('email_deliveries'),
        mediaAssetId: id('media_assets'),
      });
      await add('email_suppressions');
      await add('lead_capture_events', { contactId: id('contacts') });
      await add('tracked_links', {
        contactId: id('contacts'),
        scenarioExecutionId: id('scenario_executions'),
      });
      await add('tracked_link_clicks', {
        contactId: id('contacts'),
        trackedLinkId: id('tracked_links'),
      });
      await add('tags');
      await insert('contact_tags', { projectId, contactId: id('contacts'), tagId: id('tags') });
      await add('custom_field_definitions');
      await add('contact_custom_field_values', {
        contactId: id('contacts'),
        definitionId: id('custom_field_definitions'),
      });
      await add('idempotency_records');
      await add('audit_logs', { entityType: 'Contact', entityId: id('contacts') });
      await add('audit_logs', {
        id: id('library-upload-audit'),
        entityType: 'MediaAsset',
        entityId: id('unrelated-upload'),
      });
    }
    await seed(projectA, 'a');
    await seed(projectB, 'b');
    const otherTarget = {
      omnicus: { ...target.omnicus, projectId: projectB, projectName: 'Untouched project' },
      crm: { ...target.crm, crmProjectId: 'crm-other' },
    };
    const otherBefore = await readState(client, otherTarget);
    const before = await readState(client, target);
    const plan = makePlan('omnicus', target, postgresPlan(before));
    assert.equal(plan.snapshot.deleteCounts.contacts, 2);
    assert.equal(plan.snapshot.deleteCounts.media_assets, 1);
    assert.equal(plan.snapshot.retainedFiles.length, 2);
    assert.equal(
      plan.snapshot.retainedFiles.filter((file) => file.sharedWithRetainedContent).length,
      1,
    );
    checkSnapshot(plan, postgresPlan(await readState(client, target)));

    await db.exec('BEGIN');
    await deleteProjectData(client, target, before);
    await db.exec('ROLLBACK');
    assert.deepEqual(await readState(client, target), before);

    // The online console path uses real restrictive/self-referential FKs too.
    // A non-disabled pairing and active jobs must abort before any deletion.
    const consoleSql = consoleResetSql(target, 2);
    await assert.rejects(db.exec(consoleSql), /disabled staging pairing/);
    await db.exec('ROLLBACK');
    await db.query('UPDATE crm_project_configs SET status=\'DISABLED\' WHERE "projectId"=$1', [
      projectA,
    ]);
    await assert.rejects(db.exec(consoleSql), /unfinished jobs/);
    await db.exec('ROLLBACK');
    for (const [table, status] of [
      ['inbox_records', 'COMPLETED'],
      ['outbox_records', 'UNKNOWN'],
      ['email_deliveries', 'FAILED'],
      ['scheduled_messages', 'FAILED'],
      ['telegram_media_groups', 'UNKNOWN'],
      ['scenario_executions', 'WAITING'],
      ['node_executions', 'SUCCEEDED'],
      ['delayed_actions', 'COMPLETED'],
    ])
      await db.query(`UPDATE public."${table}" SET status=$1 WHERE "projectId"=$2`, [
        status,
        projectA,
      ]);
    const quietBefore = await readState(client, target);
    // Exercise a late exception AFTER deletions to verify real rollback.
    await assert.rejects(
      db.exec(
        consoleSql.replace(
          'END\n$cleanup$;',
          "RAISE EXCEPTION 'injected late fixture failure';\nEND\n$cleanup$;",
        ),
      ),
      /injected late/,
    );
    await db.exec('ROLLBACK');
    assert.deepEqual(await readState(client, target), quietBefore);
    await db.exec(consoleSql.replace('COMMIT;', 'ROLLBACK;'));
    assert.deepEqual(await readState(client, target), quietBefore);
    await db.exec(consoleSql);
    assert.deepEqual(await readState(client, otherTarget), otherBefore);
    assert.deepEqual(
      postgresPlan(await readState(client, target)).deleteCounts,
      Object.fromEntries(DELETE_TABLES.map((table) => [table, 0])),
    );
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM media_assets WHERE "projectId"=$1', [projectA]))
        .rows[0].n,
      2,
    );
    assert.equal(
      (
        await db.query('SELECT count(*)::int n FROM outbox_records WHERE "projectId"=$1', [
          projectA,
        ])
      ).rows[0].n,
      1,
    );
    // Use the unchanged transactional helper on the now-empty selected scope.
    const cleared = await readState(client, target);

    await db.exec('BEGIN');
    // Mirror CLI locks and real restrictive/self-referential FK behavior.
    await db.exec(
      `LOCK TABLE ${[...DELETE_TABLES, ...PRESERVE_TABLES].map((name) => `public."${name}"`).join(',')} IN SHARE ROW EXCLUSIVE MODE`,
    );
    await deleteProjectData(client, target, cleared);
    await db.exec('COMMIT');
    assert.deepEqual(await readState(client, otherTarget), otherBefore);
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM contacts WHERE "projectId"=$1', [projectA]))
        .rows[0].n,
      0,
    );
    assert.equal(
      (
        await db.query('SELECT count(*)::int AS n FROM media_assets WHERE "projectId"=$1', [
          projectA,
        ])
      ).rows[0].n,
      2,
    );
    assert.equal(
      (
        await db.query('SELECT count(*)::int AS n FROM outbox_records WHERE "projectId"=$1', [
          projectA,
        ])
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await db.query('SELECT count(*)::int AS n FROM scenario_versions WHERE "projectId"=$1', [
          projectA,
        ])
      ).rows[0].n,
      1,
    );
    await db.exec('CREATE TABLE unreviewed_contacts (id text)');
    await assert.rejects(schemaSnapshot(client), /inventory/);
  } finally {
    await db.close();
  }
});
