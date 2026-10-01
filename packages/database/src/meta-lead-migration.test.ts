import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

describe('Meta lead PostgreSQL migration (disposable memory only)', () => {
  it('enforces project boundaries, source uniqueness, safe defaults and transactional cursor rollback', async () => {
    const db = new PGlite(); // Never reads DATABASE_URL or connects to an installed server.
    try {
      await db.exec(
        "CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('a'), ('b');",
      );
      const sql = await readFile(
        resolve('prisma/migrations/20261001100000_meta_lead_intake/migration.sql'),
        'utf8',
      );
      expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|TYPE)\b/i);
      await db.exec(sql);
      await db.query(
        'INSERT INTO meta_lead_configs (id,"projectId","pageId","formIds","credentialsEncrypted","updatedAt") VALUES ($1,$2,$3,$4,$5,NOW())',
        ['cfg', 'a', '333', ['222'], '{}'],
      );
      const config = await db.query<{ enabled: boolean; deliveryEnabled: boolean }>(
        'SELECT enabled,"deliveryEnabled" FROM meta_lead_configs',
      );
      expect(config.rows).toEqual([{ enabled: false, deliveryEnabled: false }]);
      const insert =
        'INSERT INTO meta_lead_submissions (id,"projectId","configId","pageId","formId","leadId","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,NOW())';
      await db.query(insert, ['one', 'a', 'cfg', '333', '222', '111']);
      await expect(db.query(insert, ['cross', 'b', 'cfg', '333', '222', '444'])).rejects.toThrow(
        /foreign key/i,
      );
      await expect(
        db.query(insert, ['duplicate', 'a', 'cfg', '333', '222', '111']),
      ).rejects.toThrow(/unique/i);
      // Webhook + polling use ON CONFLICT suppression on the same permanent identity.
      await db.query(`${insert} ON CONFLICT DO NOTHING`, [
        'poll-copy',
        'a',
        'cfg',
        '333',
        '222',
        '111',
      ]);
      expect(
        (
          await db.query<{ count: number }>(
            'SELECT COUNT(*)::int AS count FROM meta_lead_submissions',
          )
        ).rows[0]!.count,
      ).toBe(1);
      await db.query(
        'INSERT INTO meta_lead_polls (id,"projectId","configId","formId","from") VALUES ($1,$2,$3,$4,NOW())',
        ['poll', 'a', 'cfg', '222'],
      );
      await expect(
        db.transaction(async (tx) => {
          await tx.query('UPDATE meta_lead_polls SET cursor=$1 WHERE id=$2', ['next-page', 'poll']);
          await tx.query(insert, ['bad-route', 'b', 'cfg', '333', '222', '555']);
        }),
      ).rejects.toThrow();
      expect(
        (await db.query<{ cursor: string | null }>('SELECT cursor FROM meta_lead_polls')).rows[0]!
          .cursor,
      ).toBeNull();
      await expect(db.query('DELETE FROM projects WHERE id=$1', ['a'])).rejects.toThrow(
        /foreign key/i,
      );
    } finally {
      await db.close();
    }
  }, 60_000);
});
