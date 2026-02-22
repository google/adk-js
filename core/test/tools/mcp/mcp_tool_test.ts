/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Tool} from '@modelcontextprotocol/sdk/types.js';
import {describe, expect, it, vi} from 'vitest';

import {ToolContext} from '../../../src/tools/tool_context.js';
import {MCPTool} from '../../../src/tools/mcp/mcp_tool.js';
import {MCPSessionManager} from '../../../src/tools/mcp/mcp_session_manager.js';

function createMockSessionManager(overrides: Record<string, unknown> = {}) {
  return {
    createSession: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    getInstructions: vi.fn().mockReturnValue(undefined),
    ...overrides,
  } as unknown as MCPSessionManager;
}

const FAKE_MCP_TOOL: Tool = {
  name: 'get_weather',
  description: 'Get weather for a location',
  inputSchema: {
    type: 'object',
    properties: {
      location: {type: 'string', description: 'City name'},
    },
    required: ['location'],
  },
};

describe('MCPTool', () => {
  // ---------------------------------------------------------------------------
  // _getDeclaration
  // ---------------------------------------------------------------------------

  describe('_getDeclaration', () => {
    it('passes MCP JSON Schema directly via parametersJsonSchema', () => {
      const manager = createMockSessionManager();
      const tool = new MCPTool(FAKE_MCP_TOOL, manager);

      const decl = tool._getDeclaration();

      expect(decl.name).toBe('get_weather');
      expect(decl.description).toBe('Get weather for a location');
      expect(decl.parametersJsonSchema).toEqual(FAKE_MCP_TOOL.inputSchema);
      expect(decl.parameters).toBeUndefined();
    });

    /**
     * Improvement: Before toGeminiSchema() dropped enum, format, pattern.
     * After parametersJsonSchema pass-through preserves all.
     */
    it('improvement: preserves full schema fidelity (enum, format, pattern)', () => {
      const manager = createMockSessionManager();
      const richSchema: Tool = {
        name: 'create_event',
        description: 'Create a calendar event',
        inputSchema: {
          type: 'object',
          properties: {
            title: {type: 'string', minLength: 1, maxLength: 200},
            priority: {type: 'string', enum: ['low', 'medium', 'high']},
            date: {type: 'string', format: 'date-time'},
            tags: {type: 'array', items: {type: 'string', pattern: '^[a-z]+$'}},
          },
          required: ['title', 'date'],
          additionalProperties: false,
        },
      };
      const tool = new MCPTool(richSchema, manager);
      const decl = tool._getDeclaration();

      expect(decl.parametersJsonSchema).toEqual(richSchema.inputSchema);
    });

    it('sets name and description from the MCP tool', () => {
      const manager = createMockSessionManager();
      const tool = new MCPTool(FAKE_MCP_TOOL, manager);

      expect(tool.name).toBe('get_weather');
      expect(tool.description).toBe('Get weather for a location');
    });

    it('uses empty string for missing description', () => {
      const manager = createMockSessionManager();
      const noDesc = {...FAKE_MCP_TOOL, description: undefined} as Tool;
      const tool = new MCPTool(noDesc, manager);

      expect(tool.description).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // runAsync
  // ---------------------------------------------------------------------------

  describe('runAsync', () => {
    const fakeResult = {content: [{type: 'text', text: 'Sunny, 72F'}]};
    const fakeRequest = {
      args: {location: 'NYC'},
      toolContext: {} as ToolContext,
    };

    it('calls the MCP server with the tool name and arguments', async () => {
      const mockCallTool = vi.fn().mockResolvedValue(fakeResult);
      const manager = createMockSessionManager({
        createSession: vi.fn().mockResolvedValue({callTool: mockCallTool}),
      });

      const tool = new MCPTool(FAKE_MCP_TOOL, manager);
      const result = await tool.runAsync(fakeRequest);

      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'get_weather',
        arguments: {location: 'NYC'},
      });
      expect(result).toEqual(fakeResult);
    });

    it('reuses the cached session from the manager', async () => {
      const mockCallTool = vi.fn().mockResolvedValue(fakeResult);
      const mockCreateSession = vi
        .fn()
        .mockResolvedValue({callTool: mockCallTool});
      const manager = createMockSessionManager({
        createSession: mockCreateSession,
      });

      const tool = new MCPTool(FAKE_MCP_TOOL, manager);
      await tool.runAsync(fakeRequest);
      await tool.runAsync(fakeRequest);

      expect(mockCreateSession).toHaveBeenCalledTimes(2);
      expect(mockCallTool).toHaveBeenCalledTimes(2);
    });

    /**
     * Improvement: Before callTool failure was permanent.
     * After: retry-once with fresh connection.
     */
    it('improvement: retries once on session failure', async () => {
      const mockCallTool = vi
        .fn()
        .mockRejectedValueOnce(new Error('Connection lost'))
        .mockResolvedValueOnce(fakeResult);

      const mockCreateSession = vi
        .fn()
        .mockResolvedValueOnce({callTool: mockCallTool})
        .mockResolvedValueOnce({callTool: mockCallTool});

      const manager = createMockSessionManager({
        createSession: mockCreateSession,
      });

      const tool = new MCPTool(FAKE_MCP_TOOL, manager);
      const result = await tool.runAsync(fakeRequest);

      expect(manager.close).toHaveBeenCalledTimes(1);
      expect(mockCreateSession).toHaveBeenCalledTimes(2);
      expect(result).toEqual(fakeResult);
    });

    it('throws if retry also fails', async () => {
      const error1 = new Error('Connection lost');
      const error2 = new Error('Still broken');

      const mockCallTool1 = vi.fn().mockRejectedValue(error1);
      const mockCallTool2 = vi.fn().mockRejectedValue(error2);

      const mockCreateSession = vi
        .fn()
        .mockResolvedValueOnce({callTool: mockCallTool1})
        .mockResolvedValueOnce({callTool: mockCallTool2});

      const manager = createMockSessionManager({
        createSession: mockCreateSession,
      });

      const tool = new MCPTool(FAKE_MCP_TOOL, manager);

      await expect(tool.runAsync(fakeRequest)).rejects.toThrow('Still broken');
      expect(manager.close).toHaveBeenCalledTimes(1);
    });

    it('retries when createSession itself fails on first attempt', async () => {
      const mockCallTool = vi.fn().mockResolvedValue(fakeResult);
      const mockCreateSession = vi
        .fn()
        .mockRejectedValueOnce(new Error('Server not ready'))
        .mockResolvedValueOnce({callTool: mockCallTool});

      const manager = createMockSessionManager({
        createSession: mockCreateSession,
      });

      const tool = new MCPTool(FAKE_MCP_TOOL, manager);
      const result = await tool.runAsync(fakeRequest);

      expect(manager.close).toHaveBeenCalledTimes(1);
      expect(mockCreateSession).toHaveBeenCalledTimes(2);
      expect(result).toEqual(fakeResult);
    });

    it('propagates close() error when it throws during retry', async () => {
      const mockCallTool = vi
        .fn()
        .mockRejectedValueOnce(new Error('Connection lost'));
      const mockCreateSession = vi
        .fn()
        .mockResolvedValueOnce({callTool: mockCallTool});

      const manager = createMockSessionManager({
        createSession: mockCreateSession,
        close: vi.fn().mockRejectedValue(new Error('Close failed')),
      });

      const tool = new MCPTool(FAKE_MCP_TOOL, manager);

      await expect(tool.runAsync(fakeRequest)).rejects.toThrow('Close failed');
    });

    it('sends empty arguments when args is empty object', async () => {
      const mockCallTool = vi.fn().mockResolvedValue(fakeResult);
      const manager = createMockSessionManager({
        createSession: vi.fn().mockResolvedValue({callTool: mockCallTool}),
      });

      const tool = new MCPTool(FAKE_MCP_TOOL, manager);
      await tool.runAsync({args: {}, toolContext: {} as ToolContext});

      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'get_weather',
        arguments: {},
      });
    });

    it('sends undefined arguments when args is undefined', async () => {
      const mockCallTool = vi.fn().mockResolvedValue(fakeResult);
      const manager = createMockSessionManager({
        createSession: vi.fn().mockResolvedValue({callTool: mockCallTool}),
      });

      const tool = new MCPTool(FAKE_MCP_TOOL, manager);
      await tool.runAsync({
        args: undefined as unknown as Record<string, unknown>,
        toolContext: {} as ToolContext,
      });

      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'get_weather',
        arguments: undefined,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // _getDeclaration – additional cases
  // ---------------------------------------------------------------------------

  describe('_getDeclaration edge cases', () => {
    it('handles tool with no inputSchema properties', () => {
      const manager = createMockSessionManager();
      const minimal: Tool = {
        name: 'ping',
        description: 'Ping the server',
        inputSchema: {type: 'object'},
      };
      const tool = new MCPTool(minimal, manager);
      const decl = tool._getDeclaration();

      expect(decl.name).toBe('ping');
      expect(decl.parametersJsonSchema).toEqual({type: 'object'});
    });

    it('passes nested object schema through without conversion', () => {
      const manager = createMockSessionManager();
      const nested: Tool = {
        name: 'search',
        description: 'Search',
        inputSchema: {
          type: 'object',
          properties: {
            query: {type: 'string'},
            options: {
              type: 'object',
              properties: {
                limit: {type: 'integer'},
              },
            },
          },
        },
      };
      const tool = new MCPTool(nested, manager);
      const decl = tool._getDeclaration();

      expect(decl.parametersJsonSchema).toEqual(nested.inputSchema);
    });

    it('returns undefined responseJsonSchema when outputSchema is missing', () => {
      const manager = createMockSessionManager();
      const tool = new MCPTool(FAKE_MCP_TOOL, manager);
      const decl = tool._getDeclaration();

      expect(decl.responseJsonSchema).toBeUndefined();
    });

    it('passes outputSchema through as responseJsonSchema', () => {
      const manager = createMockSessionManager();
      const outputSchema = {
        type: 'object' as const,
        properties: {
          temperature: {type: 'number'},
          unit: {type: 'string', enum: ['celsius', 'fahrenheit']},
        },
      };
      const withOutput: Tool = {
        ...FAKE_MCP_TOOL,
        outputSchema,
      };
      const tool = new MCPTool(withOutput, manager);
      const decl = tool._getDeclaration();

      expect(decl.responseJsonSchema).toEqual(outputSchema);
    });
  });
});
