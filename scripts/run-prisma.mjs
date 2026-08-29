import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { spawnPackageManagerSync } from './package-manager.mjs';

const pnpmExecutable = process.env.npm_execpath;
const prismaArguments = process.argv.slice(2);
const command = prismaArguments[0];
const placeholderAllowed =
  command === 'format' ||
  command === 'generate' ||
  command === 'validate' ||
  (command === 'migrate' && prismaArguments[1] === 'diff');

if (!pnpmExecutable || !/(?:corepack|pnpm)/i.test(pnpmExecutable)) {
  throw new Error('Run Prisma commands through the repository pnpm scripts');
}

if (!command) {
  throw new Error('A Prisma command is required');
}

const environment = { ...process.env };

// Prisma CLI runs from packages/database, while local developers invoke this
// wrapper from the repository root. Load only DATABASE_URL from the root .env
// for local commands when the platform did not already provide it. Production
// and staging intentionally rely exclusively on Railway/CI process variables.
function loadLocalDatabaseUrl() {
  if (
    environment.DATABASE_URL ||
    environment.APP_ENV === 'production' ||
    environment.APP_ENV === 'staging'
  ) {
    return 'process-env';
  }
  const rootEnvironment = resolve(import.meta.dirname, '../.env');
  if (!existsSync(rootEnvironment)) return 'missing';
  const line = readFileSync(rootEnvironment, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith('DATABASE_URL='));
  if (!line) return 'missing';
  const value = line.slice('DATABASE_URL='.length).trim();
  environment.DATABASE_URL =
    (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
      ? value.slice(1, -1)
      : value;
  return 'root-dotenv';
}

const databaseUrlSource = loadLocalDatabaseUrl();

if (command === 'generate') {
  const generatedClientDirectory = resolve(
    import.meta.dirname,
    '../packages/database/src/generated/prisma',
  );
  const allowedGeneratedRoot = resolve(import.meta.dirname, '../packages/database/src/generated');

  if (!generatedClientDirectory.startsWith(`${allowedGeneratedRoot}${sep}`)) {
    throw new Error('Refusing to clean Prisma output outside the generated source directory');
  }
  rmSync(generatedClientDirectory, { force: true, recursive: true });
}

if (!environment.DATABASE_URL) {
  if (!placeholderAllowed) {
    throw new Error(
      `DATABASE_URL is required for prisma ${prismaArguments.join(' ')}; no local fallback is allowed`,
    );
  }

  environment.DATABASE_URL =
    'postgresql://prisma_validation:prisma_validation@127.0.0.1:5432/omnicus_validation';
  environment.PRISMA_VALIDATION_PLACEHOLDER = 'true';
  process.stdout.write(
    `${JSON.stringify({
      command: `prisma ${prismaArguments.join(' ')}`,
      database: 'explicit-non-connecting-placeholder',
      level: 'log',
    })}\n`,
  );
}

const databaseUrl = new URL(environment.DATABASE_URL);
if (databaseUrl.protocol !== 'postgres:' && databaseUrl.protocol !== 'postgresql:') {
  throw new Error('DATABASE_URL must use postgres:// or postgresql://');
}

if (environment.PRISMA_ENV_DIAGNOSTICS === '1') {
  process.stdout.write(
    `${JSON.stringify({
      database: databaseUrl.pathname.slice(1),
      databaseUrlSource,
      host: databaseUrl.hostname,
      passwordLength: decodeURIComponent(databaseUrl.password).length,
      passwordPresent: databaseUrl.password.length > 0,
      port: databaseUrl.port || '5432',
      protocol: databaseUrl.protocol,
      username: decodeURIComponent(databaseUrl.username),
    })}\n`,
  );
}

const result = spawnPackageManagerSync(
  pnpmExecutable,
  ['--filter', '@omnicus/database', 'exec', 'prisma', ...prismaArguments],
  {
    encoding: 'utf8',
    env: environment,
    stdio: 'inherit',
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
