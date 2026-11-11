/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Imported by package specifier, not by relative path: the export only has
// value if a consumer's `import` resolves it, so the test resolves it the same
// way.
import {version} from '@google/adk-devtools';
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

const devPackageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {version: string};

describe('@google/adk-devtools entry point', () => {
  it('re-exports the version release-please writes into dev/package.json', () => {
    expect(version).toBe(devPackageJson.version);
  });

  it('exports a semver version string', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
