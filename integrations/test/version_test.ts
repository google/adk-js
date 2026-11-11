/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {version} from '@google/adk-integrations';
import {readFileSync} from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// release-please rewrites both package.json and src/version.ts on every
// release (see the `x-release-please-version` marker), so asserting a
// hardcoded literal here goes stale the moment a release lands. The invariant
// worth testing is that the two stay in lockstep.
const packageJsonPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../package.json',
);
const {version: packageVersion} = JSON.parse(
  readFileSync(packageJsonPath, 'utf8'),
) as {version: string};

describe('version', () => {
  it('should match the version declared in package.json', () => {
    expect(version).toBe(packageVersion);
  });

  it('should be a semver string', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  });
});
