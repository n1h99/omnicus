import { DELETE_COLLECTIONS, PRESERVE_COLLECTIONS } from './mongo.mjs';

// Self-contained function: also serialized into the reviewed mongosh command.
// This is an explicitly non-atomic online test reset, NOT the offline CLI.
export async function resetConsoleCrm(database, env, EJSON, report, erase, keep) {
  class Guard extends Error {}
  const requireSafe = (ok, message) => {
    if (!ok) throw new Guard(message);
  };
  const snapshot = (rows) =>
    JSON.stringify(rows.map((row) => EJSON.stringify(row, { relaxed: false })).sort());
  let started = false;
  let bytes = 0;
  try {
    requireSafe(
      env.RAILWAY_PROJECT_ID === '6cdbfe80-35c4-429a-80a3-5bdd5bf89970' &&
        env.RAILWAY_ENVIRONMENT_ID === 'b562818c-0a1a-434f-9cbf-883f2a025f2a' &&
        env.RAILWAY_ENVIRONMENT_NAME === 'staging',
      'wrong Railway staging environment',
    );
    requireSafe(database.getName() === 'test', 'wrong Mongo database');
    const inventory = await database.getCollectionInfos();
    requireSafe(
      inventory.every(
        (entry) =>
          entry.type === 'collection' &&
          !entry.options?.capped &&
          [...erase, ...keep].includes(entry.name),
      ),
      'unreviewed Mongo collection',
    );
    const names = inventory.map((entry) => entry.name).sort();
    requireSafe(
      names.includes('leads') && names.includes('omnicusconnections'),
      'missing CRM collections',
    );
    requireSafe(
      (await database.getCollection('leads').countDocuments({})) === 92,
      'lead count changed; expected 92',
    );
    const links = await database.getCollection('omnicusconnections').find({}).limit(3).toArray();
    requireSafe(
      links.length === 1 &&
        links[0].status === 'DISABLED' &&
        links[0].crmProjectId === 'cyber-pulse-staging' &&
        links[0].omnicusProjectId === '5389d6fd-ad17-44d6-a430-a4e0c1cb6d3f',
      'disabled staging pairing mismatch',
    );
    const read = async (name) => {
      const rows = await database.getCollection(name).find({}).limit(20001).toArray();
      requireSafe(rows.length <= 20000, 'too many records in ' + name);
      return rows;
    };
    const saved = {},
      indexes = {};
    for (const name of names) {
      saved[name] = await read(name);
      bytes += Buffer.byteLength(snapshot(saved[name]));
      requireSafe(bytes <= 104857600, 'snapshot exceeds 100 MiB');
      indexes[name] = snapshot(await database.getCollection(name).getIndexes());
    }
    for (const name of [
      'omnicusoperations',
      'omnicuscontactlinks',
      'omnicusreactionevents',
      'omnicusconversationevents',
      'conversations',
    ]) {
      requireSafe(
        (saved[name] || []).every(
          (row) =>
            (!row.crmProjectId || row.crmProjectId === 'cyber-pulse-staging') &&
            (!row.omnicusProjectId ||
              row.omnicusProjectId === '5389d6fd-ad17-44d6-a430-a4e0c1cb6d3f'),
        ),
        'another CRM project found',
      );
    }
    for (const name of names)
      requireSafe(
        snapshot(await read(name)) === snapshot(saved[name]),
        'data changed before deletion: ' + name,
      );
    started = true;
    report('STAGING CRM RESET STARTED; NO AUTOMATIC ROLLBACK');
    for (const name of erase.filter((name) => names.includes(name))) {
      const collection = database.getCollection(name);
      const rows = saved[name];
      let deleted = 0;
      for (let offset = 0; offset < rows.length; offset += 500) {
        const batch = rows.slice(offset, offset + 500);
        const filter = { _id: { $in: batch.map((row) => row._id) } };
        requireSafe(
          snapshot(await collection.find(filter).toArray()) === snapshot(batch),
          'data changed during cleanup: ' + name,
        );
        const result = await collection.deleteMany(filter, { writeConcern: { w: 1, j: true } });
        requireSafe(
          result.acknowledged && result.deletedCount === batch.length,
          'delete count mismatch: ' + name,
        );
        deleted += result.deletedCount;
      }
      report(name + ': deleted ' + deleted);
    }
    const after = await database.getCollectionInfos();
    requireSafe(snapshot(after) === snapshot(inventory), 'collection inventory changed');
    for (const name of names) {
      requireSafe(
        snapshot(await database.getCollection(name).getIndexes()) === indexes[name],
        'indexes changed: ' + name,
      );
      if (keep.includes(name))
        requireSafe(
          snapshot(await read(name)) === snapshot(saved[name]),
          'preserved configuration changed: ' + name,
        );
      else
        requireSafe(
          (await database.getCollection(name).countDocuments({})) === 0,
          'records remain or reappeared: ' + name,
        );
    }
    report('CRM_STAGING_CLEANUP_VERIFIED | remaining_leads=0 | files_retained=true');
  } catch (error) {
    report(
      (started ? 'PARTIAL_CLEANUP_POSSIBLE; DO NOT RETRY: ' : 'STOP_BEFORE_DELETION: ') +
        (error instanceof Guard ? error.message : 'database error; inspect state and backup'),
    );
    throw error;
  }
}

export function mongoConsoleProgram() {
  return `(async () => {
const e = process.env;
if (e.RAILWAY_PROJECT_ID !== '6cdbfe80-35c4-429a-80a3-5bdd5bf89970' || e.RAILWAY_ENVIRONMENT_ID !== 'b562818c-0a1a-434f-9cbf-883f2a025f2a' || e.RAILWAY_ENVIRONMENT_NAME !== 'staging') throw Error('STOP: wrong staging environment');
const user = e.MONGO_INITDB_ROOT_USERNAME || e.MONGOUSER;
const password = e.MONGO_INITDB_ROOT_PASSWORD || e.MONGOPASSWORD;
if (!user || !password) throw Error('STOP: missing Mongo credentials');
await db.getSiblingDB('admin').auth(user, password);
await (${resetConsoleCrm.toString()})(db.getSiblingDB('test'), e, EJSON, print, ${JSON.stringify(DELETE_COLLECTIONS)}, ${JSON.stringify(PRESERVE_COLLECTIONS)}).catch(() => quit(1));
})().catch(() => { print('STOP: environment, connection or authentication failed'); quit(1); });`;
}
