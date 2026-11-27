/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {MCPConnectionParams} from '@google/adk';
import {
  Context,
  createMcpInstructionProvider,
  createSession,
  GlobalInstructionPlugin,
  InvocationContext,
  isMcpInstructionProvider,
  LlmAgent,
  McpInstructionProvider,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.hoisted(() => {
  vi.resetModules();
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn(),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: vi.fn(),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  return {
    StreamableHTTPClientTransport: vi.fn(),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => {
  return {
    SSEClientTransport: vi.fn(),
  };
});

const stdioParams: MCPConnectionParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: 'node', args: ['prompt_server.mjs']},
};

function createReadonlyContext(
  state: Record<string, unknown> = {},
  abortSignal?: AbortSignal,
): ReadonlyContext {
  const session = createSession({
    id: 'test-session',
    appName: 'test-app',
    userId: 'test-user',
    state,
  });
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    session,
    pluginManager: new PluginManager([]),
    abortSignal,
  });
  return new ReadonlyContext(invocationContext);
}

function mockClient(overrides: {
  getPrompt?: ReturnType<typeof vi.fn>;
  listPrompts?: ReturnType<typeof vi.fn>;
  close?: ReturnType<typeof vi.fn>;
}) {
  const connect = vi.fn().mockResolvedValue(undefined);
  const close = overrides.close ?? vi.fn().mockResolvedValue(undefined);
  const getPrompt = overrides.getPrompt ?? vi.fn();
  const listPrompts = overrides.listPrompts ?? vi.fn();
  vi.mocked(Client).mockImplementationOnce(function () {
    return {
      connect,
      close,
      getPrompt,
      listPrompts,
    } as unknown as Client;
  });
  return {connect, close, getPrompt, listPrompts};
}

