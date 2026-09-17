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
import {
  DELETE_TABLES,
  PRESERVE_TABLES,
  deleteProjectData,
  postgresPlan,
  quote,
  readState,
} from './postgres.mjs';

export async function main(args, environment = process.env) {
  const opts = options(args);
  if (opts.help) return help('omnicus');
  requireSafe(!opts['offline-standalone'], '--offline-standalone is only for staging MongoDB.');
  const target = await readTarget(opts.target);
  validateEnvironment('omnicus', target, environment);
  const connectionString = databaseUri('omnicus', target, environment);
  requireSafe(opts.plan, '--plan is required.');
  const reviewed = opts.apply ? await checkApply(opts, 'omnicus', target) : null;
  const { Client } = await import('pg');
  const client = new Client({
    connectionString,
    application_name: 'omnicus-explicit-project-cleanup',
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
    await client.query(
      opts.apply
        ? 'BEGIN ISOLATION LEVEL SERIALIZABLE'
        : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    if (opts.apply) {
      // Locks block concurrent inserts and schema changes until commit. They do
      // not delete other projects, but require an agreed maintenance window.
      const tables = [...DELETE_TABLES, ...PRESERVE_TABLES].sort().map(quote).join(', ');
      await client.query(`LOCK TABLE ${tables} IN SHARE ROW EXCLUSIVE MODE`);
    }
    const state = await readState(client, target);
    const snapshot = postgresPlan(state);
    if (!opts.apply) {
      const plan = makePlan('omnicus', target, snapshot);
      await client.query('ROLLBACK');
      await writeNewJson(opts.plan, plan);
      summarize(plan);
      return;
    }
    checkSnapshot(reviewed, snapshot);
    const counts = await deleteProjectData(client, target, state);
    await client.query('COMMIT');
    await committed(opts, reviewed, counts);
    console.log(
      'Selected Omnicus project database data cleared. Project remains paused; files retained. See receipt.',
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(reportError);
