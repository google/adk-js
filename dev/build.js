/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import esbuild from 'esbuild';
import {exec} from 'node:child_process';
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

/**
 * Builds the ADK devtools library with the given options.
 */
async function main() {
  await Promise.all([
    esbuild.build({
      entryPoints: ['./src/cli/cli.ts'],
      outfile: 'dist/cli/cli.mjs',
      target: 'node16',
      platform: 'node',
      format: 'esm',
      bundle: true,
      minify: true,
      sourcemap: false,
      packages: 'external',
      logLevel: 'info',
      banner: {js: licenseHeaderText},
      plugins: [shimPlugin()],
    }),
    execAsync('cp -r ./src/browser ./dist/browser'),
  ]);
}

main();
