/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import esbuild from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {beforeAll, describe, expect, it} from 'vitest';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

/** Entry point of the `@google/adk` barrel, relative to the repo root. */
const BARREL_ENTRY = 'core/src/index.ts';

/**
 * Packages that must load on first use rather than on `import '@google/adk'`.
 * Each one costs hundreds of milliseconds to evaluate, and an agent on the
 * default in-memory services never touches any of them.
 */
const DEFERRED_PACKAGES = ['@mikro-orm/core'];

/**
 * A package the barrel genuinely does load at startup. It proves the trace
 * below reports reachable packages at all, so an empty result cannot make the
 * deferred-package assertions pass for the wrong reason.
 */
const EAGER_PACKAGE = '@google/genai';

interface StartupGraph {
  /** Maps a module to the module that statically imports it. */
  importerOf: Map<string, string>;
  /** Maps a reachable package to the module that statically imports it. */
  packageImporter: Map<string, string>;
}

/**
 * Walks the static import graph that Node evaluates when it loads the barrel.
 *
 * `core/build.js` publishes the package with this same esbuild, so the graph
 * below is the one the published build produces after type erasure.
 */
async function traceStartupGraph(): Promise<StartupGraph> {
  const result = await esbuild.build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [BARREL_ENTRY],
    bundle: true,
    packages: 'external',
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });

  const {inputs} = result.metafile;
  const importerOf = new Map<string, string>();
  const packageImporter = new Map<string, string>();
  const visited = new Set([BARREL_ENTRY]);
  const queue = [BARREL_ENTRY];

  while (queue.length > 0) {
    const current = queue.shift()!;

    for (const imported of inputs[current].imports) {
      // A `dynamic-import` edge runs on first use, not at startup.
      if (imported.kind !== 'import-statement') {
        continue;
      }

      if (imported.external) {
        // esbuild also reports a type-erased local import as external, with a
        // relative path. That edge does not exist at runtime.
        if (
          !imported.path.startsWith('.') &&
          !packageImporter.has(imported.path)
        ) {
          packageImporter.set(imported.path, current);
        }
        continue;
      }

      if (visited.has(imported.path)) {
        continue;
      }
      visited.add(imported.path);
      importerOf.set(imported.path, current);
      queue.push(imported.path);
    }
  }

  return {importerOf, packageImporter};
}

/** Renders the chain from the barrel down to `module`, for a failure message. */
function importChain(importerOf: Map<string, string>, module: string): string {
  const chain = [module];

  for (
    let importer = importerOf.get(module);
    importer !== undefined;
    importer = importerOf.get(importer)
  ) {
    chain.unshift(importer);
  }

  return chain.join(' -> ');
}

describe('@google/adk startup import graph', () => {
  let graph: StartupGraph;

  beforeAll(async () => {
    graph = await traceStartupGraph();
  });

  it(`reaches ${EAGER_PACKAGE}`, () => {
    expect(graph.packageImporter.get(EAGER_PACKAGE)).toBeDefined();
  });

  it.each(DEFERRED_PACKAGES)('does not reach %s', (packageName) => {
    const importer = graph.packageImporter.get(packageName);
    const chain =
      importer === undefined
        ? undefined
        : `${importChain(graph.importerOf, importer)} -> ${packageName}`;

    expect(
      chain,
      `${packageName} must load on first use, not on import '@google/adk'`,
    ).toBeUndefined();
  });
});
