/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  FeatureName,
  LlmRequest,
  ProfileMemoryService,
  VertexAiLoadProfilesTool,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';

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

    const toolContext = {
      session: {appName: 'test-app'},
      userId: 'test-user',
    } as unknown as Context;

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

  it('builds function declaration matching JSON_SCHEMA_FOR_FUNC_DECL feature flag', async () => {
    const mockMemoryService: ProfileMemoryService = {
      retrieveProfiles: vi.fn().mockResolvedValue([]),
    };
    const tool = new VertexAiLoadProfilesTool(mockMemoryService);

    await withTemporaryFeatureOverride(
      FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
      false,
      () => {
        expect(tool._getDeclaration()).toEqual({
          name: 'load_profiles',
          description:
            'Loads all user profiles for the current user from Vertex AI Memory Bank.',
          parameters: {
            type: Type.OBJECT,
            properties: {},
          },
        });
      },
    );

    await withTemporaryFeatureOverride(
      FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
      true,
      () => {
        expect(tool._getDeclaration()).toEqual({
          name: 'load_profiles',
          description:
            'Loads all user profiles for the current user from Vertex AI Memory Bank.',
          parametersJsonSchema: {
            type: 'object',
            properties: {},
          },
        });
      },
    );
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
    const toolContext = {
      session: {appName: 'test-app'},
      userId: 'test-user',
    } as unknown as Context;

    await tool.processLlmRequest({
      toolContext,
      llmRequest,
    });

    expect(llmRequest.toolsDict['load_profiles']).toBe(tool);
    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });
});
