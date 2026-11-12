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
  exports?: Record<string, unknown>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Returns the conditions of `exports["."]`, failing if it is not an object. */
function rootConditions(manifest: PackageManifest): Record<string, unknown> {
  const conditions = manifest.exports?.['.'];
  if (!isRecord(conditions)) {
    throw new Error('exports["."] is not a conditions object');
  }
  return conditions;
}

describe('@google/adk-integrations export conditions', () => {
  const manifest = readManifest('integrations');
  const browserTypesPath = distPath(
    'integrations',
    './dist/types/index_web.d.ts',
  );

  beforeAll(() => {
    expect(
      existsSync(browserTypesPath),
      'integrations is not built; run "npm run build" before this suite',
    ).toBe(true);
  });

  it('orders the browser condition before root types in exports["."]', () => {
    // Resolvers take the first matching condition in declaration order, so a
    // root `types` listed first hides the browser declarations from TypeScript.
    const keys = Object.keys(rootConditions(manifest));

    expect(keys.indexOf('browser')).not.toBe(-1);
    expect(keys.indexOf('browser')).toBeLessThan(keys.indexOf('types'));
  });

  it('declares browser types and default entry under exports["."].browser', () => {
    expect(rootConditions(manifest)['browser']).toEqual({
      types: './dist/types/index_web.d.ts',
      default: './dist/web/index_web.js',
    });
    expect(existsSync(browserTypesPath)).toBe(true);
    expect(
      existsSync(distPath('integrations', './dist/web/index_web.js')),
    ).toBe(true);
  });

  it('keeps Node-only modules out of browser types', () => {
    const browserTypes = readFileSync(browserTypesPath, 'utf8');

    expect(browserTypes).toContain('CrewaiTool');
    expect(browserTypes).toContain('LangchainTool');
    expect(browserTypes).not.toContain('BigQuery');
    expect(browserTypes).not.toContain('Claude');
    expect(browserTypes).not.toContain('AnthropicLlm');
  });
});

describe('@google/adk-integrations/bigquery resolution', () => {
  const specifier = '@google/adk-integrations/bigquery';

  it('resolves Node ESM to the esm build', () => {
    expect(resolveWith('import', specifier)).toBe(
      distPath('integrations', './dist/esm/bigquery_analytics/index.js'),
    );
  });

  it('resolves Node CJS to the cjs build', () => {
    expect(resolveWith('require', specifier)).toBe(
      distPath('integrations', './dist/cjs/bigquery_analytics/index.js'),
    );
  });

  it('keeps the plugin out of the package root types', () => {
    const rootTypes = readFileSync(
      path.join(REPO_ROOT, 'integrations', 'dist', 'types', 'index.d.ts'),
      'utf8',
    );
    expect(rootTypes).not.toContain('bigquery_analytics');
    expect(rootTypes).not.toContain('BigQueryAgentAnalyticsPlugin');
  });
});
