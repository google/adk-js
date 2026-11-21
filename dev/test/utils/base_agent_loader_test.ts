/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent, type RunnableRoot} from '@google/adk';
import {
  type AgentFileHandle,
  AgentLoader,
  BaseAgentLoader,
  isBaseAgentLoader,
} from '@google/adk-devtools';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

class InMemoryAgentLoader extends BaseAgentLoader {
  constructor(private readonly agents: ReadonlyMap<string, RunnableRoot>) {
    super();
  }

  override async listAgents(): Promise<string[]> {
    return [...this.agents.keys()].sort();
  }

  override async getAgentFile(agentName: string): Promise<AgentFileHandle> {
    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new Error(`Agent '${agentName}' not found.`);
    }
    return {
      load: async () => agent,
      retain: () => ({
        async [Symbol.asyncDispose](): Promise<void> {},
      }),
      async [Symbol.asyncDispose](): Promise<void> {},
    };
  }
}

describe('BaseAgentLoader', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  it('lists and loads agents from a custom in-memory subclass', async () => {
    const alpha = new LlmAgent({
      name: 'alphaAgent',
      model: 'gemini-flash-latest',
      instruction: 'Assist with alpha requests.',
    });
    const beta = new LlmAgent({
      name: 'betaAgent',
      model: 'gemini-flash-latest',
      instruction: 'Assist with beta requests.',
    });
    const loader = new InMemoryAgentLoader(
      new Map([
        ['beta', beta],
        ['alpha', alpha],
      ]),
    );

    expect(await loader.listAgents()).toEqual(['alpha', 'beta']);

    const handle = await loader.getAgentFile('alpha');
    await using _lease = handle.retain();
    expect(await handle.load()).toBe(alpha);
    await expect(loader.getAgentFile('missing')).rejects.toThrow(
      "Agent 'missing' not found.",
    );
    await expect(loader.disposeAll()).resolves.toBeUndefined();
  });

  it('recognizes BaseAgentLoader subclasses and AgentLoader via isBaseAgentLoader', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'adk-base-loader-test-'),
    );
    tempDirs.push(tempDir);

    const customLoader = new InMemoryAgentLoader(new Map());
    const fsLoader = new AgentLoader(tempDir);
    try {
      expect(isBaseAgentLoader(customLoader)).toBe(true);
      expect(isBaseAgentLoader(fsLoader)).toBe(true);
      expect(
        isBaseAgentLoader({
          listAgents: async () => [],
          getAgentFile: async () => {
            throw new Error('unused');
          },
        }),
      ).toBe(false);
      expect(isBaseAgentLoader(null)).toBe(false);
      expect(isBaseAgentLoader(undefined)).toBe(false);
      expect(isBaseAgentLoader('loader')).toBe(false);
    } finally {
      await fsLoader.disposeAll();
    }
  });
});
