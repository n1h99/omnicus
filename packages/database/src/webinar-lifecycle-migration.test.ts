import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
it('enforces webhook/intent deduplication and project boundaries across the complete migration history', async () => {
  const db = new PGlite();
  try {
    const root = resolve('prisma/migrations');
    for (const folder of (await readdir(root)).sort().filter((x) => /^\d/.test(x)))
      await db.exec(await readFile(resolve(root, folder, 'migration.sql'), 'utf8'));
    await db.exec(`INSERT INTO projects (id,name,slug,status,timezone,locale,settings,"updatedAt") VALUES ('a','a','a','ACTIVE','Asia/Baku','en','{}',NOW()),('b','b','b','ACTIVE','Asia/Baku','en','{}',NOW());
      INSERT INTO contacts (id,"projectId","displayName","updatedAt") VALUES ('contact-a','a','A',NOW()),('contact-b','b','B',NOW());
      INSERT INTO webinar_connections (id,"projectId","tokenEncrypted","updatedAt") VALUES ('conn-a','a','{}',NOW()),('conn-b','b','{}',NOW());
      INSERT INTO webinar_events (id,"projectId","connectionId","providerWebinarId",title,"roomUrl",timezone,"scheduledAt","endsAt","updatedAt") VALUES ('event-a','a','conn-a','123','Test','https://efir.webinar-stars.com/webinar/abc/','Asia/Baku',NOW(),NOW()+INTERVAL '1 hour',NOW());
      INSERT INTO webinar_report_imports (id,"projectId","connectionId","externalReportId","updatedAt") VALUES ('import-a','a','conn-a','456',NOW());`);
    const invitation =
      'INSERT INTO webinar_invitations (id,"projectId","eventId","contactId",token) VALUES ($1,$2,$3,$4,$5)';
    await expect(
      db.query(invitation, ['wrong', 'a', 'event-a', 'contact-b', 'opaque-1']),
    ).rejects.toThrow(/foreign key/i);
    await db.query(invitation, ['invite-a', 'a', 'event-a', 'contact-a', 'opaque-1']);
    await expect(
      db.query(invitation, ['duplicate', 'a', 'event-a', 'contact-a', 'opaque-2']),
    ).rejects.toThrow(/unique/i);
    const receipt =
      'INSERT INTO webinar_webhook_receipts (id,"projectId","connectionId",fingerprint,metadata) VALUES ($1,$2,$3,$4,$5)';
    await db.query(receipt, ['receipt-a', 'a', 'conn-a', 'same-body', '{}']);
    await expect(
      db.query(receipt, ['receipt-b', 'a', 'conn-a', 'same-body', '{}']),
    ).rejects.toThrow(/unique/i);
    const action =
      'INSERT INTO webinar_actions (id,"projectId","contactId",kind,"eventType","dedupeKey",payload,"updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())';
    await db.query(action, [
      'action-a',
      'a',
      'contact-a',
      'AUTOMATION',
      'WEBINAR_ATTENDED',
      'same-event',
      '{}',
    ]);
    await expect(
      db.query(action, [
        'action-b',
        'a',
        'contact-a',
        'AUTOMATION',
        'WEBINAR_ATTENDED',
        'same-event',
        '{}',
      ]),
    ).rejects.toThrow(/unique/i);
    await expect(
      db.transaction(async (tx) => {
        await tx.query(
          'INSERT INTO webinar_attendances (id,"projectId","importId","identityKey",result,fingerprint,"updatedAt") VALUES ($1,$2,$3,$4,$5,$6,NOW())',
          ['attendance-a', 'a', 'import-a', 'identity', '{}', 'hash'],
        );
        await tx.query(action, [
          'bad-action',
          'a',
          'contact-b',
          'AUTOMATION',
          'WEBINAR_ATTENDED',
          'different-event',
          '{}',
        ]);
      }),
    ).rejects.toThrow(/foreign key/i);
    expect((await db.query('SELECT id FROM webinar_attendances')).rows).toHaveLength(0);
    await db.exec(
      `UPDATE webinar_connections SET "tokenEncrypted"=NULL,connected=false,enabled=false WHERE id='conn-a'`,
    );
    expect((await db.query('SELECT id FROM webinar_report_imports')).rows).toHaveLength(1);
    await expect(db.exec(`DELETE FROM webinar_connections WHERE id='conn-a'`)).rejects.toThrow(
      /foreign key/i,
    );
  } finally {
    await db.close();
  }
}, 60000);
