/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as esbuild from 'esbuild';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

/**
 * Guards `core/dist/web`, the artifact a browser application consumes.
 *
 * Nothing checked these artifacts before, so three defects shipped in them: a
 * Node `createRequire` banner in every file, a `models/apigee_llm.js` that did
 * not parse, and a barrel that reached for `node:fs` and `google-auth-library`.
 * The existing suite runs against `src` and could not see any of them.
 */

const WEB_DIST = path.join(process.cwd(), 'core', 'dist', 'web');
const WEB_ENTRY = path.join(WEB_DIST, 'index_web.js');
const NODE_ESM_DIST = path.join(process.cwd(), 'core', 'dist', 'esm');

async function collectJsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, {withFileTypes: true})) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.js')) {
        out.push(full);
      }
    }
  };
  await walk(dir);
  return out;
}

describe('web build output', () => {
  let webFiles: string[] = [];

  beforeAll(async () => {
    // Requires `npm run build`, which CI runs before the test step.
    await fs.access(WEB_DIST);
    webFiles = await collectJsFiles(WEB_DIST);
    expect(webFiles.length).toBeGreaterThan(0);
  });

  it('resolves the path declared in the package browser field', async () => {
    const pkg = JSON.parse(
      await fs.readFile(
        path.join(process.cwd(), 'core', 'package.json'),
        'utf8',
      ),
    ) as {browser?: string};
    expect(pkg.browser).toBeDefined();
    const target = path.join(process.cwd(), 'core', pkg.browser!);
    await expect(fs.access(target)).resolves.toBeUndefined();
  });

  it('contains no Node-only createRequire banner', async () => {
    const offenders: string[] = [];
    for (const file of webFiles) {
      const source = await fs.readFile(file, 'utf8');
      if (source.includes('topLevelCreateRequire')) {
        offenders.push(path.relative(WEB_DIST, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('still emits the createRequire banner for the Node ESM build', async () => {
    // Guards against fixing the browser build by dropping the banner outright.
    const nodeFiles = await collectJsFiles(NODE_ESM_DIST);
    const withBanner: string[] = [];
    for (const file of nodeFiles) {
      const source = await fs.readFile(file, 'utf8');
      if (source.includes('topLevelCreateRequire')) {
        withBanner.push(file);
      }
    }
    expect(withBanner.length).toBeGreaterThan(0);
  });

  it('emits only parseable JavaScript', async () => {
    const unparseable: string[] = [];
    for (const file of webFiles) {
      const source = await fs.readFile(file, 'utf8');
      try {
        await esbuild.transform(source, {loader: 'js', format: 'esm'});
      } catch {
        unparseable.push(path.relative(WEB_DIST, file));
      }
    }
    expect(unparseable).toEqual([]);
  });
});

/**
 * Bundles the whole web build the way an application would, then runs it.
 *
 * Static checks on the emitted files cannot catch output that bundles and then
 * throws on import, or a primitive that is broken once compiled for the
 * browser, so this imports the bundle and drives the public API.
 */
describe('the web bundle works in a browser toolchain', () => {
  let tmpDir = '';
  let bundlePath = '';

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-web-bundle-'));
    bundlePath = path.join(tmpDir, 'app.mjs');
    // Rejects on error, so a failure here means the build is unusable.
    await esbuild.build({
      entryPoints: [WEB_ENTRY],
      outfile: bundlePath,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'chrome138',
      logLevel: 'silent',
    });
  }, 60000);

  afterAll(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, {recursive: true, force: true});
    }
  });

  it('bundles the entire web entry point for the browser', async () => {
    const stat = await fs.stat(bundlePath);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('exposes the core primitives once bundled', async () => {
    const adk = await import(pathToFileURL(bundlePath).href);
    for (const symbol of [
      'LlmAgent',
      'SequentialAgent',
      'ParallelAgent',
      'LoopAgent',
      'FunctionTool',
      'Runner',
      'InMemorySessionService',
      'BaseLlm',
    ]) {
      expect(typeof adk[symbol], symbol).toBe('function');
    }
  });

  it('excludes the Node-only surface from the browser entry point', async () => {
    const adk = await import(pathToFileURL(bundlePath).href);
    // These reach node:fs, child_process, google-auth-library or
    // @google-cloud/vertexai, and are exported from index.ts for Node only.
    for (const symbol of [
      'loadAllSkillsInDir',
      'OpenAPIToolset',
      'UnsafeLocalCodeExecutor',
      'GcsArtifactService',
      'VertexAiMemoryBankService',
      'loadWebPage',
    ]) {
      expect(adk[symbol], symbol).toBeUndefined();
    }
  });

  it('builds a working agent and tool from the bundle', async () => {
    const adk = await import(pathToFileURL(bundlePath).href);

    const tool = new adk.FunctionTool({
      name: 'add',
      description: 'adds two numbers',
      parameters: {
        type: 'object',
        properties: {a: {type: 'number'}, b: {type: 'number'}},
        required: ['a', 'b'],
      },
      execute: async ({a, b}: {a: number; b: number}) => ({sum: a + b}),
    });

    const agent = new adk.LlmAgent({
      name: 'browser_agent',
      model: 'gemini-2.0-flash',
      instruction: 'You are a calculator.',
      tools: [tool],
    });
    expect(agent.name).toBe('browser_agent');
    expect(agent.tools).toHaveLength(1);

    const sessions = new adk.InMemorySessionService();
    const session = await sessions.createSession({
      appName: 'browser_app',
      userId: 'user',
    });
    expect(session.id).toBeTruthy();

    const result = await tool.runAsync({
      args: {a: 2, b: 3},
      context: undefined,
    });
    expect(result).toEqual({sum: 5});
  });
});
