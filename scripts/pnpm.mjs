import { spawnPackageManagerSync } from './package-manager.mjs';

const pnpmExecutable = process.env.npm_execpath;

if (!pnpmExecutable || !/(?:corepack|pnpm)/i.test(pnpmExecutable)) {
  process.stderr.write('pnpm lifecycle metadata is missing; invoke this script through pnpm\n');
  process.exit(1);
}

const result = spawnPackageManagerSync(pnpmExecutable, process.argv.slice(2), {
  encoding: 'utf8',
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
