import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';
import { packageManagerRequiresNode } from './package-manager.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const pnpmExecutable = process.env.npm_execpath;
const userAgent = process.env.npm_config_user_agent ?? '';
const turboEntrypoint = resolve(repositoryRoot, 'node_modules/turbo/bin/turbo');

if (
  !pnpmExecutable ||
  !/(?:corepack|pnpm)/i.test(pnpmExecutable) ||
  !/(?:^|\s)pnpm\/10\.5\.0(?:\s|$)/.test(userAgent)
) {
  throw new Error('Run Turborepo through the pinned repository pnpm command');
}

const shimDirectory = mkdtempSync(join(tmpdir(), 'omnicus-pnpm-'));
const resolvedTemporaryRoot = resolve(tmpdir());
const resolvedShimDirectory = resolve(shimDirectory);

if (!resolvedShimDirectory.startsWith(`${resolvedTemporaryRoot}${sep}`)) {
  throw new Error('Refusing to create a package-manager shim outside the OS temp directory');
}

const shimEnvironment = {
  ...process.env,
  OMNICUS_NODE_EXECUTABLE: process.execPath,
  OMNICUS_PNPM_EXECUTABLE: pnpmExecutable,
  OMNICUS_PNPM_REQUIRES_NODE: packageManagerRequiresNode(pnpmExecutable) ? '1' : '0',
  OMNICUS_TOOLCHAIN_NODE_VERSION: process.version,
  PATH: `${shimDirectory}${delimiter}${process.env.PATH ?? ''}`,
};

try {
  const posixShim = join(shimDirectory, 'pnpm');
  writeFileSync(
    posixShim,
    '#!/bin/sh\nif [ "$OMNICUS_PNPM_REQUIRES_NODE" = "1" ]; then\n  exec "$OMNICUS_NODE_EXECUTABLE" "$OMNICUS_PNPM_EXECUTABLE" "$@"\nfi\nexec "$OMNICUS_PNPM_EXECUTABLE" "$@"\n',
    'utf8',
  );
  chmodSync(posixShim, 0o700);
  writeFileSync(
    join(shimDirectory, 'pnpm.cmd'),
    '@echo off\r\n"%OMNICUS_NODE_EXECUTABLE%" "%OMNICUS_PNPM_EXECUTABLE%" %*\r\n',
    'utf8',
  );

  const result = spawnSync(process.execPath, [turboEntrypoint, ...process.argv.slice(2)], {
    cwd: repositoryRoot,
    env: shimEnvironment,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  process.exitCode = result.status ?? 1;
} finally {
  rmSync(resolvedShimDirectory, { force: true, recursive: true });
}
