import {
  cpSync,
  existsSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';
import { spawnPackageManagerSync } from './package-manager.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const runtimeRoot = resolve(repositoryRoot, '.runtime');
const pnpmExecutable = process.env.npm_execpath;
const requestedService = process.argv[2];
const validServices = new Set(['all', 'api', 'web', 'worker']);

if (!pnpmExecutable || !/(?:corepack|pnpm)/i.test(pnpmExecutable)) {
  throw new Error('Run runtime preparation through the repository pnpm command');
}

if (!requestedService || !validServices.has(requestedService)) {
  throw new Error('Runtime service must be one of: all, api, web, worker');
}

function resetTarget(target) {
  const resolvedTarget = resolve(target);
  if (!resolvedTarget.startsWith(`${runtimeRoot}${sep}`)) {
    throw new Error(`Refusing to reset a runtime target outside ${runtimeRoot}`);
  }
  rmSync(resolvedTarget, { force: true, recursive: true });
  mkdirSync(resolvedTarget, { recursive: true });
}

function deployWorkspace(service) {
  const target = resolve(runtimeRoot, service);
  resetTarget(target);
  const workspaceDirectory = resolve(repositoryRoot, 'apps', service);
  const result = spawnPackageManagerSync(
    pnpmExecutable,
    ['--filter', `@omnicus/${service}`, '--prod', 'deploy', '--legacy', target],
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit',
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  const packageJsonPath = resolve(target, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  delete packageJson.devDependencies;
  delete packageJson.scripts;
  packageJson.engines = { node: '24.18.0' };
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

  const unintendedLegacyTarget = resolve(workspaceDirectory, '.runtime');
  if (
    unintendedLegacyTarget.startsWith(`${workspaceDirectory}${sep}`) &&
    existsSync(unintendedLegacyTarget)
  ) {
    rmSync(unintendedLegacyTarget, { force: true, recursive: true });
  }
}

function deployWeb() {
  const target = resolve(runtimeRoot, 'web');
  resetTarget(target);
  cpSync(resolve(repositoryRoot, 'apps/web/dist'), resolve(target, 'dist'), {
    recursive: true,
  });
  cpSync(resolve(repositoryRoot, 'apps/web/server.mjs'), resolve(target, 'server.mjs'));
  writeFileSync(
    resolve(target, 'package.json'),
    `${JSON.stringify(
      {
        engines: { node: '24.18.0' },
        name: '@omnicus/web-runtime',
        private: true,
        type: 'module',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function pruneUnreachableVirtualStore(target) {
  const nodeModules = resolve(target, 'node_modules');
  const virtualStore = resolve(nodeModules, '.pnpm');
  const reachableEntries = new Set();
  const pendingEntries = [];

  function markLink(linkPath) {
    let linkStat;
    try {
      linkStat = lstatSync(linkPath);
    } catch {
      return;
    }
    if (!linkStat.isSymbolicLink()) {
      return;
    }

    const resolvedLink = realpathSync(linkPath);
    const relativeLink = resolvedLink.slice(`${virtualStore}${sep}`.length);
    if (
      !resolvedLink.startsWith(`${virtualStore}${sep}`) ||
      relativeLink.startsWith(`node_modules${sep}`)
    ) {
      return;
    }

    const [virtualEntry, nodeModulesSegment] = relativeLink.split(/[\\/]/);
    if (
      !virtualEntry ||
      nodeModulesSegment !== 'node_modules' ||
      reachableEntries.has(virtualEntry)
    ) {
      return;
    }

    reachableEntries.add(virtualEntry);
    pendingEntries.push(virtualEntry);
  }

  function markNodeModulesLinks(directory) {
    if (!existsSync(directory)) {
      return;
    }

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        markLink(entryPath);
      } else if (entry.isDirectory() && entry.name.startsWith('@')) {
        for (const scopedEntry of readdirSync(entryPath, { withFileTypes: true })) {
          if (scopedEntry.isSymbolicLink()) {
            markLink(resolve(entryPath, scopedEntry.name));
          }
        }
      }
    }
  }

  markNodeModulesLinks(nodeModules);
  markNodeModulesLinks(resolve(virtualStore, 'node_modules'));

  while (pendingEntries.length > 0) {
    const virtualEntry = pendingEntries.shift();
    markNodeModulesLinks(resolve(virtualStore, virtualEntry, 'node_modules'));
  }

  if (reachableEntries.size === 0) {
    throw new Error(`No reachable production dependencies found in ${target}`);
  }

  let removed = 0;
  for (const entry of readdirSync(virtualStore, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'node_modules' && !reachableEntries.has(entry.name)) {
      const unreachableEntry = resolve(virtualStore, entry.name);
      if (!unreachableEntry.startsWith(`${virtualStore}${sep}`)) {
        throw new Error(`Refusing to prune outside ${virtualStore}`);
      }
      rmSync(unreachableEntry, { force: true, recursive: true });
      removed += 1;
    }
  }

  return removed;
}

function stripSourceMaps(target) {
  const resolvedTarget = resolve(target);
  if (!resolvedTarget.startsWith(`${runtimeRoot}${sep}`)) {
    throw new Error(`Refusing to strip source maps outside ${runtimeRoot}`);
  }

  for (const entry of readdirSync(resolvedTarget, { recursive: true })) {
    if (entry.endsWith('.map')) {
      rmSync(resolve(resolvedTarget, entry), { force: true });
    }
  }
}

function stripDatabaseAdministrativeFiles(target) {
  const databasePackage = resolve(target, 'node_modules/@omnicus/database');
  const removablePaths = [
    resolve(databasePackage, 'prisma'),
    resolve(databasePackage, 'dist/seed.js'),
    resolve(databasePackage, 'dist/seed.d.ts'),
    resolve(databasePackage, 'dist/seed-guard.js'),
    resolve(databasePackage, 'dist/seed-guard.d.ts'),
    resolve(databasePackage, 'dist/production-admin-bootstrap.js'),
    resolve(databasePackage, 'dist/production-admin-bootstrap.d.ts'),
    resolve(databasePackage, 'dist/production-admin-bootstrap-guard.js'),
    resolve(databasePackage, 'dist/production-admin-bootstrap-guard.d.ts'),
  ];

  for (const removablePath of removablePaths) {
    if (!removablePath.startsWith(`${target}${sep}`)) {
      throw new Error(`Refusing to strip a database administrative file outside ${target}`);
    }
    rmSync(removablePath, { force: true, recursive: true });
  }
}

function assertRuntime(service) {
  const target = resolve(runtimeRoot, service);
  const forbiddenPaths = [
    'node_modules/@playwright',
    'node_modules/@omnicus/database/dist/seed.js',
    'node_modules/@omnicus/database/dist/production-admin-bootstrap.js',
    'node_modules/@omnicus/database/prisma',
    'node_modules/prisma',
    'node_modules/typescript',
    'node_modules/vite',
  ];
  const requiredEntry =
    service === 'web' ? resolve(target, 'server.mjs') : resolve(target, 'dist/main.js');

  if (!existsSync(requiredEntry)) {
    throw new Error(`${service} runtime entry is missing: ${requiredEntry}`);
  }

  const sourceMap = readdirSync(target, { recursive: true }).find((entry) =>
    entry.endsWith('.map'),
  );
  if (sourceMap) {
    throw new Error(`${service} runtime contains a production source map: ${sourceMap}`);
  }

  for (const forbiddenPath of forbiddenPaths) {
    if (existsSync(resolve(target, forbiddenPath))) {
      throw new Error(`${service} runtime contains development tooling: ${forbiddenPath}`);
    }
  }

  if (service !== 'web') {
    const packageJson = JSON.parse(readFileSync(resolve(target, 'package.json'), 'utf8'));
    if (packageJson.devDependencies) {
      throw new Error(`${service} runtime package.json contains devDependencies`);
    }

    const installedPackages = readdirSync(resolve(target, 'node_modules/.pnpm'));
    const forbiddenPackagePatterns = [
      /^@playwright\+/,
      /^@prisma\+(?:config|dev|engines|fetch-engine|get-platform|studio-core)@/,
      /^eslint@/,
      /^jest@/,
      /^prisma@/,
      /^tsx@/,
      /^turbo@/,
      /^typescript@/,
      /^vite@/,
      /^vitest@/,
    ];
    const forbiddenInstalledPackage = installedPackages.find((entry) =>
      forbiddenPackagePatterns.some((pattern) => pattern.test(entry)),
    );
    if (forbiddenInstalledPackage) {
      throw new Error(
        `${service} runtime contains development package ${forbiddenInstalledPackage}`,
      );
    }
  }
}

const services = requestedService === 'all' ? ['api', 'web', 'worker'] : [requestedService];

for (const service of services) {
  let prunedVirtualStoreEntries = 0;
  if (service === 'web') {
    deployWeb();
  } else {
    deployWorkspace(service);
    prunedVirtualStoreEntries = pruneUnreachableVirtualStore(resolve(runtimeRoot, service));
  }
  stripDatabaseAdministrativeFiles(resolve(runtimeRoot, service));
  stripSourceMaps(resolve(runtimeRoot, service));
  assertRuntime(service);
  if (prunedVirtualStoreEntries > 0) {
    process.stdout.write(
      `${JSON.stringify({
        check: 'runtime-virtual-store-prune',
        removed: prunedVirtualStoreEntries,
        service,
      })}\n`,
    );
  }
}

process.stdout.write(
  `${JSON.stringify({
    check: 'minimal-runtime-artifacts',
    services,
    status: 'passed',
  })}\n`,
);
