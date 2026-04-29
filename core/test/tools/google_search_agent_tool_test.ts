/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  createEventActions,
  LlmAgent,
  Runner,
} from '@google/adk';
import {Tool} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {BaseLlm} from '../../src/models/base_llm.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {
  createGoogleSearchAgent,
  GoogleSearchAgentTool,
} from '../../src/tools/google_search_agent_tool.js';
import {
  GOOGLE_SEARCH,
  GoogleSearchTool,
} from '../../src/tools/google_search_tool.js';

vi.mock('../../src/runner/runner.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/runner/runner.js')>();
  return {
    ...actual,
    Runner: vi.fn().mockImplementation((config) => ({
      appName: config?.appName,
      sessionService: config?.sessionService,
      runAsync: vi.fn(),
    })),
  };
});

describe('GoogleSearchAgentTool', () => {
  describe('createGoogleSearchAgent', () => {
    it('should create an LlmAgent with correct properties', () => {
      const agent = createGoogleSearchAgent('gemini-1.5-flash');
      expect(agent).toBeInstanceOf(LlmAgent);
      expect(agent.name).toBe('google_search_agent');
      expect(agent.tools).toContain(GOOGLE_SEARCH);
    });
  });

  describe('GoogleSearchAgentTool', () => {
    it('should propagate grounding metadata', async () => {
      const mockAgent = {
        name: 'google_search_agent',
      } as unknown as LlmAgent;

      const tool = new GoogleSearchAgentTool(mockAgent);

      const toolContext = {
        invocationContext: {
          userId: 'test-user',
          session: {id: 'test-session'},
        },
        state: {
          toRecord: () => ({}),
          update: vi.fn(),
        },
        actions: {},
      } as unknown as Context;

      const mockGroundingMetadata = {some: 'metadata'};

      // Setup Runner mock to return an event with grounding metadata
      const mockRunAsync = async function* () {
        yield {
          author: 'google_search_agent',
          content: {role: 'model', parts: [{text: 'hello'}]},
          actions: createEventActions(),
          groundingMetadata: mockGroundingMetadata,
        };
      };

      vi.mocked(Runner).mockImplementation((config) => {
        return {
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync: mockRunAsync,
        } as unknown as Runner;
      });

      await tool.runAsync({
        args: {request: 'hello'},
        toolContext,
      });

      // Verify state update called with grounding metadata
      expect(toolContext.state.update).toHaveBeenCalledWith({
        'temp:grounding_metadata': mockGroundingMetadata,
      });
    });
  });

  describe('Automatic Wrapping', () => {
    class MockTool extends BaseTool {
      constructor() {
        super({name: 'mock_tool', description: 'Mock Tool'});
      }
      runAsync(): Promise<unknown> {
        return Promise.resolve();
      }
    }

    const mockModel = {
      [Symbol.for('google.adk.baseModel')]: true,
      model: 'mock-model',
    } as unknown as BaseLlm;

    it('should wrap GoogleSearchTool when bypassMultiToolsLimit is true and there are multiple tools', async () => {
      const searchTool = new GoogleSearchTool({bypassMultiToolsLimit: true});
      const mockTool = new MockTool();

      const agent = new LlmAgent({
        name: 'test_agent',
        model: mockModel,
        tools: [searchTool, mockTool],
      });

      const resolvedTools = await agent.canonicalTools();

      expect(resolvedTools.length).toBe(2);
      expect(resolvedTools[0]).toBeInstanceOf(GoogleSearchAgentTool);
      expect(resolvedTools[1]).toBe(mockTool);
    });

    it('should NOT wrap GoogleSearchTool when bypassMultiToolsLimit is false', async () => {
      const searchTool = new GoogleSearchTool({bypassMultiToolsLimit: false});
      const mockTool = new MockTool();

      const agent = new LlmAgent({
        name: 'test_agent',
        model: mockModel,
        tools: [searchTool, mockTool],
      });

      const resolvedTools = await agent.canonicalTools();

      expect(resolvedTools.length).toBe(2);
      expect(resolvedTools[0]).toBe(searchTool);
      expect(resolvedTools[1]).toBe(mockTool);
    });

    it('should NOT wrap GoogleSearchTool when it is the only tool', async () => {
      const searchTool = new GoogleSearchTool({bypassMultiToolsLimit: true});

      const agent = new LlmAgent({
        name: 'test_agent',
        model: mockModel,
        tools: [searchTool],
      });

      const resolvedTools = await agent.canonicalTools();

      expect(resolvedTools.length).toBe(1);
      expect(resolvedTools[0]).toBe(searchTool);
    });
  });

  describe('GoogleSearchTool', () => {
    it('should override model in processLlmRequest if model option is set', async () => {
      const searchTool = new GoogleSearchTool({model: 'gemini-1.5-pro'});
      const llmRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
        model: 'gemini-1.5-flash',
        config: {tools: []},
      };

      await searchTool.processLlmRequest({
        llmRequest,
        toolContext: {} as unknown as Context,
      });

      expect(llmRequest.model).toBe('gemini-1.5-pro');
    });

    it('should not override model in processLlmRequest if model option is NOT set', async () => {
      const searchTool = new GoogleSearchTool();
      const llmRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
        model: 'gemini-1.5-flash',
        config: {tools: []},
      };

      await searchTool.processLlmRequest({
        llmRequest,
        toolContext: {} as unknown as Context,
      });

      expect(llmRequest.model).toBe('gemini-1.5-flash');
    });

    it('should throw error if used with other tools in Gemini 1.x', async () => {
      const searchTool = new GoogleSearchTool();
      const llmRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
        model: 'gemini-1.5-flash',
        config: {tools: [{functionDeclarations: []}] as unknown as Tool[]},
      };

      await expect(
        searchTool.processLlmRequest({
          llmRequest,
          toolContext: {} as unknown as Context,
        }),
      ).rejects.toThrow(
        'Google search tool can not be used with other tools in Gemini 1.x.',
      );
    });

    it('should add googleSearch for Gemini 2 models', async () => {
      const searchTool = new GoogleSearchTool();
      const llmRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
        model: 'gemini-2.5-flash',
        config: {tools: []},
      };

      await searchTool.processLlmRequest({
        llmRequest,
        toolContext: {} as unknown as Context,
      });

      expect(llmRequest.config!.tools).toContainEqual({googleSearch: {}});
    });

    it('should throw error for unsupported models', async () => {
      const searchTool = new GoogleSearchTool();
      const llmRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
        model: 'non-existent-model',
        config: {tools: []},
      };

      await expect(
        searchTool.processLlmRequest({
          llmRequest,
          toolContext: {} as unknown as Context,
        }),
      ).rejects.toThrow(
        'Google search tool is not supported for model non-existent-model',
      );
    });

    it('should return resolved promise in runAsync', async () => {
      const searchTool = new GoogleSearchTool();
      await expect(searchTool.runAsync()).resolves.toBeUndefined();
    });

    it('should return early in processLlmRequest if model is not set', async () => {
      const searchTool = new GoogleSearchTool();
      const llmRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
        config: {tools: []},
      };

      await searchTool.processLlmRequest({
        llmRequest,
        toolContext: {} as unknown as Context,
      });

      expect(llmRequest.config!.tools).toEqual([]);
    });

    it('should initialize config and tools if undefined in processLlmRequest', async () => {
      const searchTool = new GoogleSearchTool();
      const llmRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
        model: 'gemini-1.5-flash',
      };

      await searchTool.processLlmRequest({
        llmRequest,
        toolContext: {} as unknown as Context,
      });

      expect(llmRequest.config).toBeDefined();
      expect(llmRequest.config!.tools).toBeDefined();
      expect(llmRequest.config!.tools!.length).toBe(1);
    });
  });
});
