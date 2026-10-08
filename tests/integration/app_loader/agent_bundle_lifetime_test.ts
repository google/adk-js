/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
} from '@google/adk';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {AdkApiServer} from '../../../dev/src/server/adk_api_server.js';
import {AgentLoader} from '../../../dev/src/utils/agent_loader.js';

const HOOK_TIMEOUT = 120000;
const TEST_TIMEOUT = 60000;

declare global {
  var __adkTestOnToolExecute:
    ((bundlePath: string) => Promise<void> | void) | undefined;
}

/**
 * Writes a TypeScript agent project to `dir` whose tool reads its own
 * compiled bundle file (`__filename`) at execution time.
 *
 * This reproduces the exact failure mode of issue #969: the agent has a
 * `FunctionTool` that loads a resource relative to the compiled bundle
 * during `/run` or `/run_sse` (for example, `node_modules` or a sibling
 * asset resolved from the temp compilation directory). If the compiled
 * bundle is deleted before `runner.runAsync()` executes, the tool sees a
 * missing file (`ENOENT` / `MODULE_NOT_FOUND`).
 */
async function writeAgentProject(dir: string, repoRoot: string): Promise<void> {
  const agentDir = path.join(dir, 'bundle_check_agent');
  await fsp.mkdir(agentDir, {recursive: true});

  await fsp.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({name: 'bundle-lifetime-test', private: true}, null, 2),
  );

  // Symlink root node_modules so AgentLoader's linkProjectNodeModules finds it
  // without running `npm install`.
  await fsp.symlink(
    path.join(repoRoot, 'node_modules'),
    path.join(dir, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const agentTs = `
import {BaseLlm, FunctionTool, LlmAgent} from '@google/adk';
import * as fs from 'node:fs';
import {z} from 'zod';

class EchoMockLlm extends BaseLlm {
  constructor() {
    super({model: 'mock-llm'});
  }

  async *generateContentAsync(llmRequest: any): AsyncGenerator<any, void, unknown> {
    const contents = llmRequest.contents || [];
    const lastContent = contents[contents.length - 1];
    const hasFunctionResponse = lastContent?.parts?.some(
      (p: any) => p.functionResponse,
    );

    if (!hasFunctionResponse) {
      yield {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'check_bundle_exists',
                args: {},
              },
            },
          ],
        },
      };
      return;
    }

    const fnResp = lastContent.parts.find((p: any) => p.functionResponse)
      .functionResponse;
    const result = fnResp.response;
    yield {
      content: {
        role: 'model',
        parts: [
          {
            text: \`BUNDLE_EXISTS:\${result.exists}:\${result.bundlePath}\`,
          },
        ],
      },
    };
  }

  async connect(): Promise<any> {
    throw new Error('Not implemented');
  }
}

const checkBundleExistsTool = new FunctionTool({
  name: 'check_bundle_exists',
  description: 'Checks whether the compiled bundle still exists on disk.',
  parameters: z.object({}),
  execute: async () => {
    const hook = (
      globalThis as {
        __adkTestOnToolExecute?: (bundlePath: string) => Promise<void> | void;
      }
    ).__adkTestOnToolExecute;
    if (hook) {
      await hook(__filename);
    }
    const exists = fs.existsSync(__filename);
    return {
      bundlePath: __filename,
      exists,
    };
  },
});

export const rootAgent = new LlmAgent({
  name: 'bundle_check_agent',
  description: 'Verifies compiled bundle lifetime during execution.',
  model: new EchoMockLlm(),
  tools: [checkBundleExistsTool],
});
`;

  await fsp.writeFile(path.join(agentDir, 'agent.ts'), agentTs, 'utf-8');
}

describe('Agent bundle lifetime during AdkApiServer requests (issues #969, #1002)', () => {
  const repoRoot = process.cwd();
  let tempDir: string;
  let loader: AgentLoader;
  let server: AdkApiServer;
  let sessionService: InMemorySessionService;

  beforeAll(async () => {
    tempDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'adk_bundle_lifetime_test_'),
    );
    await writeAgentProject(tempDir, repoRoot);

    loader = new AgentLoader(tempDir);
    sessionService = new InMemorySessionService();
    server = new AdkApiServer({
      agentLoader: loader,
      sessionService,
      memoryService: new InMemoryMemoryService(),
      artifactService: new InMemoryArtifactService(),
      port: 0,
    });
    await server.start();
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    globalThis.__adkTestOnToolExecute = undefined;
    await server?.stop();
    await loader?.disposeAll();
    if (tempDir && fs.existsSync(tempDir)) {
      await fsp.rm(tempDir, {recursive: true, force: true});
    }
  }, HOOK_TIMEOUT);

  function extractReplyTexts(events: Event[]): string[] {
    const texts: string[] = [];
    for (const event of events) {
      for (const part of event.content?.parts ?? []) {
        if (part.text) {
          texts.push(part.text);
        }
      }
    }
    return texts;
  }

  it(
    'keeps compiled bundle on disk during /run tool execution',
    async () => {
      await sessionService.createSession({
        appName: 'bundle_check_agent',
        userId: 'user1',
        sessionId: 'sess-run',
      });

      const response = await fetch(`${server.url}/run`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          appName: 'bundle_check_agent',
          userId: 'user1',
          sessionId: 'sess-run',
          newMessage: {
            role: 'user',
            parts: [{text: 'Check bundle'}],
          },
        }),
      });

      expect(response.status).toBe(200);
      const events = (await response.json()) as Event[];
      const texts = extractReplyTexts(events);
      expect(texts.some((t) => t.startsWith('BUNDLE_EXISTS:true:'))).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps compiled bundle on disk during /run_sse tool execution',
    async () => {
      await sessionService.createSession({
        appName: 'bundle_check_agent',
        userId: 'user1',
        sessionId: 'sess-sse',
      });

      const response = await fetch(`${server.url}/run_sse`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          appName: 'bundle_check_agent',
          userId: 'user1',
          sessionId: 'sess-sse',
          newMessage: {
            role: 'user',
            parts: [{text: 'Check bundle via SSE'}],
          },
        }),
      });

      expect(response.status).toBe(200);
      const rawSse = await response.text();
      const events: Event[] = rawSse
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice('data: '.length)) as Event);

      const texts = extractReplyTexts(events);
      expect(texts.some((t) => t.startsWith('BUNDLE_EXISTS:true:'))).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps compiled bundle on disk across multiple sequential /run requests',
    async () => {
      await sessionService.createSession({
        appName: 'bundle_check_agent',
        userId: 'user1',
        sessionId: 'sess-multi',
      });

      for (let i = 0; i < 3; i++) {
        const response = await fetch(`${server.url}/run`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            appName: 'bundle_check_agent',
            userId: 'user1',
            sessionId: 'sess-multi',
            newMessage: {
              role: 'user',
              parts: [{text: `Turn ${i}`}],
            },
          }),
        });

        expect(response.status).toBe(200);
        const events = (await response.json()) as Event[];
        const texts = extractReplyTexts(events);
        expect(texts.some((t) => t.startsWith('BUNDLE_EXISTS:true:'))).toBe(
          true,
        );
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps compiled bundle on disk during /api/reasoning_engine execution',
    async () => {
      const response = await fetch(`${server.url}/api/reasoning_engine`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          input: {
            appName: 'bundle_check_agent',
            userId: 'user1',
            sessionId: 'sess-re',
            newMessage: {
              role: 'user',
              parts: [{text: 'Check bundle via reasoning engine'}],
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {output: Event[]};
      const texts = extractReplyTexts(body.output);
      expect(texts.some((t) => t.startsWith('BUNDLE_EXISTS:true:'))).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps compiled bundle on disk when invalidateAll() is called mid-run, then disposes it after the run completes',
    async () => {
      await sessionService.createSession({
        appName: 'bundle_check_agent',
        userId: 'user1',
        sessionId: 'sess-invalidate-mid-run',
      });

      let invalidatedBundlePath: string | undefined;
      globalThis.__adkTestOnToolExecute = (bundlePath: string) => {
        invalidatedBundlePath = bundlePath;
        (loader as unknown as {invalidateAll: () => void}).invalidateAll();
      };

      try {
        const firstResponse = await fetch(`${server.url}/run`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            appName: 'bundle_check_agent',
            userId: 'user1',
            sessionId: 'sess-invalidate-mid-run',
            newMessage: {
              role: 'user',
              parts: [{text: 'Trigger mid-run invalidation'}],
            },
          }),
        });

        expect(firstResponse.status).toBe(200);
        const firstEvents = (await firstResponse.json()) as Event[];
        const firstTexts = extractReplyTexts(firstEvents);
        expect(
          firstTexts.some((t) => t.startsWith('BUNDLE_EXISTS:true:')),
        ).toBe(true);
        expect(invalidatedBundlePath).toBeDefined();

        // Once the in-flight /run completes and releases its retain() lease,
        // the retired bundle must be disposed from disk.
        expect(fs.existsSync(invalidatedBundlePath!)).toBe(false);
      } finally {
        globalThis.__adkTestOnToolExecute = undefined;
      }

      // Subsequent /run after invalidation compiles and uses a fresh bundle.
      const secondResponse = await fetch(`${server.url}/run`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          appName: 'bundle_check_agent',
          userId: 'user1',
          sessionId: 'sess-invalidate-mid-run',
          newMessage: {
            role: 'user',
            parts: [{text: 'Run on reloaded bundle'}],
          },
        }),
      });

      expect(secondResponse.status).toBe(200);
      const secondEvents = (await secondResponse.json()) as Event[];
      const secondTexts = extractReplyTexts(secondEvents);
      const reloadedReply = secondTexts.find((t) =>
        t.startsWith('BUNDLE_EXISTS:true:'),
      );
      expect(reloadedReply).toBeDefined();
      const reloadedBundlePath = reloadedReply!.slice(
        'BUNDLE_EXISTS:true:'.length,
      );
      expect(reloadedBundlePath).not.toBe(invalidatedBundlePath);
      expect(fs.existsSync(reloadedBundlePath)).toBe(true);
    },
    TEST_TIMEOUT,
  );
});
