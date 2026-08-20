/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Guards the shape of `core/package.json` that keeps `npm install @google/adk`
 * small.
 *
 * npm 7+ installs `peerDependencies` automatically unless they are marked
 * optional, so a peer added without a matching `peerDependenciesMeta` entry
 * silently lands in every hello-world install — that is exactly how five SQL
 * drivers (one of which compiles native code) ended up in a tree that never
 * touches a database. These assertions fail the build instead.
 */

import {readdirSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const CORE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface CorePackageJson {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta?: Record<string, {optional?: boolean}>;
  exports: Record<string, Record<string, string> | string>;
}

const pkg: CorePackageJson = JSON.parse(
  readFileSync(join(CORE_DIR, 'package.json'), 'utf8'),
);

/**
 * Packages that must stay out of `dependencies`.
 *
 * Each backs a single situational subsystem, is loaded lazily at the point of
 * use, and is far too heavy to impose on an application that never reaches
 * that subsystem.
 */
const OPTIONAL_SUBSYSTEM_PEERS = [
  '@google-cloud/opentelemetry-cloud-monitoring-exporter',
  '@google-cloud/opentelemetry-cloud-trace-exporter',
  '@google-cloud/storage',
  '@mikro-orm/mariadb',
  '@mikro-orm/mssql',
  '@mikro-orm/mysql',
  '@mikro-orm/postgresql',
  '@mikro-orm/sqlite',
  '@modelcontextprotocol/sdk',
  'express',
];

describe('core/package.json install weight', () => {
  it.each(Object.keys(pkg.peerDependencies))(
    'declares the peer dependency %s optional',
    (peer) => {
      // Without this, npm 7+ downloads the peer for every consumer.
      expect(pkg.peerDependenciesMeta?.[peer]?.optional).toBe(true);
    },
  );

  it.each(OPTIONAL_SUBSYSTEM_PEERS)(
    '%s is an optional peer, not a hard dependency',
    (name) => {
      expect(pkg.dependencies).not.toHaveProperty(name);
      expect(pkg.peerDependencies).toHaveProperty(name);
    },
  );

  it.each([
    '@google-cloud/opentelemetry-cloud-monitoring-exporter',
    '@google-cloud/opentelemetry-cloud-trace-exporter',
    '@google-cloud/storage',
    '@mikro-orm/sqlite',
    '@modelcontextprotocol/sdk',
    'express',
  ])(
    '%s is still a devDependency so the repo can build and test against it',
    (name) => {
      // The peers whose types `core/src` references, and the one SQL driver
      // the database tests actually run against. The other four drivers are
      // interchangeable alternatives to `@mikro-orm/sqlite` and are not
      // needed to build or test this package.
      expect(pkg.devDependencies).toHaveProperty(name);
    },
  );

  it('has no peerDependenciesMeta entry without a matching peer', () => {
    expect(Object.keys(pkg.peerDependenciesMeta ?? {}).sort()).toEqual(
      Object.keys(pkg.peerDependencies).sort(),
    );
  });
});

describe('core/package.json subpath exports', () => {
  // `.` is the root entry, and `./dist/web/*` is a wildcard passthrough for the
  // browser bundle whose target is a glob, not a single source module. Neither
  // is a situational subsystem entry point, so both stay out of these checks.
  const subpaths = Object.entries(pkg.exports).filter(
    ([subpath, target]) =>
      subpath !== '.' && !subpath.includes('*') && typeof target === 'object',
  ) as Array<[string, Record<string, string>]>;

  it('exports the situational subsystems as their own entry points', () => {
    expect(subpaths.map(([subpath]) => subpath).sort()).toEqual([
      './a2a',
      './artifacts/gcs',
      './sessions/database',
      './telemetry/gcp',
      './tools/mcp',
    ]);
  });

  it.each(subpaths)(
    '%s maps every condition onto a module that exists in src',
    (_subpath, conditions) => {
      for (const target of Object.values(conditions)) {
        // `./dist/<esm|cjs|types>/a/b.<js|d.ts>` is emitted from
        // `./src/a/b.ts`, so the source is what has to exist here: `dist` is a
        // build artifact and is absent on a clean checkout.
        const source = target
          .replace(/^\.\/dist\/(esm|cjs|types)\//, './src/')
          .replace(/\.d\.ts$|\.js$/, '.ts');
        expect(() =>
          readFileSync(join(CORE_DIR, source), 'utf8'),
        ).not.toThrow();
      }
    },
  );

  it('resolves ./package.json, which tooling reads for the version', () => {
    expect(pkg.exports['./package.json']).toBe('./package.json');
  });
});

/** Every `.ts` file under `core/src`, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('optional peers are not imported at module load', () => {
  const sources = sourceFiles(join(CORE_DIR, 'src')).map((file) => ({
    file,
    text: readFileSync(file, 'utf8'),
  }));

  it.each(OPTIONAL_SUBSYSTEM_PEERS)(
    'no source file has a value import of %s',
    (name) => {
      // A value `import` anywhere in the graph reachable from `src/index.ts`
      // makes the whole package unloadable without the peer installed, which
      // is the failure mode the lazy loading exists to prevent. `import type`
      // is erased at compile time and is therefore fine.
      const valueImport = new RegExp(
        String.raw`(^|\n)import\s+(?!type\s)[^;]*?from\s*'${name.replace('/', '\\/')}(\/[^']*)?'`,
      );
      const offenders = sources
        .filter(({text}) => valueImport.test(text))
        .map(({file}) => file);
      expect(offenders).toEqual([]);
    },
  );
});