describe('McpInstructionProvider', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('validates constructor options', () => {
    expect(
      () =>
        new McpInstructionProvider({
          connectionParams: undefined as unknown as MCPConnectionParams,
          promptName: 'support',
        }),
    ).toThrow('McpInstructionProvider requires connectionParams.');

    expect(
      () =>
        new McpInstructionProvider({
          connectionParams: stdioParams,
          promptName: '',
        }),
    ).toThrow('McpInstructionProvider requires a non-empty promptName.');

    expect(
      () =>
        new McpInstructionProvider({
          connectionParams: stdioParams,
          promptName: '   ',
        }),
    ).toThrow('McpInstructionProvider requires a non-empty promptName.');
  });

  it('identifies instances with isMcpInstructionProvider', () => {
    const provider = new McpInstructionProvider({
      connectionParams: stdioParams,
      promptName: 'support',
    });

    expect(provider.promptName).toBe('support');
    expect(isMcpInstructionProvider(provider)).toBe(true);
    expect(isMcpInstructionProvider({})).toBe(false);
    expect(isMcpInstructionProvider(null)).toBe(false);
    expect(isMcpInstructionProvider('support')).toBe(false);
  });

  it('concatenates text prompt messages without arguments and closes the session', async () => {
    const {getPrompt, close} = mockClient({
      getPrompt: vi.fn().mockResolvedValue({
        messages: [
          {role: 'user', content: {type: 'text', text: 'instruction part 1. '}},
          {
            role: 'assistant',
            content: {type: 'text', text: 'instruction part 2'},
          },
        ],
      }),
    });

    const provider = new McpInstructionProvider({
      connectionParams: stdioParams,
      promptName: 'test_prompt',
    });
    const instruction = await provider.getInstruction(createReadonlyContext());

    expect(instruction).toBe('instruction part 1. instruction part 2');
    expect(getPrompt).toHaveBeenCalledTimes(1);
    expect(getPrompt).toHaveBeenCalledWith({name: 'test_prompt'}, {});
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('never forwards session state automatically regardless of server declarations', async () => {
    const {getPrompt, listPrompts, close} = mockClient({
      listPrompts: vi.fn().mockResolvedValue({
        prompts: [
          {
            name: 'test_prompt',
            arguments: [{name: 'user:email'}, {name: 'adk_oauth2_credential'}],
          },
        ],
      }),
      getPrompt: vi.fn().mockResolvedValue({
        messages: [
          {role: 'user', content: {type: 'text', text: 'safe prompt'}},
        ],
      }),
    });

    const provider = new McpInstructionProvider({
      connectionParams: stdioParams,
      promptName: 'test_prompt',
    });
    const context = createReadonlyContext({
      'user:email': 'user@example.com',
      'adk_oauth2_credential': 'secret-token',
    });

    const instruction = await provider.getInstruction(context);

    expect(instruction).toBe('safe prompt');
    expect(listPrompts).not.toHaveBeenCalled();
    expect(getPrompt).toHaveBeenCalledWith({name: 'test_prompt'}, {});
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('sends a shallow copy of static arguments without leaking session state', async () => {
    const {getPrompt} = mockClient({
      getPrompt: vi.fn().mockResolvedValue({
        messages: [{role: 'user', content: {type: 'text', text: 'localized'}}],
      }),
    });
    const args = {locale: 'en-US'};
    const provider = new McpInstructionProvider({
      connectionParams: stdioParams,
      promptName: 'test_prompt',
      arguments: args,
    });
    const context = createReadonlyContext({
      'user:email': 'user@example.com',
    });

    const instruction = await provider.getInstruction(context);

    expect(instruction).toBe('localized');
    expect(getPrompt).toHaveBeenCalledWith(
      {name: 'test_prompt', arguments: {locale: 'en-US'}},
      {},
    );
    const passedArgs = getPrompt.mock.calls[0][0].arguments;
    expect(passedArgs).not.toBe(args);
  });

  it('sends only arguments returned by a synchronous or async callback', async () => {
    const first = mockClient({
      getPrompt: vi.fn().mockResolvedValue({
        messages: [{role: 'user', content: {type: 'text', text: 'sync ok'}}],
      }),
    });
    const syncProvider = new McpInstructionProvider({
      connectionParams: stdioParams,
      promptName: 'test_prompt',
      arguments: (ctx) => ({locale: String(ctx.state.get('locale'))}),
    });
    const context = createReadonlyContext({
      locale: 'en-US',
      adk_oauth2_credential: 'secret-token',
    });

    expect(await syncProvider.getInstruction(context)).toBe('sync ok');
    expect(first.getPrompt).toHaveBeenCalledWith(
      {name: 'test_prompt', arguments: {locale: 'en-US'}},
      {},
    );

    const second = mockClient({
      getPrompt: vi.fn().mockResolvedValue({
        messages: [{role: 'user', content: {type: 'text', text: 'async ok'}}],
      }),
    });
    const asyncProvider = new McpInstructionProvider({
      connectionParams: stdioParams,
      promptName: 'test_prompt',
      arguments: async (ctx) => ({role: String(ctx.state.get('role'))}),
    });
    const asyncContext = createReadonlyContext({role: 'reviewer'});

    expect(await asyncProvider.getInstruction(asyncContext)).toBe('async ok');
    expect(second.getPrompt).toHaveBeenCalledWith(
      {name: 'test_prompt', arguments: {role: 'reviewer'}},
      {},
    );
  });

  it('omits arguments when the callback returns undefined and avoids opening a session if it throws', async () => {
    const {getPrompt} = mockClient({
      getPrompt: vi.fn().mockResolvedValue({
        messages: [{role: 'user', content: {type: 'text', text: 'default'}}],
      }),
    });
    const undefinedArgsProvider = new McpInstructionProvider({
      connectionParams: stdioParams,
      promptName: 'test_prompt',
      arguments: () => undefined,
    });

    expect(
      await undefinedArgsProvider.getInstruction(createReadonlyContext()),
    ).toBe('default');
    expect(getPrompt).toHaveBeenCalledWith({name: 'test_prompt'}, {});

    const failingArgsProvider = new McpInstructionProvider({
      connectionParams: stdioParams,
      promptName: 'test_prompt',
      arguments: () => {
        throw new Error('missing required state');
      },
    });
    const priorCalls = vi.mocked(Client).mock.calls.length;
    await expect(
      failingArgsProvider.getInstruction(createReadonlyContext()),
    ).rejects.toThrow('missing required state');
    expect(vi.mocked(Client).mock.calls.length).toBe(priorCalls);
  });

  it('ignores non-text prompt messages while preserving text order', async () => {
    mockClient({
      getPrompt: vi.fn().mockResolvedValue({
        messages: [
          {role: 'user', content: {type: 'text', text: 'instruction part 1. '}},
          {
            role: 'user',
            content: {type: 'image', data: 'base64', mimeType: 'image/png'},
          },
          {
            role: 'user',
            content: {
              type: 'resource',
              resource: {uri: 'file:///a', text: 'ignored'},
            },
          },
          {role: 'user', content: {type: 'text', text: 'instruction part 2'}},
        ],
      }),
    });

    const provider = new McpInstructionProvider({
      connectionParams: stdioParams,
      promptName: 'test_prompt',
    });

    expect(await provider.getInstruction(createReadonlyContext())).toBe(
      'instruction part 1. instruction part 2',
    );
  });

  it('throws when getPrompt returns no messages and still closes the session', async () => {
    const {close} = mockClient({
      getPrompt: vi.fn().mockResolvedValue({messages: []}),
    });

    const provider = new McpInstructionProvider({
      connectionParams: stdioParams,
      promptName: 'empty_prompt',
    });

    await expect(
      provider.getInstruction(createReadonlyContext()),
    ).rejects.toThrow("Failed to load MCP prompt 'empty_prompt'.");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the MCP session even when getPrompt rejects', async () => {
    const {close} = mockClient({
      getPrompt: vi.fn().mockRejectedValue(new Error('transport failed')),
    });

    const provider = new McpInstructionProvider({
      connectionParams: stdioParams,
      promptName: 'broken_prompt',
    });

    await expect(
      provider.getInstruction(createReadonlyContext()),
    ).rejects.toThrow('transport failed');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('forwards stdio timeout and invocation abortSignal in request options', async () => {
    const {getPrompt} = mockClient({
      getPrompt: vi.fn().mockResolvedValue({
        messages: [{role: 'user', content: {type: 'text', text: 'timed'}}],
      }),
    });
    const controller = new AbortController();
    const provider = new McpInstructionProvider({
      connectionParams: {...stdioParams, timeout: 7},
      promptName: 'timed_prompt',
    });

    expect(
      await provider.getInstruction(
        createReadonlyContext({}, controller.signal),
      ),
    ).toBe('timed');
    expect(getPrompt).toHaveBeenCalledWith(
      {name: 'timed_prompt'},
      {timeout: 7000, signal: controller.signal},
    );
  });

  it('integrates with LlmAgent and GlobalInstructionPlugin without state interpolation', async () => {
    mockClient({
      getPrompt: vi.fn().mockResolvedValue({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: 'Follow literal template {do_not_inject}.',
            },
          },
        ],
      }),
    });

    const agent = new LlmAgent({
      name: 'prompt_agent',
      model: 'gemini-2.5-flash',
      instruction: createMcpInstructionProvider({
        connectionParams: stdioParams,
        promptName: 'agent_prompt',
      }),
    });

    const context = createReadonlyContext({do_not_inject: 'secret-value'});
    const canonical = await agent.canonicalInstruction(context);
    expect(canonical).toEqual({
      instruction: 'Follow literal template {do_not_inject}.',
      requireStateInjection: false,
    });

    mockClient({
      getPrompt: vi.fn().mockResolvedValue({
        messages: [
          {role: 'user', content: {type: 'text', text: 'Global policy.'}},
        ],
      }),
    });

    const plugin = new GlobalInstructionPlugin(
      createMcpInstructionProvider({
        connectionParams: stdioParams,
        promptName: 'global_policy',
      }),
    );
    const llmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: 'Agent instruction.'},
    };
    await plugin.beforeModelCallback({
      callbackContext: new Context({
        invocationContext: context.invocationContext,
      }),
      llmRequest,
    });

    expect(llmRequest.config.systemInstruction).toBe(
      'Global policy.\n\nAgent instruction.',
    );
  });

  it('closes active sessions via close()', async () => {
    let resolvePrompt!: (value: unknown) => void;
    const pendingPrompt = new Promise((resolve) => {
      resolvePrompt = resolve;
    });
    const {close} = mockClient({
      getPrompt: vi.fn().mockReturnValue(pendingPrompt),
    });

    const provider = new McpInstructionProvider({
      connectionParams: stdioParams,
      promptName: 'slow_prompt',
    });

    const inFlight = provider.getInstruction(createReadonlyContext());
    // Wait until createSession has registered the active client.
    await vi.waitFor(() => {
      expect(vi.mocked(Client)).toHaveBeenCalledTimes(1);
    });

    await provider.close();
    expect(close).toHaveBeenCalledTimes(1);

    resolvePrompt({
      messages: [{role: 'user', content: {type: 'text', text: 'done'}}],
    });
    expect(await inFlight).toBe('done');
  });
});
