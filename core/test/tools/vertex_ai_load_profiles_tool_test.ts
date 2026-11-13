/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  LlmRequest,
  PluginManager,
  ProfileMemoryService,
  VertexAiLoadProfilesTool,
} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';

function createTestToolContext(): Context {
  const session = createSession({
    id: 'session-1',
    appName: 'test-app',
    userId: 'test-user',
  });
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      session,
      pluginManager: new PluginManager(),
    }),
  });
}

describe('VertexAiLoadProfilesTool', () => {
  it('returns non-empty profile payloads and filters out empty or undefined profiles', async () => {
    const mockMemoryService: ProfileMemoryService = {
      retrieveProfiles: vi.fn().mockResolvedValue([
        {
          schemaId: 'default',
          profile: {name: 'Alice', age: 30},
        },
        {
          schemaId: 'preferences',
          profile: {theme: 'dark'},
        },
        {
          schemaId: 'empty',
          profile: {},
        },
        {
          schemaId: 'missing',
          profile: undefined,
        },
      ]),
    };

    const toolContext = createTestToolContext();
    const tool = new VertexAiLoadProfilesTool(mockMemoryService);
    const result = await tool.runAsync({
      args: {},
      toolContext,
    });

    expect(mockMemoryService.retrieveProfiles).toHaveBeenCalledWith({
      appName: 'test-app',
      userId: 'test-user',
    });
    expect(result).toEqual({
      profiles: [{name: 'Alice', age: 30}, {theme: 'dark'}],
    });
  });

  it('propagates rejection when retrieveProfiles fails', async () => {
    const mockMemoryService: ProfileMemoryService = {
      retrieveProfiles: vi
        .fn()
        .mockRejectedValue(new Error('Memory Bank unavailable')),
    };

    const toolContext = createTestToolContext();
    const tool = new VertexAiLoadProfilesTool(mockMemoryService);

    await expect(
      tool.runAsync({
        args: {},
        toolContext,
      }),
    ).rejects.toThrow('Memory Bank unavailable');
  });

  it('builds function declaration with empty object parameters', () => {
    const mockMemoryService: ProfileMemoryService = {
      retrieveProfiles: vi.fn().mockResolvedValue([]),
    };
    const tool = new VertexAiLoadProfilesTool(mockMemoryService);

    expect(tool._getDeclaration()).toEqual({
      name: 'load_profiles',
      description:
        'Loads all user profiles for the current user from Vertex AI Memory Bank.',
      parameters: {
        type: Type.OBJECT,
        properties: {},
      },
    });
  });

  it('registers the tool declaration on LlmRequest without adding system instructions', async () => {
    const mockMemoryService: ProfileMemoryService = {
      retrieveProfiles: vi.fn().mockResolvedValue([]),
    };
    const tool = new VertexAiLoadProfilesTool(mockMemoryService);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const toolContext = createTestToolContext();

    await tool.processLlmRequest({
      toolContext,
      llmRequest,
    });

    expect(llmRequest.toolsDict['load_profiles']).toBe(tool);
    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });
});
