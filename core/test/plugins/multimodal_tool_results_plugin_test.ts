/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type Content, type Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {type Context} from '../../src/agents/context.js';
import {type LlmRequest} from '../../src/models/llm_request.js';
import {
  _CURRENT_TURN_PARTS_ID,
  _SESSION_UPDATED_KEY,
  isMultimodalToolResultsPlugin,
  isPart,
  MultimodalToolResultsPlugin,
  PARTS_RETURNED_BY_TOOLS_ID,
  SESSION_PARTS_RETURNED_BY_TOOLS_ID,
} from '../../src/plugins/multimodal_tool_results_plugin.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {State} from '../../src/sessions/state.js';
import {type BaseTool} from '../../src/tools/base_tool.js';

function createMockTool(name = 'mock_multimodal_tool'): BaseTool {
  return {
    name,
    description: 'Mock multimodal tool for testing',
  } as unknown as BaseTool;
}

function createMockContext(
  initialState: Record<string, unknown> = {},
): Context {
  const state = new State(initialState);
  return {
    invocationId: 'inv-test-123',
    state,
  } as unknown as Context;
}

describe('MultimodalToolResultsPlugin', () => {
  describe('Initialization & Options', () => {
    it('should initialize with default options', () => {
      const plugin = new MultimodalToolResultsPlugin();
      expect(plugin.name).toBe('multimodal_tool_results_plugin');
      expect(plugin.retention).toBe('next_model_call');
      expect(isMultimodalToolResultsPlugin(plugin)).toBe(true);
    });

    it('should accept custom name and retention', () => {
      const plugin = new MultimodalToolResultsPlugin({
        name: 'custom_multimodal_plugin',
        retention: 'session',
      });
      expect(plugin.name).toBe('custom_multimodal_plugin');
      expect(plugin.retention).toBe('session');
    });

    it('should throw an error for invalid retention option', () => {
      expect(() => {
        new MultimodalToolResultsPlugin({
          // @ts-expect-error Testing runtime validation for invalid input
          retention: 'invalid_mode',
        });
      }).toThrowError(/retention must be 'next_model_call' or 'session'/);
    });

    it('should correctly identify plugin with isMultimodalToolResultsPlugin', () => {
      const plugin = new MultimodalToolResultsPlugin();
      expect(isMultimodalToolResultsPlugin(plugin)).toBe(true);
      expect(isMultimodalToolResultsPlugin(null)).toBe(false);
      expect(isMultimodalToolResultsPlugin({})).toBe(false);
      expect(isMultimodalToolResultsPlugin({name: 'fake'})).toBe(false);
    });
  });

  describe('isPart helper', () => {
    it('should identify valid multimodal Part objects', () => {
      expect(
        isPart({
          inlineData: {data: 'aGVsbG8=', mimeType: 'image/png'},
        }),
      ).toBe(true);
      expect(
        isPart({
          fileData: {
            fileUri: 'gs://bucket/file.pdf',
            mimeType: 'application/pdf',
          },
        }),
      ).toBe(true);
    });

    it('should reject non-Part objects and plain tool results', () => {
      expect(isPart(null)).toBe(false);
      expect(isPart(undefined)).toBe(false);
      expect(isPart('string')).toBe(false);
      expect(isPart(123)).toBe(false);
      expect(isPart([])).toBe(false);
      expect(isPart({})).toBe(false);
      expect(isPart({some: 'data'})).toBe(false);
      expect(isPart({result: 'ok'})).toBe(false);
      expect(isPart({text: 'hello world'})).toBe(false);
      expect(
        isPart({
          functionResponse: {name: 'test_func', response: {output: 'ok'}},
        }),
      ).toBe(false);
      expect(
        isPart({
          functionCall: {name: 'test_func', args: {}},
        }),
      ).toBe(false);
      expect(
        isPart({
          inlineData: {data: 'aGVsbG8=', mimeType: 'image/png'},
          unexpectedExtraKey: 123,
        }),
      ).toBe(false);
    });
  });

  describe('next_model_call retention (default mode)', () => {
    it('should save parts returned by a tool to state and return undefined', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const mockTool = createMockTool();
      const context = createMockContext();
      const parts: Part[] = [
        {
          inlineData: {data: 'cGFydDE=', mimeType: 'image/png'},
        },
        {
          fileData: {
            fileUri: 'gs://bucket/file.pdf',
            mimeType: 'application/pdf',
          },
        },
      ];

      const afterResult = await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context,
        result: parts,
      });

      expect(afterResult).toBeUndefined();
      expect(context.state.has(PARTS_RETURNED_BY_TOOLS_ID)).toBe(true);
      expect(context.state.get(PARTS_RETURNED_BY_TOOLS_ID)).toEqual(parts);

      // Verify beforeModelCallback attaches the parts to llmRequest
      const llmRequest: LlmRequest = {
        contents: [{parts: []} as Content],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest,
      });

      expect(llmRequest.contents[0].parts).toEqual(parts);
      // State should be cleared after attaching
      expect(context.state.get(PARTS_RETURNED_BY_TOOLS_ID)).toEqual([]);
    });

    it('should handle single Part instance returned by tool', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const mockTool = createMockTool();
      const context = createMockContext();
      const singlePart: Part = {
        inlineData: {data: 'aW1hZ2VkYXRh', mimeType: 'image/jpeg'},
      };

      const afterResult = await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context,
        result: singlePart,
      });

      expect(afterResult).toBeUndefined();
      expect(context.state.get(PARTS_RETURNED_BY_TOOLS_ID)).toEqual([
        singlePart,
      ]);

      const llmRequest: LlmRequest = {
        contents: [{parts: [{text: 'User prompt'}]} as Content],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest,
      });

      expect(llmRequest.contents[0].parts).toEqual([
        {text: 'User prompt'},
        singlePart,
      ]);
      expect(context.state.get(PARTS_RETURNED_BY_TOOLS_ID)).toEqual([]);
    });

    it('should leave non-part tool results completely unchanged', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const mockTool = createMockTool();
      const context = createMockContext();
      const originalResult = {temperature: 72, unit: 'Fahrenheit'};

      const afterResult = await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context,
        result: originalResult,
      });

      expect(afterResult).toEqual(originalResult);
      expect(context.state.has(PARTS_RETURNED_BY_TOOLS_ID)).toBe(false);

      const llmRequest: LlmRequest = {
        contents: [{parts: [{text: 'Original'}]} as Content],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest,
      });

      expect(llmRequest.contents[0].parts).toEqual([{text: 'Original'}]);
    });

    it('should accumulate parts from multiple tools in order', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const mockTool = createMockTool();
      const context = createMockContext();
      const parts1: Part[] = [
        {fileData: {fileUri: 'gs://b/doc1.pdf', mimeType: 'application/pdf'}},
      ];
      const parts2: Part[] = [
        {fileData: {fileUri: 'gs://b/doc2.pdf', mimeType: 'application/pdf'}},
      ];

      await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context,
        result: parts1,
      });

      await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context,
        result: parts2,
      });

      expect(context.state.get(PARTS_RETURNED_BY_TOOLS_ID)).toEqual([
        ...parts1,
        ...parts2,
      ]);

      const llmRequest: LlmRequest = {
        contents: [{parts: []} as Content],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest,
      });

      expect(llmRequest.contents[0].parts).toEqual([...parts1, ...parts2]);
    });

    it('should leave parts pending if llmRequest.contents is empty', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const mockTool = createMockTool();
      const context = createMockContext();
      const parts: Part[] = [
        {
          fileData: {
            fileUri: 'gs://b/pending.pdf',
            mimeType: 'application/pdf',
          },
        },
      ];

      await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context,
        result: parts,
      });

      const llmRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest,
      });

      expect(llmRequest.contents).toEqual([]);
      expect(context.state.get(PARTS_RETURNED_BY_TOOLS_ID)).toEqual(parts);
    });

    it('should leave plain tool results with text or functionResponse fields completely unchanged', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const mockTool = createMockTool();
      const context = createMockContext();

      const textResult = {text: 'The weather is sunny in Paris.'};
      const textAfter = await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context,
        result: textResult,
      });
      expect(textAfter).toEqual(textResult);
      expect(context.state.has(PARTS_RETURNED_BY_TOOLS_ID)).toBe(false);

      const funcResponseResult = {
        functionResponse: {name: 'get_weather', response: {temp: 72}},
      };
      const funcAfter = await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context,
        result: funcResponseResult,
      });
      expect(funcAfter).toEqual(funcResponseResult);
      expect(context.state.has(PARTS_RETURNED_BY_TOOLS_ID)).toBe(false);
    });
  });

  describe('session retention mode', () => {
    it('should serialize and retain non-binary parts in session state', async () => {
      const plugin = new MultimodalToolResultsPlugin({retention: 'session'});
      const mockTool = createMockTool();
      const context = createMockContext();
      const parts: Part[] = [
        {fileData: {fileUri: 'gs://b/doc1.pdf', mimeType: 'application/pdf'}},
        {fileData: {fileUri: 'gs://b/doc2.pdf', mimeType: 'application/pdf'}},
      ];

      await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context,
        result: parts,
      });

      expect(context.state.has(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toBe(true);
      expect(context.state.get(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toEqual(
        parts,
      );
    });

    it('should separate inline binary parts from session parts', async () => {
      const plugin = new MultimodalToolResultsPlugin({retention: 'session'});
      const mockTool = createMockTool();
      const context = createMockContext();
      const filePart: Part = {
        fileData: {fileUri: 'gs://bucket/doc.pdf', mimeType: 'application/pdf'},
      };
      const binaryPart: Part = {
        inlineData: {data: 'YmluYXJ5', mimeType: 'image/png'},
      };
      const parts = [filePart, binaryPart];

      await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context,
        result: parts,
      });

      // Session state should only contain filePart (inlineData is excluded)
      const sessionParts = context.state.get<Part[]>(
        SESSION_PARTS_RETURNED_BY_TOOLS_ID,
      );
      expect(sessionParts).toEqual([filePart]);

      // All parts should be in current turn temp state (preserving order)
      const currentTurnParts = context.state.get<Part[]>(
        _CURRENT_TURN_PARTS_ID,
      );
      expect(currentTurnParts).toEqual([filePart, binaryPart]);

      // Verify beforeModelCallback
      const llmRequest: LlmRequest = {
        contents: [{parts: []} as Content],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest,
      });

      // Model request receives both in order without duplicate filePart
      expect(llmRequest.contents[0].parts).toEqual([filePart, binaryPart]);

      // Temp state is cleared, session state remains for subsequent turns
      expect(context.state.get(_CURRENT_TURN_PARTS_ID)).toEqual([]);
      expect(context.state.get(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toEqual([
        filePart,
      ]);
    });

    it('should accumulate session parts across multiple tools in the same turn', async () => {
      const plugin = new MultimodalToolResultsPlugin({retention: 'session'});
      const mockTool = createMockTool();
      const context = createMockContext();
      const part1: Part = {
        fileData: {fileUri: 'gs://b/part1.pdf', mimeType: 'application/pdf'},
      };
      const part2: Part = {
        fileData: {fileUri: 'gs://b/part2.pdf', mimeType: 'application/pdf'},
      };

      await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context,
        result: [part1],
      });

      await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context,
        result: [part2],
      });

      expect(context.state.get(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toEqual([
        part1,
        part2,
      ]);
    });

    it('should replace session parts on a new invocation turn', async () => {
      const plugin = new MultimodalToolResultsPlugin({retention: 'session'});
      const mockTool = createMockTool();
      const context = createMockContext();
      const turn1Parts: Part[] = [
        {fileData: {fileUri: 'gs://b/turn1.pdf', mimeType: 'application/pdf'}},
      ];
      const turn2Parts: Part[] = [
        {fileData: {fileUri: 'gs://b/turn2.pdf', mimeType: 'application/pdf'}},
      ];

      // Turn 1
      await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context,
        result: turn1Parts,
      });

      expect(context.state.get(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toEqual(
        turn1Parts,
      );

      // Simulate turn boundary: temp keys stripped at end of turn
      context.state.set(_SESSION_UPDATED_KEY, undefined);
      context.state.set(_CURRENT_TURN_PARTS_ID, undefined);

      // Turn 2
      await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context,
        result: turn2Parts,
      });

      // Session parts from turn 1 should be replaced by turn 2 parts
      expect(context.state.get(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toEqual(
        turn2Parts,
      );
    });

    it('should not erase previous session parts if an intermediate turn only returns binary parts', async () => {
      const plugin = new MultimodalToolResultsPlugin({retention: 'session'});
      const mockTool = createMockTool();
      const context = createMockContext();
      const filePart: Part = {
        fileData: {fileUri: 'gs://bucket/doc.pdf', mimeType: 'application/pdf'},
      };
      const binaryPart: Part = {
        inlineData: {data: 'aW1hZ2U=', mimeType: 'image/jpeg'},
      };

      // Turn 1: returns file part
      await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context,
        result: [filePart],
      });

      expect(context.state.get(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toEqual([
        filePart,
      ]);

      // Simulate turn boundary
      context.state.set(_SESSION_UPDATED_KEY, undefined);
      context.state.set(_CURRENT_TURN_PARTS_ID, undefined);

      // Turn 2: returns binary part only
      await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context,
        result: [binaryPart],
      });

      // Previous session part still preserved!
      expect(context.state.get(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toEqual([
        filePart,
      ]);
      expect(context.state.get(_CURRENT_TURN_PARTS_ID)).toEqual([binaryPart]);
    });

    it('should retain session parts across subsequent model calls in the same turn', async () => {
      const plugin = new MultimodalToolResultsPlugin({retention: 'session'});
      const mockTool = createMockTool();
      const context = createMockContext();
      const filePart: Part = {
        fileData: {fileUri: 'gs://bucket/doc.pdf', mimeType: 'application/pdf'},
      };

      // Tool 1: returns filePart
      await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context,
        result: [filePart],
      });

      // Model call 1: attaches filePart
      const llmRequest1: LlmRequest = {
        contents: [{parts: []} as Content],
        toolsDict: {},
        liveConnectConfig: {},
      };
      await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest: llmRequest1,
      });
      expect(llmRequest1.contents[0].parts).toEqual([filePart]);

      // Tool 2 in same turn: returns non-part response
      await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context,
        result: {status: 'success'},
      });

      // Model call 2 in same turn: still has filePart attached
      const llmRequest2: LlmRequest = {
        contents: [{parts: []} as Content],
        toolsDict: {},
        liveConnectConfig: {},
      };
      await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest: llmRequest2,
      });
      expect(llmRequest2.contents[0].parts).toEqual([filePart]);
    });

    it('survives real turn boundary with temp keys stripped from session state', async () => {
      const plugin = new MultimodalToolResultsPlugin({retention: 'session'});
      const mockTool = createMockTool();
      const sessionState: Record<string, unknown> = {};
      const context1 = {
        state: new State(sessionState),
      } as unknown as Context;

      const filePart: Part = {
        fileData: {
          fileUri: 'gs://bucket/contract.pdf',
          mimeType: 'application/pdf',
        },
      };

      // Turn 1 tool returns filePart
      await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context1,
        result: [filePart],
      });

      // At end of turn, the session service strips temp: keys from session state
      for (const key of Object.keys(sessionState)) {
        if (key.startsWith(State.TEMP_PREFIX)) {
          delete sessionState[key];
        }
      }

      expect(sessionState[SESSION_PARTS_RETURNED_BY_TOOLS_ID]).toEqual([
        filePart,
      ]);
      expect(sessionState[_SESSION_UPDATED_KEY]).toBeUndefined();
      expect(sessionState[_CURRENT_TURN_PARTS_ID]).toBeUndefined();

      // Turn 2 starts with the persisted session state
      const context2 = {
        state: new State(sessionState),
      } as unknown as Context;

      const llmRequest: LlmRequest = {
        contents: [{parts: []} as Content],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await plugin.beforeModelCallback({
        callbackContext: context2,
        llmRequest,
      });

      // Turn 1 file part successfully reattached in Turn 2
      expect(llmRequest.contents[0].parts).toEqual([filePart]);
    });

    it('integrates cleanly with PluginManager', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const pluginManager = new PluginManager([plugin]);
      const mockTool = createMockTool();
      const context = createMockContext();
      const parts: Part[] = [
        {inlineData: {data: 'cGx1Z2lu', mimeType: 'image/png'}},
      ];

      await pluginManager.runAfterToolCallback({
        tool: mockTool,
        toolArgs: {},
        toolContext: context,
        result: parts as unknown as Record<string, unknown>,
      });

      const llmRequest: LlmRequest = {
        contents: [{parts: []} as Content],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await pluginManager.runBeforeModelCallback({
        callbackContext: context,
        llmRequest,
      });

      expect(llmRequest.contents[0].parts).toEqual(parts);
    });
  });
});
