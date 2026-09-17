import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { BSON, MongoClient } from 'mongodb';
import { DELETE_COLLECTIONS, PRESERVE_COLLECTIONS } from '../mongo.mjs';
import { mongoConsoleProgram, resetConsoleCrm } from '../mongo-console.mjs';

test('mongosh eval payload parses as a script without top-level await and rejects wrong environment', async () => {
  const script = new Script(mongoConsoleProgram());
  const lines = [];
  const exits = [];
  await script.runInNewContext({
    process: { env: { RAILWAY_ENVIRONMENT_NAME: 'production' } },
    print: (line) => lines.push(line),
    quit: (code) => exits.push(code),
  });
  assert.deepEqual(exits, [1]);
  assert.match(lines[0], /STOP/);
});

test('online CRM console: pins, disabled pairing, full reset, preserved configuration/indexes/other DB', async () => {
  const server = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  const client = new MongoClient(server.getUri());
  try {
    await client.connect();
    const db = client.db('test');
    const other = client.db('untouched_fixture');
    await other.collection('leads').insertOne({ marker: 'keep' });
    for (const name of DELETE_COLLECTIONS) {
      await db
        .collection(name)
        .insertMany(Array.from({ length: name === 'leads' ? 92 : 2 }, (_, i) => ({ marker: i })));
      await db.collection(name).createIndex({ marker: 1 });
    }
    for (const name of PRESERVE_COLLECTIONS)
      await db.collection(name).insertOne(
        name === 'omnicusconnections'
          ? {
              crmProjectId: 'cyber-pulse-staging',
              omnicusProjectId: '5389d6fd-ad17-44d6-a430-a4e0c1cb6d3f',
              status: 'ACTIVE',
            }
          : { marker: 'keep' },
      );
    const adapter = {
      getName: () => db.databaseName,
      getCollectionInfos: () => db.listCollections({}, { nameOnly: false }).toArray(),
      getCollection: (name) => {
        const collection = db.collection(name);
        return {
          find: (query) => collection.find(query),
          countDocuments: (query) => collection.countDocuments(query),
          deleteMany: (query, options) => collection.deleteMany(query, options),
          getIndexes: () => collection.indexes(),
        };
      },
    };
    const env = {
      RAILWAY_PROJECT_ID: '6cdbfe80-35c4-429a-80a3-5bdd5bf89970',
      RAILWAY_ENVIRONMENT_ID: 'b562818c-0a1a-434f-9cbf-883f2a025f2a',
      RAILWAY_ENVIRONMENT_NAME: 'staging',
    };
    const logs = [];
    const run = (d = adapter, e = env) =>
      resetConsoleCrm(
        d,
        e,
        BSON.EJSON,
        (line) => logs.push(line),
        DELETE_COLLECTIONS,
        PRESERVE_COLLECTIONS,
      );
    await assert.rejects(
      run(adapter, { ...env, RAILWAY_ENVIRONMENT_NAME: 'production' }),
      /environment/,
    );
    await assert.rejects(run({ ...adapter, getName: () => 'production_fixture' }), /database/);
    await assert.rejects(run(), /pairing/);
    assert.equal(await db.collection('leads').countDocuments(), 92);
    await db.collection('omnicusconnections').updateOne({}, { $set: { status: 'DISABLED' } });
    // Same-count drift in the second snapshot must stop before deleting.
    let reads = 0;
    const drifting = {
      ...adapter,
      getCollection: (name) => {
        const c = adapter.getCollection(name);
        if (name !== 'leads') return c;
        const find = c.find;
        c.find = (...args) => {
          const cursor = find(...args);
          const toArray = cursor.toArray.bind(cursor);
          cursor.toArray = async () => {
            if (++reads === 2)
              await db.collection('leads').updateOne({}, { $set: { marker: 'changed' } });
            return toArray();
          };
          return cursor;
        };
        return c;
      },
    };
    await assert.rejects(run(drifting), /changed before deletion/);
    assert.equal(await db.collection(DELETE_COLLECTIONS[0]).countDocuments(), 2);
    const firstRows = await db.collection(DELETE_COLLECTIONS[0]).find({}).toArray();
    const failing = {
      ...adapter,
      getCollection: (name) => {
        const c = adapter.getCollection(name);
        if (name === DELETE_COLLECTIONS[1])
          c.deleteMany = async () => {
            throw new Error('fixture failure');
          };
        return c;
      },
    };
    await assert.rejects(run(failing), /fixture failure/);
    assert.match(logs.at(-1), /PARTIAL_CLEANUP_POSSIBLE; DO NOT RETRY/);
    assert.equal(await db.collection(DELETE_COLLECTIONS[0]).countDocuments(), 0);
    assert.equal(await db.collection(DELETE_COLLECTIONS[1]).countDocuments(), 2);
    await db.collection(DELETE_COLLECTIONS[0]).insertMany(firstRows);
    const preserved = {};
    for (const name of PRESERVE_COLLECTIONS)
      preserved[name] = await db.collection(name).find({}).toArray();
    const authCalls = [];
    const exits = [];
    await new Script(mongoConsoleProgram()).runInNewContext({
      process: {
        env: { ...env, MONGOUSER: 'fixture_user', MONGOPASSWORD: 'fixture_password' },
      },
      db: {
        getSiblingDB: (name) => {
          if (name === 'admin')
            return {
              auth: async (...args) => {
                authCalls.push(args);
              },
            };
          assert.equal(name, 'test');
          assert.equal(authCalls.length, 1);
          return adapter;
        },
      },
      EJSON: BSON.EJSON,
      Buffer,
      print: (line) => logs.push(line),
      quit: (code) => exits.push(code),
    });
    assert.deepEqual(authCalls, [['fixture_user', 'fixture_password']]);
    assert.deepEqual(exits, []);
    for (const name of DELETE_COLLECTIONS) {
      assert.equal(await db.collection(name).countDocuments(), 0, name);
      assert.equal((await db.collection(name).indexes()).length, 2);
    }
    for (const name of PRESERVE_COLLECTIONS)
      assert.deepEqual(await db.collection(name).find({}).toArray(), preserved[name]);
    assert.equal(await other.collection('leads').countDocuments(), 1);
    assert.match(logs.at(-1), /CRM_STAGING_CLEANUP_VERIFIED/);
    await assert.rejects(run(), /lead count changed/);
  } finally {
    await client.close();
    await server.stop();
  }
});
