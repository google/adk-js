/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import esbuild from 'esbuild';
import { writeFile } from 'node:fs/promises';

const platformBuildTargets = {
  'node': ['node10.4'],
  'browser': ['chrome58', 'firefox57', 'safari11'],
};

const licenseHeaderText = `/**
  * @license
  * Copyright 2025 Google LLC
  * SPDX-License-Identifier: Apache-2.0
  */
`;

/**
 * Builds the ADK core library with the given options.
 *
 * @param {{
 *   targetDir: string,
 *   platform: string,
 *   format: string,
 *   bundle: boolean,
 *   watch: boolean,
 *   entry: string
 * }} options - The build options.
 * @return {!Promise} A promise that resolves when the build is complete.
 */
function build({
  targetDir,
  platform,
  format,
  bundle,
  watch,
  entry = 'index.ts',
}) {
  const buildOptions = {
    target: platformBuildTargets[platform],
    platform,
    format,
    bundle,
    minify: bundle,
    sourcemap: bundle,
    packages: 'external',
    logLevel: 'info',
  };

  // CJS move down license comments, so we prepend them on top of the file again.
  if (format === 'cjs') {
    buildOptions.banner = {js: licenseHeaderText};
  }

  if (bundle) {
    buildOptions.entryPoints = [`./src/${entry}`];
    buildOptions.outfile = `./dist/${targetDir}/index.js`;
  } else {
    buildOptions.entryPoints = ['./src/**/*.ts'];
    buildOptions.outdir = `./dist/${targetDir}`;
  }

  return watch ? esbuild.context(buildOptions).then(c => c.watch()) :
                 esbuild.build(buildOptions);
}

/**
 * The main function that builds the ADK core library.
 */
async function main() {
  const bundle = process.argv.includes('--bundle');
  const watch = process.argv.includes('--watch');

  if (watch) {
    build({
      targetDir: 'esm',
      platform: 'node',
      format: 'esm',
      bundle,
      watch: true
    });
  } else {
    await Promise.all([
      build({targetDir: 'esm', platform: 'node', format: 'esm', bundle}),
      build({targetDir: 'cjs', platform: 'node', format: 'cjs', bundle}),
      build({
        targetDir: 'web',
        platform: 'browser',
        format: 'esm',
        entry: 'index_web.ts',
        bundle
      }),
    ]);

    // Create package.json for cjs to ensure Node.js treats it as commonjs.
    await writeFile('./dist/cjs/package.json', '{"type": "commonjs"}');
  }
}

main();