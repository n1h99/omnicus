import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

it('enforces project ownership and one connection per project in disposable PostgreSQL', async () => {
  const db = new PGlite(); // Never reads DATABASE_URL or touches an existing database.
  try {
    await db.exec(
      "CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('a'), ('b');",
    );
    await db.exec(
      await readFile(
        resolve('prisma/migrations/20261102100000_webinar_stars_connection/migration.sql'),
        'utf8',
      ),
    );
    const insert =
      'INSERT INTO webinar_connections (id,"projectId","tokenEncrypted","updatedAt") VALUES ($1,$2,$3,NOW())';
    await db.query(insert, ['first', 'a', '{}']);
    await expect(db.query(insert, ['second', 'a', '{}'])).rejects.toThrow(/unique/i);
    await expect(db.query(insert, ['foreign', 'missing', '{}'])).rejects.toThrow(/foreign key/i);
    expect((await db.query('SELECT revision,"verifiedAt" FROM webinar_connections')).rows).toEqual([
      { revision: 1, verifiedAt: null },
    ]);
    await expect(db.query("DELETE FROM projects WHERE id='a'")).rejects.toThrow(/foreign key/i);
    await db.query('DELETE FROM webinar_connections WHERE "projectId"=\'b\'');
    expect((await db.query('SELECT id FROM webinar_connections')).rows).toHaveLength(1);
  } finally {
    await db.close();
  }
}, 60_000);
