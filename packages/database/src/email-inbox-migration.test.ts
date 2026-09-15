import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

describe('Email inbox PostgreSQL migration', () => {
  it('applies every real migration and enforces tenant, thread, sender and replay constraints', async () => {
    const db = new PGlite(); // Disposable in-memory PostgreSQL. Never reads DATABASE_URL.
    try {
      const root = resolve('prisma/migrations');
      for (const folder of (await readdir(root)).sort().filter((name) => /^\d/.test(name)))
        await db.exec(await readFile(resolve(root, folder, 'migration.sql'), 'utf8'));
      let serial = 0;
      async function insert(table: string, overrides: Record<string, unknown> = {}) {
        const columns = await db.query<{
          column_name: string;
          is_nullable: string;
          column_default: string | null;
          data_type: string;
          udt_name: string;
        }>(
          "SELECT column_name,is_nullable,column_default,data_type,udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
          [table],
        );
        const row: Record<string, unknown> = { ...overrides };
        for (const column of columns.rows) {
          if (
            Object.hasOwn(row, column.column_name) ||
            column.is_nullable === 'YES' ||
            column.column_default !== null
          )
            continue;
          let value: unknown = `${table}-${++serial}`;
          if (column.data_type.includes('timestamp')) value = '2026-09-15T00:00:00Z';
          else if (column.data_type === 'boolean') value = false;
          else if (['integer', 'bigint', 'numeric'].includes(column.data_type)) value = 1;
          else if (column.data_type === 'jsonb') value = '{}';
          else if (column.data_type === 'USER-DEFINED')
            value = (
              await db.query<{ enumlabel: string }>(
                'SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_type.oid=enumtypid WHERE typname=$1 ORDER BY enumsortorder LIMIT 1',
                [column.udt_name],
              )
            ).rows[0]!.enumlabel;
          row[column.column_name] = value;
        }
        const keys = Object.keys(row);
        await db.query(
          `INSERT INTO "${table}" (${keys.map((key) => '"' + key + '"').join(',')}) VALUES (${keys.map((_, index) => '$' + (index + 1)).join(',')})`,
          keys.map((key) => row[key]),
        );
        return row;
      }
      await insert('projects', { id: 'p1', slug: 'p1' });
      await insert('projects', { id: 'p2', slug: 'p2' });
      await insert('email_domains', {
        id: 'd1',
        projectId: 'p1',
        name: 'example.com',
        providerDomainId: 'provider1',
      });
      await expect(
        insert('email_domains', {
          projectId: 'p2',
          name: 'example.com',
          providerDomainId: 'provider2',
        }),
      ).rejects.toThrow();
      await insert('email_mailboxes', {
        id: 'm1',
        projectId: 'p1',
        domainId: 'd1',
        address: 'sales@example.com',
        isDefault: true,
      });
      await expect(
        insert('email_mailboxes', {
          id: 'cross',
          projectId: 'p2',
          domainId: 'd1',
          address: 'bad@example.com',
        }),
      ).rejects.toThrow();
      await expect(
        insert('email_mailboxes', {
          id: 'default2',
          projectId: 'p1',
          domainId: 'd1',
          address: 'other@example.com',
          isDefault: true,
        }),
      ).rejects.toThrow();
      await expect(
        db.query('UPDATE email_mailboxes SET shared=false WHERE id=$1', ['m1']),
      ).rejects.toThrow();
      await insert('email_mailboxes', {
        id: 'm2',
        projectId: 'p1',
        domainId: 'd1',
        address: 'support@example.com',
      });
      await insert('email_threads', {
        id: 't1',
        projectId: 'p1',
        mailboxId: 'm1',
        replyToken: 'token1',
      });
      await insert('email_messages', {
        id: 'msg1',
        projectId: 'p1',
        mailboxId: 'm1',
        threadId: 't1',
        direction: 'INBOUND',
        providerEmailId: 'provider-msg',
      });
      await expect(
        insert('email_messages', {
          projectId: 'p1',
          mailboxId: 'm2',
          threadId: 't1',
          direction: 'INBOUND',
        }),
      ).rejects.toThrow();
      await expect(
        insert('email_messages', {
          projectId: 'p1',
          mailboxId: 'm1',
          threadId: 't1',
          direction: 'INBOUND',
          providerEmailId: 'provider-msg',
        }),
      ).rejects.toThrow();
      await insert('email_inbound_receipts', {
        id: 'receipt1',
        projectId: 'p1',
        mailboxId: 'm1',
        providerEmailId: 'received1',
      });
      await expect(
        insert('email_inbound_receipts', {
          projectId: 'p1',
          mailboxId: 'm1',
          providerEmailId: 'received1',
        }),
      ).rejects.toThrow();
      await expect(
        insert('email_attachments', { projectId: 'p2', messageId: 'msg1' }),
      ).rejects.toThrow();
      expect(
        (
          await db.query<{ code: string }>("SELECT code FROM permissions WHERE code LIKE 'email:%'")
        ).rows
          .map((row) => row.code)
          .sort(),
      ).toEqual(['email:manage', 'email:read', 'email:send']);
    } finally {
      await db.close();
    }
  }, 60_000);
});
