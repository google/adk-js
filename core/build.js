/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import esbuild from 'esbuild';
import {writeFile} from 'node:fs/promises';

const platformBuildTargets = {
  'node': ['node10.4'],
  // Safari 14.1, not 12: Safari below 14.1 mis-evaluates some destructuring
  // patterns, and esbuild has no lowering pass for destructuring, so asking for
  // an older Safari now fails the web build outright rather than emitting
  // anything. The same reasoning that ruled out Safari 11 applies — the library
  // uses async generators throughout, and Safari 11's lowering of
  // `yield* super.method()` emitted `__yieldStar(super.method())` in a scope
  // where `super` is a syntax error, so `models/apigee_llm.js` did not parse at
  // all. Neither version was ever really supported; the target only said so.
  'browser': ['chrome63', 'firefox57', 'safari14.1'],
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
    // The web target ships a self-contained bundle so a browser can load it
    // directly; bare specifiers like '@google/genai' are not resolvable there.
    packages: platform === 'browser' ? 'bundle' : 'external',
    logLevel: 'info',
  };

  // esbuild rejects `alias` unless bundling, so these only take effect on the
  // always-bundled web target.
  if (platform === 'browser') {
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
    // Keep the emitted filename aligned with the entry so package.json's
    // "browser" field keeps resolving to dist/web/index_web.js.
    buildOptions.outfile = `./dist/${targetDir}/${entry.replace(/\.ts$/, '.js')}`;
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
