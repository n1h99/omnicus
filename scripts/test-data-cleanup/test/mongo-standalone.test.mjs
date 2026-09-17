import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { BSON, MongoClient } from 'mongodb';
import { main } from '../crm-staging.mjs';
import { main as omnicusMain } from '../omnicus.mjs';
import { DELETE_COLLECTIONS, PRESERVE_COLLECTIONS } from '../mongo.mjs';
import { deleteStandalone, standaloneSnapshot } from '../mongo-standalone.mjs';
import { confirmation, hash, writeNewJson } from '../safety.mjs';

async function fixture(run) {
  // Always a fresh localhost server; no Railway/application credentials are read.
  const server = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  const client = new MongoClient(server.getUri());
  try {
    await client.connect();
    const db = client.db('standalone_staging_fixture');
    const uri = server.getUri(db.databaseName);
    const target = {
      purpose: 'ERASE_TEST_CONTACTS_AND_STAGING_LEADS',
      crm: {
        environmentName: 'staging',
        railwayProjectId: 'crm-fixture',
        railwayEnvironmentId: 'staging-fixture',
        railwayServiceId: 'db-fixture',
        hosts: [new URL(uri).host],
        database: db.databaseName,
        baseUrl: 'https://crm-staging.example.test',
        crmProjectId: 'pairing-fixture',
      },
      omnicus: {
        railwayProjectId: 'omni-fixture',
        railwayEnvironmentId: 'omni-fixture',
        railwayServiceId: 'api-fixture',
        host: '127.0.0.1:1',
        database: 'omni-fixture',
        projectId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        projectName: 'Fixture',
      },
    };
    for (const name of DELETE_COLLECTIONS) {
      await db.collection(name).insertOne({ marker: `delete-${name}` });
      await db.collection(name).createIndex({ marker: 1 });
    }
    for (const name of PRESERVE_COLLECTIONS)
      await db.collection(name).insertOne(
        name === 'omnicusconnections'
          ? {
              crmProjectId: target.crm.crmProjectId,
              omnicusProjectId: target.omnicus.projectId,
              status: 'DISABLED',
            }
          : { marker: `keep-${name}` },
      );
    const other = client.db('untouched_fixture');
    await other.collection('leads').insertOne({ marker: 'must survive' });
    await run({ db, target, uri, other });
  } finally {
    await client.close();
    await server.stop();
  }
}

test('standalone CLI: explicit opt-in, unchanged backup guards, verified deletion, preserved data/indexes', async () => {
  await fixture(async ({ db, target, uri, other }) => {
    const directory = await mkdtemp(join(tmpdir(), 'cleanup-standalone-test-'));
    const targetPath = join(directory, 'target.local.json');
    const planPath = join(directory, 'crm.plan.json');
    await writeNewJson(targetPath, target);
    const environment = {
      RAILWAY_PROJECT_ID: target.crm.railwayProjectId,
      RAILWAY_ENVIRONMENT_ID: target.crm.railwayEnvironmentId,
      RAILWAY_SERVICE_ID: target.crm.railwayServiceId,
      RAILWAY_ENVIRONMENT_NAME: 'staging',
      CLEANUP_CRM_STAGING_URI: uri,
    };
    const args = ['--target', targetPath, '--plan', planPath];
    await assert.rejects(main(args, environment), /offline-standalone/);
    await assert.rejects(main([...args, '--offline-standalone'], environment), /stopped writers/);
    await assert.rejects(omnicusMain(['--offline-standalone']), /only for staging/);
    const offlineArgs = [...args, '--offline-standalone', '--writers-stopped'];
    await assert.rejects(
      main(offlineArgs, { ...environment, RAILWAY_ENVIRONMENT_NAME: 'production' }),
      /staging/,
    );
    await main(offlineArgs, environment);
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    assert.equal(plan.snapshot.executionMode, 'OFFLINE_STANDALONE_NO_ROLLBACK');
    assert.equal(await db.collection('leads').countDocuments(), 1);
    await assert.rejects(
      main([...offlineArgs, '--apply', '--confirm', confirmation(plan)], environment),
      /backup/,
    );
    const before = await standaloneSnapshot(db, target, BSON.EJSON);
    // This is only a synthetic file to exercise CLI checksum guards against the
    // disposable fixture, NOT evidence of a real operator restore test.
    const backupPath = join(directory, 'synthetic.archive');
    await writeFile(backupPath, 'isolated test fixture');
    const applyArgs = [
      ...offlineArgs,
      '--apply',
      '--confirm',
      confirmation(plan),
      '--backup',
      backupPath,
      '--backup-sha256',
      hash('isolated test fixture'),
      '--restore-tested',
      '--accept-retained-files',
    ];
    await main(applyArgs, environment);
    const receipt = JSON.parse(await readFile(`${planPath}.receipt.json`, 'utf8'));
    assert.equal(receipt.status, 'STANDALONE_VERIFIED_FILES_RETAINED');
    for (const name of DELETE_COLLECTIONS)
      assert.equal(await db.collection(name).countDocuments(), 0, name);
    assert.equal(
      (await standaloneSnapshot(db, target, BSON.EJSON)).snapshot.preservedHash,
      before.snapshot.preservedHash,
    );
    assert.equal(await other.collection('leads').countDocuments(), 1);
    await assert.rejects(main(applyArgs, environment)); // receipt prevents a blind replay
  });
});

test('standalone refuses equal-count drift before deleting, including preserved configuration', async () => {
  await fixture(async ({ db, target }) => {
    const before = await standaloneSnapshot(db, target, BSON.EJSON);
    await db.collection('leads').updateOne({}, { $set: { marker: 'changed' } });
    await assert.rejects(deleteStandalone(db, target, BSON.EJSON, before), /changed/);
    assert.equal(await db.collection(DELETE_COLLECTIONS[0]).countDocuments(), 1);
    const changed = await standaloneSnapshot(db, target, BSON.EJSON);
    await db.collection('users').updateOne({}, { $set: { marker: 'changed user' } });
    await assert.rejects(deleteStandalone(db, target, BSON.EJSON, changed), /changed/);
    assert.equal(await db.collection('leads').countDocuments(), 1);
  });
});

test('standalone partial failure is not rolled back or retried and never deletes the other database', async () => {
  await fixture(async ({ db, target, other }) => {
    const before = await standaloneSnapshot(db, target, BSON.EJSON);
    let attempts = 0;
    const failingDb = new Proxy(db, {
      get(object, key) {
        if (key !== 'collection') {
          const value = Reflect.get(object, key);
          return typeof value === 'function' ? value.bind(object) : value;
        }
        return (name) => {
          const collection = object.collection(name);
          if (name !== DELETE_COLLECTIONS[1]) return collection;
          return new Proxy(collection, {
            get(c, property) {
              if (property === 'deleteMany')
                return () => {
                  attempts++;
                  throw Error('injected fixture failure');
                };
              const value = Reflect.get(c, property);
              return typeof value === 'function' ? value.bind(c) : value;
            },
          });
        };
      },
    });
    await assert.rejects(
      deleteStandalone(failingDb, target, BSON.EJSON, before),
      /injected fixture/,
    );
    assert.equal(attempts, 1);
    assert.equal(await db.collection(DELETE_COLLECTIONS[0]).countDocuments(), 0);
    assert.equal(await db.collection(DELETE_COLLECTIONS[1]).countDocuments(), 1);
    assert.equal(await db.collection('leads').countDocuments(), 1);
    assert.equal(await other.collection('leads').countDocuments(), 1);
  });
});
