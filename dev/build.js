/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import esbuild from 'esbuild';
import {exec} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {promisify} from 'node:util';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {shimPlugin} from 'esbuild-shim-plugin';

const execAsync = promisify(exec);

const licenseHeaderText = `/**
  * @license
  * Copyright 2026 Google LLC
  * SPDX-License-Identifier: Apache-2.0
  */
`;

const commonOptions = {
  target: 'node16',
  platform: 'node',
  packages: 'external',
  logLevel: 'info',
  banner: {js: licenseHeaderText},
  plugins: [shimPlugin()],
  sourcemap: false,
};

/**
 * Builds the ADK devtools library.
 */
async function main() {
  // Run builds in parallel
  await Promise.all([
    esbuild.build({
      ...commonOptions,
      entryPoints: ['./src/cli_entrypoint.ts'],
      outfile: 'dist/cli_entrypoint.mjs',
      format: 'esm',
      bundle: true,
      minify: true,
    }),
    esbuild.build({
      ...commonOptions,
      entryPoints: ['./src/**/*.ts'],
      outdir: 'dist/esm',
      format: 'esm',
      bundle: false,
      minify: false,
    }),
    esbuild.build({
      ...commonOptions,
      entryPoints: ['./src/**/*.ts'],
      outdir: 'dist/cjs',
      format: 'cjs',
      bundle: false,
      minify: false,
    }),
  ]);

  // Run file operations sequentially to avoid race conditions
  await writeFile('./dist/cjs/package.json', '{"type": "commonjs"}');
  await execAsync('cp -r ./src/browser ./dist/esm/browser');
  await execAsync('cp -r ./src/browser ./dist/cjs/browser');
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
