/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
const esbuild = require('esbuild');
const {exec} = require('node:child_process');
const {promisify} = require('node:util');
const execAsync = promisify(exec);

const licenseHeaderText = `/**
  * @license
  * Copyright 2025 Google LLC
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
      outfile: 'dist/cli/cli.cjs',
      target: 'node10.4',
      platform: 'node',
      format: 'cjs',
      bundle: true,
      minify: true,
      sourcemap: false,
      packages: 'external',
      logLevel: 'info',
      banner: {js: licenseHeaderText},
    }),
    execAsync('cp -r ./src/browser ./dist/browser'),
  ]);
}

main();
