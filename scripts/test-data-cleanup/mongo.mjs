import { digest, requireSafe } from './safety.mjs';

// Whole STAGING database lead data, including orphans and old provider inbox.
// Collections and indexes themselves are preserved. Never dropDatabase/drop.
export const DELETE_COLLECTIONS = [
  'conversationmentionnotifications',
  'conversationdrafts',
  'conversationinternalnotes',
  'conversationscheduledoperations',
  'conversationprovideroperations',
  'conversationmessages',
  'conversations',
  'omnicusreactionevents',
  'omnicusconversationevents',
  'omnicusoperations',
  'omnicuscontactlinks',
  'leadhistories',
  'contracts',
  'manychatwebhooklogs',
  'leads',
];
export const PRESERVE_COLLECTIONS = [
  'users',
  'rolepermissions',
  'quickreplytemplates',
  'quickreplytemplatepreferences',
  'omnicusconnections',
];
const MAX_ROWS = 20_000;
const MAX_BYTES = 100 * 1024 * 1024;

export async function collectionInventory(db) {
  const inventory = await db.listCollections({}, { nameOnly: false }).toArray();
  for (const entry of inventory) {
    requireSafe(
      entry.type === 'collection' && !entry.options?.capped,
      'Mongo view/time-series/capped collection requires a separate review.',
    );
    requireSafe(
      [...DELETE_COLLECTIONS, ...PRESERVE_COLLECTIONS].includes(entry.name),
      `Unreviewed Mongo collection: ${entry.name}. Stop; do not add a bypass.`,
    );
  }
  requireSafe(
    inventory.some((entry) => entry.name === 'leads'),
    'Expected leads collection missing.',
  );
  requireSafe(
    inventory.some((entry) => entry.name === 'omnicusconnections'),
    'Expected Omnicus pairing collection missing.',
  );
  return inventory
    .map((entry) => ({ name: entry.name, options: entry.options ?? {} }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function readMongoState(db, session, target, inventory, EJSON) {
  requireSafe(db.databaseName === target.crm.database, 'Connected Mongo database mismatch.');
  const connections = await db
    .collection('omnicusconnections')
    .find({}, { session, limit: 3 })
    .toArray();
  requireSafe(
    connections.length === 1,
    'Staging cleanup requires exactly one reviewed Omnicus pairing.',
  );
  requireSafe(
    connections[0].crmProjectId === target.crm.crmProjectId &&
      connections[0].omnicusProjectId === target.omnicus.projectId,
    'Staging CRM pairing/project mismatch.',
  );
  requireSafe(
    connections[0].status === 'DISABLED',
    'Disable the staging CRM Omnicus connection before cleanup.',
  );
  const rows = {};
  let bytes = 0;
  for (const name of DELETE_COLLECTIONS) {
    rows[name] = inventory.some((entry) => entry.name === name)
      ? await db
          .collection(name)
          .find({}, { session, limit: MAX_ROWS + 1 })
          .toArray()
      : [];
    requireSafe(
      rows[name].length <= MAX_ROWS,
      `Too many rows in ${name}; use a reviewed large-dataset procedure.`,
    );
    bytes += Buffer.byteLength(EJSON.stringify(rows[name], { relaxed: false }));
    requireSafe(bytes <= MAX_BYTES, 'Mongo snapshot exceeds 100 MiB. No deletion attempted.');
  }
  // Refuse multi-project residues as well as multiple current connections.
  for (const name of [
    'omnicusoperations',
    'omnicuscontactlinks',
    'omnicusreactionevents',
    'omnicusconversationevents',
    'conversations',
  ]) {
    requireSafe(
      rows[name].every(
        (row) =>
          (!row.omnicusProjectId || row.omnicusProjectId === target.omnicus.projectId) &&
          (!row.crmProjectId || row.crmProjectId === target.crm.crmProjectId),
      ),
      'Found data belonging to another CRM/Omnicus pairing. Review the staging scope.',
    );
  }
  return { inventory, connections, rows };
}

function findStorageKeys(value, keys) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.storageKey === 'string' && value.storageKey) keys.add(value.storageKey);
  for (const child of Object.values(value)) findStorageKeys(child, keys);
}

export function mongoPlan(state, EJSON) {
  const keys = new Set();
  for (const docs of Object.values(state.rows)) for (const doc of docs) findStorageKeys(doc, keys);
  const sorted = Object.fromEntries(
    Object.entries(state.rows).map(([name, docs]) => [
      name,
      docs.map((doc) => EJSON.stringify(doc, { relaxed: false })).sort(),
    ]),
  );
  return {
    dataHash: digest({
      inventory: state.inventory,
      connections: EJSON.stringify(state.connections, { relaxed: false }),
      rows: sorted,
    }),
    deleteCounts: Object.fromEntries(
      DELETE_COLLECTIONS.map((name) => [name, state.rows[name].length]),
    ),
    updateCounts: {},
    retainedFiles: [...keys].sort().map((storageKey) => ({
      storageKey,
      action: 'RETAIN_OBJECT_PENDING_SEPARATE_STORAGE_REVIEW',
    })),
    warnings: [
      'All leads in the pinned STAGING database, including archived leads and orphan history, are deleted.',
      'Bucket objects, files known only by URL, provider copies and backups are not deleted.',
      'Users, permissions, quick replies, integration configuration, collections and indexes remain.',
    ],
  };
}

export async function deleteMongoData(db, session, state) {
  const counts = {};
  for (const name of DELETE_COLLECTIONS) {
    const ids = state.rows[name].map((row) => row._id);
    let deleted = 0;
    // Delete exact reviewed IDs, never a database-wide unfiltered deleteMany.
    for (let offset = 0; offset < ids.length; offset += 500) {
      const result = await db
        .collection(name)
        .deleteMany({ _id: { $in: ids.slice(offset, offset + 500) } }, { session });
      deleted += result.deletedCount;
    }
    requireSafe(
      deleted === ids.length,
      `Delete count mismatch in ${name}; transaction must roll back.`,
    );
    if (state.inventory.some((entry) => entry.name === name))
      requireSafe(
        (await db.collection(name).countDocuments({}, { session })) === 0,
        `Records remain in ${name}; transaction must roll back.`,
      );
    counts[name] = deleted;
  }
  return counts;
}
