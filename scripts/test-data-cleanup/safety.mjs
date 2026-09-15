import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

export class SafetyError extends Error {}
export function requireSafe(condition, message) {
  if (!condition) throw new SafetyError(message);
}

export function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export function digest(value) {
  return hash(JSON.stringify(canonical(value)));
}

export function options(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      target: { type: 'string' },
      plan: { type: 'string' },
      apply: { type: 'boolean', default: false },
      confirm: { type: 'string' },
      backup: { type: 'string' },
      'backup-sha256': { type: 'string' },
      'writers-stopped': { type: 'boolean' },
      'restore-tested': { type: 'boolean' },
      'accept-retained-files': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  return values;
}

function filled(value) {
  return (
    typeof value === 'string' && value.trim().length > 0 && !/REPLACE|CHANGE_ME|<|>/i.test(value)
  );
}

export function validateTarget(target) {
  requireSafe(
    target?.purpose === 'ERASE_TEST_CONTACTS_AND_STAGING_LEADS',
    'Wrong cleanup purpose.',
  );
  for (const [name, fields] of Object.entries({
    crm: [
      'railwayProjectId',
      'railwayEnvironmentId',
      'railwayServiceId',
      'database',
      'baseUrl',
      'crmProjectId',
    ],
    omnicus: [
      'railwayProjectId',
      'railwayEnvironmentId',
      'railwayServiceId',
      'host',
      'database',
      'projectId',
      'projectName',
    ],
  })) {
    for (const field of fields)
      requireSafe(filled(target[name]?.[field]), `Fill ${name}.${field} from the actual target.`);
  }
  requireSafe(
    target.crm.environmentName === 'staging',
    'CRM must be staging. No production override exists.',
  );
  requireSafe(
    Array.isArray(target.crm.hosts) &&
      target.crm.hosts.length > 0 &&
      target.crm.hosts.every(filled),
    'Pin all staging Mongo hosts.',
  );
  requireSafe(
    !/prod(uction)?/i.test(
      [target.crm.database, target.crm.baseUrl, ...target.crm.hosts].join(' '),
    ),
    'Production-like CRM target forbidden.',
  );
  requireSafe(
    /^[0-9a-f-]{36}$/i.test(target.omnicus.projectId),
    'Explicit Omnicus project UUID required.',
  );
  let url;
  try {
    url = new URL(target.crm.baseUrl);
  } catch {
    throw new SafetyError('Invalid staging CRM baseUrl.');
  }
  requireSafe(
    url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
    'CRM baseUrl must be HTTPS without credentials/query/hash.',
  );
  requireSafe(
    target.crm.baseUrl.replace(/\/$/, '') === url.origin,
    'CRM baseUrl must be an origin.',
  );
  return target;
}

export function validateEnvironment(kind, target, environment) {
  const expected = target[kind];
  for (const [key, field] of [
    ['RAILWAY_PROJECT_ID', 'railwayProjectId'],
    ['RAILWAY_ENVIRONMENT_ID', 'railwayEnvironmentId'],
    ['RAILWAY_SERVICE_ID', 'railwayServiceId'],
  ])
    requireSafe(environment[key] === expected[field], `Railway identity mismatch: ${key}.`);
  if (kind === 'crm') {
    requireSafe(
      environment.RAILWAY_ENVIRONMENT_NAME === 'staging',
      'CRM Railway environment must be exactly staging.',
    );
  }
}

