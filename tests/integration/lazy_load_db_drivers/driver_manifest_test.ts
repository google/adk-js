/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

interface Manifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const REPO_ROOT = process.cwd();
const OPERATIONS_FILE = join(REPO_ROOT, 'core/src/sessions/db/operations.ts');
const DIALECT_IMPORT = /(?<!\w)import\('(@mikro-orm\/[^']+)'\)/g;

function readManifest(workspace: string): Manifest {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, workspace, 'package.json'), 'utf8'),
  );
}

function mikroOrmPackages(deps: Record<string, string> = {}): string[] {
  return Object.keys(deps)
    .filter((name) => name.startsWith('@mikro-orm/'))
    .sort();
}

/** Dialect drivers that `getConnectionOptionsFromUri` loads dynamically. */
function dynamicallyImportedDialects(): string[] {
  const source = readFileSync(OPERATIONS_FILE, 'utf8');
  return [...source.matchAll(DIALECT_IMPORT)].map((match) => match[1]).sort();
}

describe('DB driver manifest contract', () => {
  it('loads at least one dialect driver dynamically', () => {
    expect(
      dynamicallyImportedDialects(),
      `no "import('@mikro-orm/...')" specifier found in ${OPERATIONS_FILE}; ` +
        'the extraction pattern is stale, so the assertions below compare empty sets',
    ).not.toEqual([]);
  });

  it('declares every dynamically imported dialect as a core peer dependency', () => {
    const {peerDependencies} = readManifest('core');

    expect(mikroOrmPackages(peerDependencies)).toEqual(
      dynamicallyImportedDialects(),
    );
  });

  it('re-declares every dialect as a runtime dependency of dev', () => {
    // Core declares the dialects only as peer dependencies, and `adk deploy`
    // generates a Dockerfile that installs just `@google/adk-devtools`, so that
    // package has to ship them for `--session_service_uri` to find a driver.
    const {dependencies} = readManifest('dev');

    expect(mikroOrmPackages(dependencies)).toEqual(
      dynamicallyImportedDialects(),
    );
  });

  it('keeps @mikro-orm/core as the only MikroORM runtime dependency of core', () => {
    const {dependencies} = readManifest('core');

    expect(mikroOrmPackages(dependencies)).toEqual(['@mikro-orm/core']);
  });
});
