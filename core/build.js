/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import esbuild from 'esbuild';
import {writeFile} from 'node:fs/promises';

const platformBuildTargets = {
  'node': ['node10.4'],
  // Safari 12, not 11: the library uses async generators throughout, and they
  // are ES2018. Targeting Safari 11 asked esbuild to lower them, and its
  // lowering of `yield* super.method()` emits `__yieldStar(super.method())` in
  // a scope where `super` is a syntax error — so `models/apigee_llm.js` in the
  // web build did not parse at all. Safari 11 was never really supported; the
  // target only said it was.
  'browser': ['chrome63', 'firefox57', 'safari12'],
};

const licenseHeaderText = `/**
  * @license
  * Copyright 2026 Google LLC
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
    // Minification renames classes, and we report those names at runtime:
    // `@experimental` logs `target.name`, which otherwise reads "Class oR is
    // experimental". User code that logs `constructor.name` sees the same
    // mangling, so keep the original names in the bundle.
    keepNames: true,
    sourcemap: bundle,
    packages: 'external',
    logLevel: 'info',
  };

  if (platform === 'browser' && bundle) {
    buildOptions.alias = {
      'node:async_hooks': './src/utils/async_hooks_shim.ts',
      'node:crypto': './src/utils/crypto_shim.ts',
    };
  }

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

  // Node ESM only. The shim exists so an ESM build can reach a CommonJS
  // dependency, which is a Node concern — and adding it to the *browser* ESM
  // build put `import {createRequire} from 'module'` at the top of every file
  // in `dist/web`, so the browser build could only be loaded by Node. Bundlers
  // targeting a browser, a worker or any edge runtime failed to resolve
  // 'module' and stopped.
  if (format === 'esm' && platform !== 'browser') {
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
      watch: true,
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
        bundle,
      }),
    ]);

    // Create package.json for cjs to ensure Node.js treats it as commonjs.
    await writeFile('./dist/cjs/package.json', '{"type": "commonjs"}');
  }
}

main();
