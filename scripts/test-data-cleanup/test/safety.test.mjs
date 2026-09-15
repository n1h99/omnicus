import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main as crmMain } from '../crm-staging.mjs';
import { main as omnicusMain } from '../omnicus.mjs';
import {
  checkApply,
  checkSnapshot,
  confirmation,
  databaseUri,
  digest,
  hash,
  makePlan,
  options,
  validateEnvironment,
  validateTarget,
  writeNewJson,
} from '../safety.mjs';

export const target = {
  purpose: 'ERASE_TEST_CONTACTS_AND_STAGING_LEADS',
  crm: {
    environmentName: 'staging',
    railwayProjectId: 'railway-crm',
    railwayEnvironmentId: 'staging-id',
    railwayServiceId: 'crm-api',
    hosts: ['127.0.0.1:27017'],
    database: 'crm_staging_fixture',
    baseUrl: 'https://crm-staging.example.test',
    crmProjectId: 'crm-fixture',
  },
  omnicus: {
    railwayProjectId: 'railway-omni',
    railwayEnvironmentId: 'omni-env',
    railwayServiceId: 'omni-api',
    host: '127.0.0.1:5432',
    database: 'omnicus_fixture',
    projectId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    projectName: 'Cleanup fixture',
  },
};

test('example target is fail-closed and no production override exists', async () => {
  const example = JSON.parse(
    await readFile(new URL('../target.example.json', import.meta.url), 'utf8'),
  );
  assert.throws(() => validateTarget(example), /Fill/);
  assert.equal(validateTarget(target), target);
  for (const value of ['production', 'prod', 'Production']) {
    const input = structuredClone(target);
    input.crm.environmentName = value;
    assert.throws(() => validateTarget(input), /staging/);
  }
  for (const field of ['database', 'baseUrl', 'hosts']) {
    const input = structuredClone(target);
    input.crm[field] = field === 'hosts' ? ['production.example:27017'] : 'production';
    assert.throws(() => validateTarget(input), /Production/);
  }
});

test('Railway project, environment AND service must match; NODE_ENV cannot authorize CRM', () => {
  const environment = {
    RAILWAY_PROJECT_ID: 'railway-crm',
    RAILWAY_ENVIRONMENT_ID: 'staging-id',
    RAILWAY_SERVICE_ID: 'crm-api',
    RAILWAY_ENVIRONMENT_NAME: 'staging',
  };
  validateEnvironment('crm', target, environment);
  // NODE_ENV=production is normal for an optimized staging build; Railway's
  // actual environment identity, not this application-mode variable, is checked.
  validateEnvironment('crm', target, { ...environment, NODE_ENV: 'production' });
  for (const key of Object.keys(environment))
    assert.throws(() =>
      validateEnvironment('crm', target, { ...environment, [key]: 'production' }),
    );
  assert.throws(() => validateEnvironment('crm', target, { NODE_ENV: 'staging' }));
});

test('normal application credentials are never used as a fallback', () => {
  assert.throws(
    () => databaseUri('crm', target, { MONGODB_URI: 'mongodb://prod/leads' }),
    /dedicated/,
  );
  assert.throws(
    () => databaseUri('omnicus', target, { DATABASE_URL: 'postgres://prod/app' }),
    /dedicated/,
  );
});

test('dedicated URLs must pin host, port and explicit database', () => {
  const mongo = 'mongodb://test:secret@127.0.0.1:27017/crm_staging_fixture?authSource=admin';
  assert.equal(databaseUri('crm', target, { CLEANUP_CRM_STAGING_URI: mongo }), mongo);
  for (const uri of [
    mongo.replace('27017', '27018'),
    mongo.replace('crm_staging_fixture', 'another_db'),
    'mongodb://127.0.0.1:27017/',
    `${mongo}&srvServiceName=other`,
    `${mongo}&w=0`,
  ])
    assert.throws(() => databaseUri('crm', target, { CLEANUP_CRM_STAGING_URI: uri }));
  const postgres = 'postgres://test:secret@127.0.0.1:5432/omnicus_fixture';
  assert.equal(
    databaseUri('omnicus', target, { CLEANUP_OMNICUS_DATABASE_URL: postgres }),
    postgres,
  );
  for (const uri of [
    postgres.replace('5432', '5433'),
    `${postgres}?host=prod`,
    `${postgres}?options=-csearch_path=other`,
    postgres.replace('omnicus_fixture', 'other'),
  ])
    assert.throws(() => databaseUri('omnicus', target, { CLEANUP_OMNICUS_DATABASE_URL: uri }));
});

