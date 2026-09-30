/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  WebMCPDocument,
  WebMCPRegisteredTool,
  WebMCPTool,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

const SAMPLE_TOOL: WebMCPRegisteredTool = {
  name: 'select_flight',
  description: 'Selects a flight.',
  inputSchema: {
    type: 'object',
    properties: {flightId: {type: 'string', description: 'e.g. SB-101'}},
    required: ['flightId'],
  },
};

function docWith(executeTool: (...args: never[]) => unknown): WebMCPDocument {
  return {
    modelContext: {
      getTools: vi.fn(),
      executeTool,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    },
  } as unknown as WebMCPDocument;
}

/** A real Context, so request typing is checked rather than suppressed. */
function toolContextWith(abortSignal?: AbortSignal): Context {
  const invocationContext = {
    abortSignal,
    session: {state: {}},
  } as unknown as InvocationContext;
  return new Context({invocationContext});
}

describe('WebMCPTool', () => {
  describe('_getDeclaration', () => {
    it('should convert the JSON Schema into a Gemini declaration', () => {
      const tool = new WebMCPTool({tool: SAMPLE_TOOL});
      const declaration = tool._getDeclaration();

      expect(declaration.name).toBe('select_flight');
      expect(declaration.parameters).toEqual({
        type: 'OBJECT',
        properties: {
          flightId: {type: 'STRING', description: 'e.g. SB-101'},
        },
        required: ['flightId'],
      });
    });

    it('should parse an inputSchema delivered as a JSON string', () => {
      // Left unparsed this yields TYPE_UNSPECIFIED with no properties, and the
      // model then calls the tool with no arguments at all.
      const tool = new WebMCPTool({
        tool: {
          ...SAMPLE_TOOL,
          inputSchema: JSON.stringify(SAMPLE_TOOL.inputSchema),
        },
      });

      const parameters = tool._getDeclaration().parameters;

      expect(parameters?.type).toBe('OBJECT');
      expect(parameters?.properties?.['flightId'].type).toBe('STRING');
      expect(parameters?.required).toEqual(['flightId']);
    });

    it('should declare an empty object when there is no schema', () => {
      const tool = new WebMCPTool({tool: {name: 'ping', description: 'Ping.'}});
      const parameters = tool._getDeclaration().parameters;

      expect(parameters).toEqual({type: 'OBJECT', properties: {}});
    });

    it('should degrade to no parameters on an unparseable schema string', () => {
      const tool = new WebMCPTool({
        tool: {...SAMPLE_TOOL, inputSchema: 'not json'},
      });
      const parameters = tool._getDeclaration().parameters;

      expect(parameters).toEqual({type: 'OBJECT', properties: {}});
    });

    it('should use the prefixed name when one is supplied', () => {
      const tool = new WebMCPTool({
        tool: SAMPLE_TOOL,
        name: 'web_select_flight',
      });
      expect(tool._getDeclaration().name).toBe('web_select_flight');
    });
  });

  describe('checkRequireConfirmation', () => {
    it('should require confirmation for a consequential tool', async () => {
      const tool = new WebMCPTool({
        tool: {...SAMPLE_TOOL, annotations: {consequentialHint: true}},
      });
      await expect(tool.checkRequireConfirmation()).resolves.toBe(true);
    });

    it('should not require confirmation otherwise', async () => {
      const tool = new WebMCPTool({
        tool: {...SAMPLE_TOOL, annotations: {readOnlyHint: true}},
      });
      await expect(tool.checkRequireConfirmation()).resolves.toBe(false);
    });
  });

  describe('runAsync', () => {
    it('should pass arguments as an object when the browser accepts one', async () => {
      const executeTool = vi.fn(
        async (_tool: unknown, _args: unknown, _options?: unknown) => ({
          ok: true,
        }),
      );
      const tool = new WebMCPTool({
        tool: SAMPLE_TOOL,
        document: docWith(executeTool),
      });

      const result = await tool.runAsync({
        args: {flightId: 'SB-101'},
        toolContext: toolContextWith(),
      });

      expect(result).toEqual({ok: true});
      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(executeTool.mock.calls[0][1]).toEqual({flightId: 'SB-101'});
    });

    it('should retry with a JSON string when the browser cannot parse an object', async () => {
      // Pre-Chrome-155 behaviour: an object is stringified to "[object Object]"
      // and fails to parse, so the tool never runs.
      const executeTool = vi.fn((_tool: unknown, args: unknown) =>
        typeof args === 'string'
          ? {ok: true}
          : {error: 'Failed to parse input arguments'},
      );
      const tool = new WebMCPTool({
        tool: SAMPLE_TOOL,
        document: docWith(executeTool),
      });

      const result = await tool.runAsync({
        args: {flightId: 'SB-101'},
        toolContext: toolContextWith(),
      });

      expect(result).toEqual({ok: true});
      expect(executeTool).toHaveBeenCalledTimes(2);
      expect(executeTool.mock.calls[1][1]).toBe('{"flightId":"SB-101"}');
    });

    it('should reuse the negotiated encoding without probing again', async () => {
      const executeTool = vi.fn((_tool: unknown, args: unknown) =>
        typeof args === 'string'
          ? {ok: true}
          : {error: 'Failed to parse input arguments'},
      );
      const tool = new WebMCPTool({
        tool: SAMPLE_TOOL,
        document: docWith(executeTool),
      });

      await tool.runAsync({
        args: {flightId: 'SB-101'},
        toolContext: toolContextWith(),
      });
      expect(executeTool).toHaveBeenCalledTimes(2);

      await tool.runAsync({
        args: {flightId: 'SB-102'},
        toolContext: toolContextWith(),
      });
      expect(executeTool).toHaveBeenCalledTimes(3);
      expect(executeTool.mock.calls[2][1]).toBe('{"flightId":"SB-102"}');
    });

    it('should propagate unrelated tool errors without retrying', async () => {
      const executeTool = vi.fn(async () => {
        throw new Error('Flight service unavailable');
      });
      const tool = new WebMCPTool({
        tool: SAMPLE_TOOL,
        document: docWith(executeTool),
      });

      await expect(
        tool.runAsync({args: {}, toolContext: toolContextWith()}),
      ).rejects.toThrow('Flight service unavailable');
      expect(executeTool).toHaveBeenCalledTimes(1);
    });

    it('should forward the abort signal', async () => {
      const executeTool = vi.fn(
        async (_tool: unknown, _args: unknown, _options?: unknown) => ({
          ok: true,
        }),
      );
      const tool = new WebMCPTool({
        tool: SAMPLE_TOOL,
        document: docWith(executeTool),
      });
      const controller = new AbortController();

      await tool.runAsync({
        args: {},
        toolContext: toolContextWith(controller.signal),
      });

      expect(executeTool.mock.calls[0][2]).toEqual({
        signal: controller.signal,
      });
    });

    it('should throw a clear error when WebMCP is unavailable', async () => {
      const tool = new WebMCPTool({tool: SAMPLE_TOOL, document: {}});
      await expect(
        tool.runAsync({args: {}, toolContext: toolContextWith()}),
      ).rejects.toThrow(/document\.modelContext is unavailable/);
    });
  });
});