// No fallback to DATABASE_URL / MONGODB_URI and no dotenv import anywhere.
export function databaseUri(kind, target, environment) {
  const key = kind === 'crm' ? 'CLEANUP_CRM_STAGING_URI' : 'CLEANUP_OMNICUS_DATABASE_URL';
  const uri = environment[key];
  requireSafe(
    filled(uri),
    `Set the dedicated ${key}; normal application variables are never used.`,
  );
  if (kind === 'crm') {
    // Keep Mongo URI parsing deliberately narrow: reject driver options that can
    // redirect the connection or hide a target. Replica-set support is checked
    // after connecting; use a database-scoped staging credential as documented.
    const match = /^(mongodb(?:\+srv)?):\/\/(?:[^/@]+@)?([^/?]+)\/([^/?]+)(?:\?([^#]*))?$/.exec(
      uri,
    );
    requireSafe(match, 'Mongo URI must include explicit hosts and database.');
    const hosts = match[2].toLowerCase().split(',').sort();
    requireSafe(
      digest(hosts) === digest(target.crm.hosts.map((host) => host.toLowerCase()).sort()),
      'Mongo hosts do not match the pinned staging target.',
    );
    requireSafe(decodeURIComponent(match[3]) === target.crm.database, 'Mongo database mismatch.');
    const params = new URLSearchParams(match[4] ?? '');
    const allowed = new Set([
      'authSource',
      'replicaSet',
      'tls',
      'ssl',
      'retryWrites',
      'w',
      'directConnection',
      'appName',
    ]);
    for (const [name, value] of params) {
      requireSafe(allowed.has(name), `Unsupported Mongo URI option: ${name}.`);
      if (name === 'w')
        requireSafe(value === 'majority', 'Mongo writes must use majority acknowledgment.');
    }
  } else {
    let url;
    try {
      url = new URL(uri);
    } catch {
      throw new SafetyError('Invalid dedicated PostgreSQL URL.');
    }
    requireSafe(['postgres:', 'postgresql:'].includes(url.protocol), 'Expected PostgreSQL URL.');
    requireSafe(
      `${url.hostname.toLowerCase()}:${url.port || '5432'}` === target.omnicus.host.toLowerCase(),
      'PostgreSQL host/port mismatch.',
    );
    requireSafe(
      decodeURIComponent(url.pathname.slice(1)) === target.omnicus.database,
      'PostgreSQL database mismatch.',
    );
    requireSafe(!url.hash, 'PostgreSQL URL fragment forbidden.');
    for (const [key, value] of url.searchParams)
      requireSafe(
        key === 'sslmode' && ['require', 'verify-full'].includes(value),
        'Only sslmode=require/verify-full is allowed in the PostgreSQL URL.',
      );
  }
  return uri;
}

export async function readTarget(path) {
  requireSafe(path, '--target is required.');
  return validateTarget(JSON.parse(await readFile(path, 'utf8')));
}

export async function writeNewJson(path, value) {
  // Never overwrite a previously reviewed plan or a deletion receipt.
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

export function makePlan(kind, target, snapshot) {
  const body = { version: 1, kind, target, snapshot };
  return { ...body, fingerprint: digest(body), createdAt: new Date().toISOString() };
}

export function confirmation(plan) {
  return `ERASE-${plan.kind === 'crm' ? 'STAGING-CRM' : 'OMNICUS-PROJECT'}-${plan.fingerprint.slice(0, 16)}`;
}

export async function checkApply(opts, kind, target) {
  requireSafe(opts.plan, '--plan is required.');
  const plan = JSON.parse(await readFile(opts.plan, 'utf8'));
  const expected = makePlan(kind, target, plan.snapshot);
  requireSafe(
    plan.fingerprint === expected.fingerprint,
    'Plan kind/target/content mismatch. Generate a new dry-run.',
  );
  const age = Date.now() - Date.parse(plan.createdAt);
  requireSafe(
    Number.isFinite(age) && age >= 0 && age < 3_600_000,
    'Plan expired (valid for one hour).',
  );
  requireSafe(
    opts.confirm === confirmation(plan),
    'Exact confirmation from the reviewed dry-run is required.',
  );
  requireSafe(
    opts['writers-stopped'] === true,
    'Stop APIs, workers, schedulers, webhook/website ingress and both sync directions first.',
  );
  requireSafe(
    opts['restore-tested'] === true,
    'A restore-tested native database backup is required.',
  );
  requireSafe(
    opts.backup && /^[a-f0-9]{64}$/i.test(opts['backup-sha256'] ?? ''),
    'Supply --backup and its independently checked --backup-sha256.',
  );
  const file = await stat(opts.backup);
  requireSafe(file.isFile() && file.size > 0, 'Backup must be an existing nonempty file.');
  const checksum = createHash('sha256');
  for await (const chunk of createReadStream(opts.backup)) checksum.update(chunk);
  requireSafe(
    checksum.digest('hex') === opts['backup-sha256'].toLowerCase(),
    'Backup checksum mismatch.',
  );
  requireSafe(
    opts['accept-retained-files'] === true,
    'Database cleanup does not delete bucket objects, provider copies, Redis payloads or backups; review retainedFiles in the plan.',
  );
  // Reserve the receipt path before opening a database transaction.
  await writeNewJson(`${opts.plan}.receipt.json`, {
    status: 'PREPARED_OUTCOME_NOT_CONFIRMED',
    fingerprint: plan.fingerprint,
    backupSha256: opts['backup-sha256'].toLowerCase(),
  });
  return plan;
}

export function checkSnapshot(plan, snapshot) {
  requireSafe(
    digest(plan.snapshot) === digest(snapshot),
    'Data/configuration changed since dry-run. Nothing deleted; generate a new plan.',
  );
}

export async function committed(opts, plan, counts) {
  await writeFile(
    `${opts.plan}.receipt.json`,
    `${JSON.stringify(
      {
        status: 'DATABASE_COMMITTED_FILES_RETAINED',
        fingerprint: plan.fingerprint,
        committedAt: new Date().toISOString(),
        counts,
        backupSha256: opts['backup-sha256'].toLowerCase(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

export function summarize(plan) {
  console.log(
    JSON.stringify(
      {
        mode: 'DRY_RUN_NO_DATABASE_WRITES',
        kind: plan.kind,
        target:
          plan.kind === 'crm'
            ? {
                hosts: plan.target.crm.hosts,
                database: plan.target.crm.database,
                environment: 'staging',
              }
            : {
                host: plan.target.omnicus.host,
                database: plan.target.omnicus.database,
                projectId: plan.target.omnicus.projectId,
                projectName: plan.target.omnicus.projectName,
              },
        deleteCounts: plan.snapshot.deleteCounts,
        updateCounts: plan.snapshot.updateCounts,
        retainedFileCount: plan.snapshot.retainedFiles.length,
        confirm: confirmation(plan),
      },
      null,
      2,
    ),
  );
}

export function reportError(error) {
  // Database/driver errors can contain connection URIs, raw documents or PII.
  console.error(
    error instanceof SafetyError
      ? error.message
      : 'Cleanup stopped. No raw driver error is printed because it may contain secrets. Check target, network, permissions and database transaction support. If COMMIT was attempted, inspect the database and receipt before doing anything else.',
  );
  process.exitCode = 1;
}

export function help(kind) {
  console.log(
    `node ${kind === 'crm' ? 'crm-staging' : 'omnicus'}.mjs --target target.local.json --plan ${kind}.plan.json\nDefault: read-only dry-run. See README.md before using --apply. Production CRM is forbidden.`,
  );
}