test('unknown destructive flags/positionals rejected and default is dry-run', () => {
  assert.equal(options([]).apply, false);
  for (const args of [['--force'], ['--allow-production'], ['--all-projects'], ['production']])
    assert.throws(() => options(args));
});

test('snapshot detects equal-count content or ID changes', () => {
  const snapshot = { deleteCounts: { leads: 1 }, dataHash: digest(['lead-a', 'original']) };
  const plan = makePlan('crm', target, snapshot);
  checkSnapshot(plan, structuredClone(snapshot));
  assert.throws(
    () => checkSnapshot(plan, { ...snapshot, dataHash: digest(['lead-b', 'original']) }),
    /changed/,
  );
  assert.throws(
    () => checkSnapshot(plan, { ...snapshot, dataHash: digest(['lead-a', 'updated']) }),
    /changed/,
  );
});

test('apply requires reviewed target/plan, exact confirmation, backup checksum and acknowledgments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cleanup-safety-test-'));
  const plan = makePlan('crm', target, { deleteCounts: {}, retainedFiles: [] });
  const planPath = join(directory, 'fixture.plan.json');
  const backup = join(directory, 'fake-test-backup.archive');
  await writeNewJson(planPath, plan);
  await writeFile(backup, 'isolated fixture, not a real backup');
  const opts = {
    plan: planPath,
    confirm: confirmation(plan),
    backup,
    'backup-sha256': hash('isolated fixture, not a real backup'),
    'writers-stopped': true,
    'restore-tested': true,
    'accept-retained-files': true,
  };
  for (const key of [
    'confirm',
    'backup',
    'backup-sha256',
    'writers-stopped',
    'restore-tested',
    'accept-retained-files',
  ])
    await assert.rejects(checkApply({ ...opts, [key]: undefined }, 'crm', target));
  await assert.rejects(
    checkApply({ ...opts, 'backup-sha256': '0'.repeat(64) }, 'crm', target),
    /checksum/,
  );
  await assert.rejects(checkApply(opts, 'omnicus', target), /mismatch/);
  const other = structuredClone(target);
  other.crm.database = 'another_staging_db';
  await assert.rejects(checkApply(opts, 'crm', other), /mismatch/);
  assert.equal((await checkApply(opts, 'crm', target)).fingerprint, plan.fingerprint);
  await assert.rejects(checkApply(opts, 'crm', target)); // receipt cannot be overwritten/replayed
  await assert.rejects(writeNewJson(planPath, plan));
});

test('expired and malformed plans rejected before DB connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cleanup-expiry-test-'));
  const plan = makePlan('crm', target, {});
  for (const createdAt of [
    'invalid',
    new Date(Date.now() - 3_700_000).toISOString(),
    new Date(Date.now() + 3_700_000).toISOString(),
  ]) {
    const planPath = join(directory, `${hash(createdAt)}.plan.json`);
    await writeNewJson(planPath, { ...plan, createdAt });
    await assert.rejects(checkApply({ plan: planPath }, 'crm', target), /expired/);
  }
});

test('both real CLI entrypoints reject unsafe targets before importing/connecting drivers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cleanup-cli-test-'));
  const path = join(directory, 'target.local.json');
  await writeNewJson(path, target);
  const args = ['--target', path, '--plan', join(directory, 'never-created.plan.json')];
  await assert.rejects(
    crmMain(args, {
      RAILWAY_PROJECT_ID: target.crm.railwayProjectId,
      RAILWAY_ENVIRONMENT_ID: target.crm.railwayEnvironmentId,
      RAILWAY_SERVICE_ID: target.crm.railwayServiceId,
      RAILWAY_ENVIRONMENT_NAME: 'production',
      CLEANUP_CRM_STAGING_URI: 'mongodb://127.0.0.1:1/not_a_real_database',
    }),
    /environment must be exactly staging/,
  );
  await assert.rejects(
    omnicusMain(args, {
      RAILWAY_PROJECT_ID: target.omnicus.railwayProjectId,
      RAILWAY_ENVIRONMENT_ID: target.omnicus.railwayEnvironmentId,
      RAILWAY_SERVICE_ID: target.omnicus.railwayServiceId,
      CLEANUP_OMNICUS_DATABASE_URL: 'postgres://fixture:unused@127.0.0.1:1/not_a_real_database',
    }),
    /host\/port mismatch/,
  );
});
