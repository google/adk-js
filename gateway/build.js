/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import esbuild from 'esbuild';
import {writeFile} from 'node:fs/promises';

const platformBuildTargets = {
  'node': ['node10.4'],
};

const licenseHeaderText = `/**
  * @license
  * Copyright 2026 Google LLC
  * SPDX-License-Identifier: Apache-2.0
  */
`;

/**
 * Builds the ADK gateway library with the given options.
 *
 * Unlike the sibling packages there is no browser target: a gateway holds bot
 * credentials and terminates inbound webhooks, so there is no correct way to
 * run it in a browser and shipping a `browser` entry would only invite one.
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

  // Prepend license header to the top of the file
  if (format === 'cjs' || bundle) {
    buildOptions.banner = {js: licenseHeaderText};
  }

  if (bundle) {
    buildOptions.entryPoints = [`./src/${entry}`];
    buildOptions.outfile = `./dist/${targetDir}/index.js`;
  } else {
    buildOptions.entryPoints = ['./src/**/*.ts'];
    buildOptions.outdir = `./dist/${targetDir}`;
  }

  if (format === 'esm') {
    buildOptions.banner = {
      js:
        (buildOptions.banner?.js || '') +
        `import {createRequire as topLevelCreateRequire} from 'module';\nconst require = topLevelCreateRequire(import.meta.url);`,
    };
  }

  return watch
    ? esbuild.context(buildOptions).then((c) => c.watch())
    : esbuild.build(buildOptions);
}

/**
 * The main function that builds the ADK gateway library.
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
      watch: true,
    });
  } else {
    await Promise.all([
      build({targetDir: 'esm', platform: 'node', format: 'esm', bundle}),
      build({targetDir: 'cjs', platform: 'node', format: 'cjs', bundle}),
    ]);

    // Create package.json for cjs to ensure Node.js treats it as commonjs.
    await writeFile('./dist/cjs/package.json', '{"type": "commonjs"}');
  }
}

main();
