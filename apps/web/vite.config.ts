import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { validateWebEnvironment } from '@omnicus/config/web';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

function runtimeConfigPlugin(apiUrl: string): Plugin {
  return {
    name: 'omnicus-runtime-config',
    async writeBundle(options) {
      const outputDirectory =
        typeof options.dir === 'string'
          ? options.dir
          : fileURLToPath(new URL('./dist', import.meta.url));
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        resolve(outputDirectory, 'runtime-config.json'),
        `${JSON.stringify({ apiUrl })}\n`,
        'utf8',
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const environment = validateWebEnvironment(
    {
      ...loadEnv(mode, repositoryRoot, ''),
      ...process.env,
    },
    { production: mode === 'production' || mode === 'staging' },
  );

  return {
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                maxSize: 200 * 1024,
                name: 'initial-vendor',
                priority: 10,
                tags: ['$initial'],
                test: /node_modules[\\/]/,
              },
            ],
          },
        },
      },
      sourcemap: false,
    },
    envDir: repositoryRoot,
    plugins: [react(), runtimeConfigPlugin(environment.VITE_API_URL)],
    server: {
      host: '0.0.0.0',
    },
  };
});
