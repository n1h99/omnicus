import { spawnSync } from 'node:child_process';

const javascriptEntrypointPattern = /\.(?:c|m)?js$/i;

export function packageManagerRequiresNode(executable) {
  return javascriptEntrypointPattern.test(executable);
}

export function spawnPackageManagerSync(executable, arguments_, options) {
  return packageManagerRequiresNode(executable)
    ? spawnSync(process.execPath, [executable, ...arguments_], options)
    : spawnSync(executable, arguments_, options);
}
