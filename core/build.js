/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import esbuild from 'esbuild';
import {writeFile} from 'node:fs/promises';

const platformBuildTargets = {
  'node': ['node10.4'],
  // Async generators are native from Chrome 63 / Safari 12. Targeting anything
  // older makes esbuild downlevel them into an __asyncGenerator closure, and
  // `super` is not valid inside that closure — so a class like ApigeeLlm, which
  // does `yield* super.generateContentAsync(...)`, emits output that no
  // downstream bundler can parse.
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
    sourcemap: bundle,
    packages: 'external',
    logLevel: 'info',
  };

  // esbuild rejects `alias` unless bundling, so these only take effect on the
  // always-bundled web target.
  if (platform === 'browser') {
    buildOptions.alias = {
      'node:async_hooks': './src/utils/async_hooks_shim.ts',
      'winston': './src/utils/winston_shim.ts',
    };
  }

  // Prepend license header to the top of the file
  if (format === 'cjs' || bundle) {
    buildOptions.banner = {js: licenseHeaderText};
  }

  if (bundle) {
    buildOptions.entryPoints = [`./src/${entry}`];
    // Keep the emitted filename aligned with the entry so package.json's
    // "browser" field keeps resolving to dist/web/index_web.js.
    buildOptions.outfile = `./dist/${targetDir}/${entry.replace(/\.ts$/, '.js')}`;
  } else {
    buildOptions.entryPoints = ['./src/**/*.ts'];
    buildOptions.outdir = `./dist/${targetDir}`;
  }

  // Node-only. `module` has no browser equivalent, and the web build never
  // calls require(), so emitting this into dist/web produced an unresolvable
  // import in all ~187 of its files.
  if (format === 'esm' && platform === 'node') {
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
      // The web target is always bundled. Node built-ins can only be swapped
      // for browser shims through esbuild's `alias`, which requires bundling.
      build({
        targetDir: 'web',
        platform: 'browser',
        format: 'esm',
        entry: 'index_web.ts',
        bundle: true,
      }),
    ]);

    // Create package.json for cjs to ensure Node.js treats it as commonjs.
    await writeFile('./dist/cjs/package.json', '{"type": "commonjs"}');
  }
}

main();
