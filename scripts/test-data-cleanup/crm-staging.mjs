import { pathToFileURL } from 'node:url';
import {
  checkApply,
  checkSnapshot,
  committed,
  databaseUri,
  help,
  makePlan,
  options,
  readTarget,
  reportError,
  requireSafe,
  summarize,
  validateEnvironment,
  writeNewJson,
} from './safety.mjs';
import { collectionInventory, deleteMongoData, mongoPlan, readMongoState } from './mongo.mjs';

export async function main(args, environment = process.env) {
  const opts = options(args);
  if (opts.help) return help('crm');
  const target = await readTarget(opts.target);
  validateEnvironment('crm', target, environment);
  const uri = databaseUri('crm', target, environment);
  requireSafe(opts.plan, '--plan is required.');
  const reviewed = opts.apply ? await checkApply(opts, 'crm', target) : null;
  const { MongoClient, BSON } = await import('mongodb');
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    appName: 'explicit-staging-lead-cleanup',
    maxPoolSize: 2,
  });
  let session;
  try {
    await client.connect();
    const db = client.db(target.crm.database);
    const hello = await db.command({ hello: 1 });
    requireSafe(
      Boolean(hello.setName),
      'Mongo replica set with transaction support is required. Standalone cleanup is intentionally forbidden.',
    );
    const inventory = await collectionInventory(db);
    session = client.startSession();
    // No automatic withTransaction retry: do not silently replay a destructive
    // transaction after uncertain outcomes or a changed snapshot.
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      maxCommitTimeMS: 15_000,
    });
    const state = await readMongoState(db, session, target, inventory, BSON.EJSON);
    const snapshot = mongoPlan(state, BSON.EJSON);
    if (!opts.apply) {
      const plan = makePlan('crm', target, snapshot);
      await session.abortTransaction();
      await writeNewJson(opts.plan, plan);
      summarize(plan);
      return;
    }
    checkSnapshot(reviewed, snapshot);
    const counts = await deleteMongoData(db, session, state);
    await session.commitTransaction();
    // A Mongo snapshot cannot lock an entire database against new inserts;
    // writers must remain stopped. Check again outside the transaction.
    for (const name of Object.keys(counts)) {
      if (inventory.some((entry) => entry.name === name))
        requireSafe(
          (await db.collection(name).countDocuments({})) === 0,
          'Concurrent records appeared after commit. Keep services stopped and inspect; do not blindly rerun.',
        );
    }
    await committed(opts, reviewed, counts);
    console.log(
      'Pinned STAGING CRM lead data cleared. Only the explicitly pinned Mongo target was connected. Files retained; see receipt.',
    );
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction().catch(() => {});
    throw error;
  } finally {
    await session?.endSession();
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(reportError);
