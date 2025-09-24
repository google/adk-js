/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import esbuild from 'esbuild';
import { exec } from 'child_process';

const copyAssets = () => {
  return new Promise((resolve, reject) => {
    exec('cp -r ./src/browser ./dist/browser', (err) => {
      if (err) {
        reject(err);
        return;
      }

      resolve();
    })
  });
}

/**
 * Builds the ADK core library with the given options.
 *
 * @param {{
 *   entryPoints: string[];
 *   outdir: string;
 *   watch: boolean,
 *   minify: boolean
 * }} options - The build options.
 * @return {!Promise} A promise that resolves when the build is complete.
 */
function build({
  entryPoints,
  outdir,
  watch,
  minify,
}) {
  const buildOptions = {
    entryPoints,
    outdir,
    target: ['node10.4'],
    platform: 'node',
    format: 'esm',
    minify: minify,
    sourcemap: minify,
    packages: 'external',
    logLevel: 'info',
    banner: {
      js: "import { createRequire as topLevelCreateRequire } from \"module\"; const require = topLevelCreateRequire(import.meta.url);",
    },
  };

  return watch ? esbuild.context(buildOptions).then(c => c.watch()) :
                 esbuild.build(buildOptions);
}

/**
 * The main function that builds the ADK core library.
 */
async function main() {
  const watch = process.argv.includes('--watch');

  if (watch) {
    build({
      entryPoints: ["./src/**/*.ts"],
      outdir: './dist',
      watch: true,
      minify: false,
    });
  } else {
    Promise.all([
      build({
        entryPoints: ["./src/**/*.ts"],
        outdir: './dist',
        minify: false,
       }),
       build({
        entryPoints: ["./src/**/*.tsx"],
        outdir: './dist',
        minify: false,
       }),
       build({
        entryPoints: ['./samples/**.ts'],
        outdir: './dist/samples',
        minify: false,
       }),
       copyAssets(),
    ]);
  }
}

main();