/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {beforeAll, describe, expect, it} from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The fields of a published manifest this suite reads. */
interface PackageManifest {
  browser: string;
}

/** A published package and the workspace directory `node_modules` links to. */
interface PublishedPackage {
  specifier: string;
  dir: string;
}

const PACKAGES: PublishedPackage[] = [
  {specifier: '@google/adk', dir: 'core'},
  {specifier: '@google/adk-integrations', dir: 'integrations'},
];

/** The resolver personas a consumer can present to the `exports` map. */
type ResolveMode = 'browser' | 'import' | 'require';

const SPECIFIER_ENV_VAR = 'ADK_RESOLVE_SPECIFIER';

const ESM_SCRIPT = `process.stdout.write(import.meta.resolve(process.env.${SPECIFIER_ENV_VAR}))`;

const CJS_SCRIPT = `process.stdout.write(require('node:url').pathToFileURL(require.resolve(process.env.${SPECIFIER_ENV_VAR})).href)`;

const NODE_ARGS: Record<ResolveMode, string[]> = {
  browser: ['--conditions=browser', '--input-type=module', '-e', ESM_SCRIPT],
  import: ['--input-type=module', '-e', ESM_SCRIPT],
  require: ['--input-type=commonjs', '-e', CJS_SCRIPT],
};

/**
 * npm links a workspace package into `node_modules`, and a resolver may report
 * either side of that link, so both sides of a path comparison are normalized.
 * A path that does not exist is returned unchanged, which keeps a missing
 * target reportable as a mismatch rather than as an `ENOENT`.
 */
function normalize(target: string): string {
  return existsSync(target) ? realpathSync(target) : target;
}

/**
 * Resolves `specifier` in a child Node process and returns the absolute path.
 *
 * Every vitest project aliases `@google/adk` to `core/src`, so resolving in
 * process would bypass the `exports` map and pass whatever the manifest says.
 * `--conditions=browser` drives Node's own spec-compliant `exports` resolver,
 * which is the condition matching webpack and Vite implement.
 */
function resolveWith(mode: ResolveMode, specifier: string): string {
  const result = spawnSync(process.execPath, NODE_ARGS[mode], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {...process.env, [SPECIFIER_ENV_VAR]: specifier},
  });

  expect(
    result.status,
    `"${mode}" resolution of "${specifier}" failed: ${result.stderr}`,
  ).toBe(0);

  return normalize(fileURLToPath(result.stdout));
}

function readManifest(dir: string): PackageManifest {
  const manifestPath = path.join(REPO_ROOT, dir, 'package.json');
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
}

/** Resolves a manifest-relative target, such as `./dist/esm/index.js`. */
function distPath(dir: string, target: string): string {
  return normalize(path.resolve(REPO_ROOT, dir, target));
}

describe.each(PACKAGES)('$specifier resolution', ({specifier, dir}) => {
  const manifest = readManifest(dir);

  beforeAll(() => {
    expect(
      existsSync(distPath(dir, './dist/esm/index.js')),
      `${dir} is not built; run "npm run build" before this suite`,
    ).toBe(true);
  });

  it('resolves the browser condition to the legacy "browser" target', () => {
    expect(resolveWith('browser', specifier)).toBe(
      distPath(dir, manifest.browser),
    );
  });

  it('resolves the browser condition to a file that exists', () => {
    // `import.meta.resolve` never checks the target exists, but a bundler does:
    // a missing target under an `exports` map is a hard resolution error.
    expect(existsSync(resolveWith('browser', specifier))).toBe(true);
  });

  it('leaves Node ESM resolution on the esm build', () => {
    expect(resolveWith('import', specifier)).toBe(
      distPath(dir, './dist/esm/index.js'),
    );
  });

  it('leaves Node CJS resolution on the cjs build', () => {
    expect(resolveWith('require', specifier)).toBe(
      distPath(dir, './dist/cjs/index.js'),
    );
  });

  it('exposes the web build under the ./dist/web/* subpath', () => {
    const resolved = resolveWith(
      'import',
      `${specifier}/dist/web/index_web.js`,
    );

    expect(resolved).toBe(distPath(dir, './dist/web/index_web.js'));
    expect(existsSync(resolved)).toBe(true);
  });
});
