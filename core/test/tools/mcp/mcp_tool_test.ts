/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  isBaseTool,
  MCPSessionManager,
  MCPTool,
} from '@google/adk';
import {Type} from '@google/genai';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Tool} from '@modelcontextprotocol/sdk/types.js';
import {describe, expect, it, vi} from 'vitest';

describe('MCPTool', () => {
  it('passes abort signal to callTool', async () => {
    const mockTool: Tool = {
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const mockClient = {
      callTool: vi.fn().mockResolvedValue({content: []}),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Client;

    const mockSessionManager = {
      createSession: vi.fn().mockResolvedValue(mockClient),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPSessionManager;

    const tool = new MCPTool(mockTool, mockSessionManager);

    const controller = new AbortController();
    const signal = controller.signal;

    const invocationContext = {
      abortSignal: signal,
      session: {state: {}},
    } as unknown as InvocationContext;

    const toolContext = new Context({invocationContext});

    await tool.runAsync({args: {}, toolContext});

    expect(mockClient.callTool).toHaveBeenCalledWith(
      {name: 'test-tool', arguments: {}},
      undefined,
      {signal: signal},
    );
  });

  it('uses originalName for callTool when provided', async () => {
    const mockTool: Tool = {
      name: 'prefixed_test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const mockClient = {
      callTool: vi.fn().mockResolvedValue({content: []}),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Client;

    const mockSessionManager = {
      createSession: vi.fn().mockResolvedValue(mockClient),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPSessionManager;

    const tool = new MCPTool(mockTool, mockSessionManager, 'test-tool');

    const controller = new AbortController();
    const signal = controller.signal;

    const invocationContext = {
      abortSignal: signal,
      session: {state: {}},
    } as unknown as InvocationContext;

    const toolContext = new Context({invocationContext});

    await tool.runAsync({args: {}, toolContext});

    expect(mockClient.callTool).toHaveBeenCalledWith(
      {name: 'test-tool', arguments: {}},
      undefined,
      {signal: signal},
    );
  });

  it('respects abort signal when callTool rejects', async () => {
    const mockTool: Tool = {
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const mockClient = {
      callTool: vi.fn().mockImplementation((_params, _extra, options) => {
        if (options?.signal?.aborted) {
          return Promise.reject(new Error('Aborted'));
        }
        return Promise.resolve({content: []});
      }),
    } as unknown as Client;

    const mockSessionManager = {
      createSession: vi.fn().mockResolvedValue(mockClient),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPSessionManager;

    const tool = new MCPTool(mockTool, mockSessionManager);

    const controller = new AbortController();
    controller.abort();
    const signal = controller.signal;

    const invocationContext = {
      abortSignal: signal,
      session: {state: {}},
    } as unknown as InvocationContext;

    const toolContext = new Context({invocationContext});

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'Aborted',
    );
  });

  it('closes session even when callTool throws an error', async () => {
    const mockTool: Tool = {
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const mockClient = {
      callTool: vi.fn().mockRejectedValue(new Error('Call failed')),
    } as unknown as Client;

    const mockSessionManager = {
      createSession: vi.fn().mockResolvedValue(mockClient),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPSessionManager;

    const tool = new MCPTool(mockTool, mockSessionManager);

    const invocationContext = {
      abortSignal: new AbortController().signal,
      session: {state: {}},
    } as unknown as InvocationContext;

    const toolContext = new Context({invocationContext});

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'Call failed',
    );

    // Assert that closeSession was still called despite the error
    expect(mockSessionManager.closeSession).toHaveBeenCalledWith(mockClient);
  });

  describe('initialization and declaration', () => {
    const sessionManager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'test'},
    });

    it('initializes BaseTool properties and satisfies isBaseTool', () => {
      const mcpTool: Tool = {
        name: 'test-tool',
        description: 'A test tool',
        inputSchema: {type: 'object', properties: {}},
      };

      const tool = new MCPTool(mcpTool, sessionManager);

      expect(isBaseTool(tool)).toBe(true);
      expect(tool.name).toBe('test-tool');
      expect(tool.description).toBe('A test tool');
      expect(tool.isLongRunning).toBe(false);
    });

    it('defaults description to an empty string when mcpTool.description is undefined', () => {
      const mcpTool: Tool = {
        name: 'undescribed-tool',
        inputSchema: {type: 'object', properties: {}},
      };

      const tool = new MCPTool(mcpTool, sessionManager);

      expect(isBaseTool(tool)).toBe(true);
      expect(tool.name).toBe('undescribed-tool');
      expect(tool.description).toBe('');
    });

    it('builds a FunctionDeclaration with converted inputSchema and outputSchema', () => {
      const mcpTool: Tool = {
        name: 'weather-tool',
        description: 'Gets weather for a city',
        inputSchema: {
          type: 'object',
          properties: {
            city: {type: 'string', description: 'City name'},
          },
          required: ['city'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            temperature: {type: 'number'},
          },
          required: ['temperature'],
        },
      };

      const tool = new MCPTool(mcpTool, sessionManager);

      expect(tool._getDeclaration()).toEqual({
        name: 'weather-tool',
        description: 'Gets weather for a city',
        parameters: {
          type: Type.OBJECT,
          properties: {
            city: {type: Type.STRING, description: 'City name'},
          },
          required: ['city'],
        },
        response: {
          type: Type.OBJECT,
          properties: {
            temperature: {type: Type.NUMBER},
          },
          required: ['temperature'],
        },
      });
    });

    it('leaves response undefined in FunctionDeclaration when outputSchema is omitted', () => {
      const mcpTool: Tool = {
        name: 'simple-tool',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      };

      const tool = new MCPTool(mcpTool, sessionManager);

      expect(tool._getDeclaration()).toEqual({
        name: 'simple-tool',
        description: undefined,
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
        response: undefined,
      });
    });
  });
});
