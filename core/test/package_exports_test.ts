/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

/** The subset of `core/package.json` this suite pins. */
interface CoreManifest {
  browser: string;
  exports: {
    '.': Record<string, string>;
    './dist/web/*': Record<string, string>;
  };
}

/** Resolved from `import.meta.url` because vitest runs from the repo root. */
const MANIFEST_PATH = fileURLToPath(
  new URL('../package.json', import.meta.url),
);

const manifest = JSON.parse(
  readFileSync(MANIFEST_PATH, 'utf8'),
) as CoreManifest;

const WEB_ENTRY = './dist/web/index_web.js';

describe('core package exports', () => {
  it('declares "browser" after "types" and before "import" and "require"', () => {
    // Conditions match in declaration order and the first match wins, so a
    // "browser" condition placed after "import" never fires for an ESM browser
    // bundle: the manifest would look fixed while still resolving dist/esm.
    const conditions = Object.keys(manifest.exports['.']);

    expect(conditions[0]).toBe('types');
    expect(conditions).toContain('browser');
    expect(conditions.indexOf('browser')).toBeLessThan(
      conditions.indexOf('import'),
    );
    expect(conditions.indexOf('browser')).toBeLessThan(
      conditions.indexOf('require'),
    );
  });

  it('points the "browser" condition at the web build', () => {
    expect(manifest.exports['.'].browser).toBe(WEB_ENTRY);
  });

  it('leaves the TypeScript, ESM and CJS conditions untouched', () => {
    expect(manifest.exports['.'].types).toBe('./dist/types/index.d.ts');
    expect(manifest.exports['.'].import).toBe('./dist/esm/index.js');
    expect(manifest.exports['.'].require).toBe('./dist/cjs/index.js');
    expect(manifest.exports['.'].default).toBe('./dist/esm/index.js');
  });

  it('keeps the legacy top-level "browser" field in agreement', () => {
    expect(manifest.browser).toBe(WEB_ENTRY);
    expect(manifest.browser).toBe(manifest.exports['.'].browser);
  });

  it('exposes ./dist/web/* with its declarations', () => {
    expect(manifest.exports['./dist/web/*']).toEqual({
      types: './dist/types/*',
      default: './dist/web/*',
    });
    // "types" first for the same ordering reason: TypeScript would otherwise
    // match "default" and look for a .d.ts next to dist/web/*.js, which the
    // build emits to dist/types instead.
    expect(Object.keys(manifest.exports['./dist/web/*'])[0]).toBe('types');
  });
});
