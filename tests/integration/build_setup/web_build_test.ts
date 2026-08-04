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
 * Guards the browser build output in core/dist/web.
 *
 * Two defects shipped in it because nothing checked the artifacts:
 *
 *  - every file carried a Node `createRequire` banner, so a browser bundler
 *    reported an unresolvable `module` import ~187 times;
 *  - `models/apigee_llm.js` did not parse at all, because the browser target
 *    downlevelled an async generator and emitted `super` inside a closure.
 *
 * Both were invisible to the existing suite, which runs against src.
 */

const WEB_DIST = path.join(process.cwd(), 'core', 'dist', 'web');
const NODE_ESM_DIST = path.join(process.cwd(), 'core', 'dist', 'esm');

/** Every .js file under `dir`. */
async function collectJsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, {withFileTypes: true});
    for (const entry of entries) {
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
    // Guards against fixing the browser build by removing the banner outright.
    const nodeFiles = await collectJsFiles(NODE_ESM_DIST);
    const withBanner = [];
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

  it('imports no Node builtin that has no browser equivalent', async () => {
    // Scoped to `module` for now. dist/web still reaches for winston and
    // node:async_hooks; widen this list as those are addressed.
    const forbidden = ["from 'module'", 'from "module"'];
    const offenders: string[] = [];
    for (const file of webFiles) {
      const source = await fs.readFile(file, 'utf8');
      if (forbidden.some((needle) => source.includes(needle))) {
        offenders.push(path.relative(WEB_DIST, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Bundles the built browser output the way an application would, then runs it.
 *
 * Checking the files parse is necessary but not sufficient — it would not catch
 * output that bundles and then throws on import, or a primitive that is broken
 * once compiled for the browser. These entry points are bundled with
 * `--platform=browser` and actually executed.
 *
 * The list is short because most of dist/web still cannot be bundled: the
 * barrel pulls in `skills/loader` (node:fs, node:path), and the logger pulls in
 * winston. Add entry points here as those are resolved — `agents/llm_agent.js`
 * and `runner/runner.js` are the two worth having next, and both are one
 * dependency away.
 */
describe('web build output is usable by a browser bundler', () => {
  /** Entry points that must bundle for the browser with zero errors. */
  const BUNDLEABLE = ['events/event.js', 'tools/function_tool.js'];

  let tmpDir = '';

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-web-bundle-'));
  });

  afterAll(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, {recursive: true, force: true});
    }
  });

  /** Bundles one entry for the browser and returns the output file. */
  async function bundleForBrowser(entry: string): Promise<string> {
    const outfile = path.join(tmpDir, entry.replace(/[/\\]/g, '_'));
    await esbuild.build({
      entryPoints: [path.join(WEB_DIST, entry)],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'chrome138',
      logLevel: 'silent',
    });
    return outfile;
  }

  it.each(BUNDLEABLE)('bundles %s for the browser', async (entry) => {
    // esbuild.build rejects on error, so reaching the assertion is the result.
    const outfile = await bundleForBrowser(entry);
    const stat = await fs.stat(outfile);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('produces a FunctionTool that still works once compiled', async () => {
    const outfile = await bundleForBrowser('tools/function_tool.js');
    const {FunctionTool, isFunctionTool} = await import(
      pathToFileURL(outfile).href
    );

    const tool = new FunctionTool({
      name: 'add',
      description: 'adds two numbers',
      parameters: {
        type: 'object',
        properties: {a: {type: 'number'}, b: {type: 'number'}},
        required: ['a', 'b'],
      },
      execute: async ({a, b}: {a: number; b: number}) => ({sum: a + b}),
    });

    expect(isFunctionTool(tool)).toBe(true);
    expect(tool.name).toBe('add');

    // The declaration is what a model actually receives.
    const declaration = tool._getDeclaration();
    expect(declaration?.name).toBe('add');
    expect(declaration?.parameters).toEqual({
      type: 'object',
      properties: {a: {type: 'number'}, b: {type: 'number'}},
      required: ['a', 'b'],
    });

    const result = await tool.runAsync({
      args: {a: 2, b: 3},
      context: undefined,
    });
    expect(result).toEqual({sum: 5});
  });
});
