/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {beforeAll, describe, expect, it} from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Loads a client FunctionTool through a ToolboxToolset of one build and checks
 * `isToolboxTool` in the other. Runs in a child process because every vitest
 * project aliases `@google/adk` to `core/src`, which hides the split builds.
 */
const SCRIPT = `
import {createRequire} from 'node:module';
const builds = {
  esm: await import('@google/adk'),
  cjs: createRequire(process.cwd() + '/')('@google/adk'),
};
const [loader, checker] = process.argv.slice(1);
const adk = builds[loader];
const clientTool = new adk.FunctionTool({
  name: 'lookup',
  description: 'Looks up a value.',
  execute: async () => 'ok',
});
const [tool] = await new adk.ToolboxToolset({
  serverUrl: 'http://127.0.0.1:5000',
  toolNames: ['lookup'],
  client: {loadTool: async () => clientTool, close: async () => {}},
}).getTools({});
process.stdout.write(
  JSON.stringify({
    sameInstance: tool === clientTool,
    toolboxTool: builds[checker].isToolboxTool(tool),
  }),
);
`;

function provenance(loader: string, checker: string) {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', SCRIPT, loader, checker],
    {cwd: REPO_ROOT, encoding: 'utf8'},
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    sameInstance: boolean;
    toolboxTool: boolean;
  };
}

describe('Toolbox tool provenance across the ESM and CommonJS builds', () => {
  beforeAll(() => {
    for (const build of ['esm', 'cjs']) {
      expect(
        existsSync(path.join(REPO_ROOT, 'core', 'dist', build, 'index.js')),
        `core is not built; run "npm run build" before this suite`,
      ).toBe(true);
    }
  });

  it.each([
    ['esm', 'cjs'],
    ['cjs', 'esm'],
    ['esm', 'esm'],
    ['cjs', 'cjs'],
  ])('recognizes a tool loaded by %s in %s', (loader, checker) => {
    expect(provenance(loader, checker)).toEqual({
      sameInstance: true,
      toolboxTool: true,
    });
  });
});
