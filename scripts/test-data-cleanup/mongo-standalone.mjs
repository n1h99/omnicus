import {
  checkSnapshot,
  committed,
  digest,
  makePlan,
  requireSafe,
  summarize,
  writeNewJson,
} from './safety.mjs';
import {
  collectionInventory,
  DELETE_COLLECTIONS,
  mongoPlan,
  PRESERVE_COLLECTIONS,
  readMongoState,
} from './mongo.mjs';

// No implicit fallback from the transactional runner. Writers must remain stopped
// for the entire two-system maintenance window. Hash checks detect drift, but do
// NOT provide locks or an atomic multi-collection rollback on standalone MongoDB.
export async function standaloneSnapshot(db, target, EJSON) {
  const inventory = await collectionInventory(db);
  const state = await readMongoState(db, undefined, target, inventory, EJSON);
  const preserved = {};
  const indexes = {};
  let bytes = 0;
  for (const { name } of inventory) {
    indexes[name] = (await db.collection(name).indexes())
      .map((index) => EJSON.stringify(index, { relaxed: false }))
      .sort();
    if (PRESERVE_COLLECTIONS.includes(name)) {
      const rows = await db.collection(name).find({}).limit(20_001).toArray();
      requireSafe(
        rows.length <= 20_000,
        'Too many preserved Mongo records; separate review required.',
      );
      preserved[name] = rows.map((row) => EJSON.stringify(row, { relaxed: false })).sort();
      bytes += Buffer.byteLength(JSON.stringify(preserved[name]));
      requireSafe(bytes <= 100 * 1024 * 1024, 'Preserved Mongo snapshot exceeds 100 MiB.');
    }
  }
  return {
    state,
    snapshot: {
      ...mongoPlan(state, EJSON),
      executionMode: 'OFFLINE_STANDALONE_NO_ROLLBACK',
      preservedHash: digest({ preserved, indexes }),
    },
  };
}

export async function deleteStandalone(db, target, EJSON, before) {
  // Re-read the ENTIRE reviewed scope immediately before the first write.
  checkSnapshot(
    { snapshot: before.snapshot },
    (await standaloneSnapshot(db, target, EJSON)).snapshot,
  );
  const counts = {};
  for (const name of DELETE_COLLECTIONS) {
    const rows = before.state.rows[name];
    let deleted = 0;
    for (let offset = 0; offset < rows.length; offset += 500) {
      const batch = rows.slice(offset, offset + 500);
      const filter = { _id: { $in: batch.map((row) => row._id) } };
      const current = await db.collection(name).find(filter).toArray();
      const hashRows = (docs) =>
        digest(docs.map((doc) => EJSON.stringify(doc, { relaxed: false })).sort());
      requireSafe(
        hashRows(current) === hashRows(batch),
        'Standalone data changed before a batch. Earlier batches may already be deleted. Keep writers stopped; inspect, do not retry.',
      );
      const result = await db.collection(name).deleteMany(filter, {
        writeConcern: { w: 1, j: true, wtimeoutMS: 15_000 },
      });
      requireSafe(
        result.acknowledged && result.deletedCount === batch.length,
        'Standalone delete count mismatch. NO rollback; inspect database and backup before recovery.',
      );
      deleted += result.deletedCount;
    }
    counts[name] = deleted;
  }
  const after = await standaloneSnapshot(db, target, EJSON);
  requireSafe(
    Object.values(after.snapshot.deleteCounts).every((count) => count === 0),
    'Records remain after standalone cleanup. NO rollback; keep writers stopped and inspect.',
  );
  requireSafe(
    after.snapshot.preservedHash === before.snapshot.preservedHash &&
      digest(after.state.inventory) === digest(before.state.inventory),
    'Preserved Mongo configuration or indexes changed. Keep writers stopped and inspect.',
  );
  return counts;
}

export async function runStandalone(db, target, EJSON, opts, reviewed) {
  requireSafe(
    opts['offline-standalone'] && opts['writers-stopped'],
    'Explicit offline standalone mode and stopped writers are required.',
  );
  const before = await standaloneSnapshot(db, target, EJSON);
  if (!opts.apply) {
    checkSnapshot(
      { snapshot: before.snapshot },
      (await standaloneSnapshot(db, target, EJSON)).snapshot,
    );
    const plan = makePlan('crm', target, before.snapshot);
    await writeNewJson(opts.plan, plan);
    summarize(plan);
    console.log(
      'Standalone mode: no multi-collection rollback. Keep writers stopped. Apply still requires a restore-tested native backup.',
    );
    return;
  }
  requireSafe(reviewed, 'Reviewed apply plan required.');
  checkSnapshot(reviewed, before.snapshot);
  console.log(
    'OFFLINE STANDALONE: deletes are durable individually. Failure may leave partial cleanup. No automatic retry or rollback.',
  );
  const counts = await deleteStandalone(db, target, EJSON, before);
  await committed(opts, reviewed, counts, 'STANDALONE_VERIFIED_FILES_RETAINED');
  console.log(
    'Pinned STAGING CRM cleanup verified; configuration and indexes retained. Keep writers stopped until both systems are verified.',
  );
}
