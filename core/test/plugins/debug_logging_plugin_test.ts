/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  BaseAgent,
  BaseTool,
  Context,
  createEvent,
  createEventActions,
  DebugLoggingPlugin,
  getLogger,
  InvocationContext,
  isDebugLoggingPlugin,
  LlmRequest,
  LlmResponse,
  PluginManager,
  Session,
  State,
} from '@google/adk';
import {Content} from '@google/genai';
import * as yaml from 'js-yaml';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const SENTINEL_ACCESS_TOKEN = 'sentinel-access-token-4f7a21';
const SENTINEL_REFRESH_TOKEN = 'sentinel-refresh-token-91cc03';
const SENTINEL_CLIENT_SECRET = 'sentinel-client-secret-b58d6e';
const SENTINEL_AUTH_CODE = 'sentinel-auth-code-2ad914';
const SENTINEL_CODE_VERIFIER = 'sentinel-code-verifier-7be055';
const SENTINEL_PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\nsentinel-key-body\n-----END PRIVATE KEY-----';

function createOAuthCredential(): AuthCredential {
  return {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      clientId: 'test-client-id',
      clientSecret: SENTINEL_CLIENT_SECRET,
      accessToken: SENTINEL_ACCESS_TOKEN,
      refreshToken: SENTINEL_REFRESH_TOKEN,
    },
  };
}

describe('DebugLoggingPlugin', () => {
  let tempDir: string;
  let debugOutputFile: string;
  let mockSession: Session;
  let mockInvocationContext: InvocationContext;
  let mockCallbackContext: Context;
  let mockToolContext: Context;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-debug-plugin-test-'));
    debugOutputFile = path.join(tempDir, 'debug_output.yaml');

    mockSession = {
      id: 'test-session-id',
      appName: 'test-app',
      userId: 'test-user',
      state: {key1: 'value1', key2: 123},
      events: [],
      lastUpdateTime: Date.now(),
    };

    mockInvocationContext = {
      invocationId: 'test-invocation-id',
      session: mockSession,
      userId: 'test-user',
      appName: 'test-app',
      branch: undefined,
      agent: {name: 'test-agent'} as unknown as BaseAgent,
    } as unknown as InvocationContext;

    mockCallbackContext = {
      invocationId: 'test-invocation-id',
      agentName: 'test-agent',
      invocationContext: mockInvocationContext,
      state: new State(),
    } as unknown as Context;

    mockToolContext = {
      invocationId: 'test-invocation-id',
      agentName: 'test-agent',
      functionCallId: 'test-function-call-id',
      invocationContext: mockInvocationContext,
      state: new State(),
    } as unknown as Context;
  });

  afterEach(() => {
    fs.rmSync(tempDir, {recursive: true, force: true});
    vi.restoreAllMocks();
  });

  describe('Initialization and Identification', () => {
    it('initializes with default values', () => {
      const plugin = new DebugLoggingPlugin();
      expect(plugin.name).toBe('debug_logging_plugin');
      expect(plugin.outputPath).toBe('adk_debug.yaml');
      expect(plugin.includeSessionState).toBe(true);
      expect(plugin.includeSystemInstruction).toBe(true);
      expect(isDebugLoggingPlugin(plugin)).toBe(true);
      expect(isDebugLoggingPlugin({})).toBe(false);
    });

    it('initializes with custom values', () => {
      const plugin = new DebugLoggingPlugin({
        name: 'custom_debug',
        outputPath: debugOutputFile,
        includeSessionState: false,
        includeSystemInstruction: false,
      });
      expect(plugin.name).toBe('custom_debug');
      expect(plugin.outputPath).toBe(debugOutputFile);
      expect(plugin.includeSessionState).toBe(false);
      expect(plugin.includeSystemInstruction).toBe(false);
    });
  });

  describe('Callbacks', () => {
    it('beforeRunCallback initializes debug state', async () => {
      const plugin = new DebugLoggingPlugin({outputPath: debugOutputFile});

      const result = await plugin.beforeRunCallback({
        invocationContext: mockInvocationContext,
      });

      expect(result).toBeUndefined();
      const state = plugin.getInvocationState(
        mockInvocationContext.invocationId,
      );
      expect(state).toBeDefined();
      expect(state!.invocation_id).toBe('test-invocation-id');
      expect(state!.session_id).toBe('test-session-id');
      expect(state!.entries).toHaveLength(1);
      expect(state!.entries[0].entry_type).toBe('invocation_start');
    });

    it('onUserMessageCallback logs user messages', async () => {
      const plugin = new DebugLoggingPlugin({outputPath: debugOutputFile});
      await plugin.beforeRunCallback({
        invocationContext: mockInvocationContext,
      });

      const userMessage: Content = {
        role: 'user',
        parts: [{text: 'Hello, world!'}],
      };

      const result = await plugin.onUserMessageCallback({
        invocationContext: mockInvocationContext,
        userMessage,
      });

      expect(result).toBeUndefined();
      const state = plugin.getInvocationState(
        mockInvocationContext.invocationId,
      )!;
      const entries = state.entries.filter(
        (e) => e.entry_type === 'user_message',
      );
      expect(entries).toHaveLength(1);
      const content = entries[0].data['content'] as Record<string, unknown>;
      expect(content['role']).toBe('user');
      expect(
        (content['parts'] as Array<Record<string, unknown>>)[0]['text'],
      ).toBe('Hello, world!');
    });

    it('beforeAgentCallback and afterAgentCallback log agent start and end', async () => {
      const plugin = new DebugLoggingPlugin({outputPath: debugOutputFile});
      await plugin.beforeRunCallback({
        invocationContext: mockInvocationContext,
      });

      const mockAgent = {name: 'test-agent'} as unknown as BaseAgent;
      await plugin.beforeAgentCallback({
        agent: mockAgent,
        callbackContext: mockCallbackContext,
      });
      await plugin.afterAgentCallback({
        agent: mockAgent,
        callbackContext: mockCallbackContext,
      });

      const state = plugin.getInvocationState(
        mockInvocationContext.invocationId,
      )!;
      const startEntries = state.entries.filter(
        (e) => e.entry_type === 'agent_start',
      );
      const endEntries = state.entries.filter(
        (e) => e.entry_type === 'agent_end',
      );
      expect(startEntries).toHaveLength(1);
      expect(startEntries[0].agent_name).toBe('test-agent');
      expect(endEntries).toHaveLength(1);
      expect(endEntries[0].agent_name).toBe('test-agent');
    });

    it('beforeModelCallback logs LLM requests', async () => {
      const plugin = new DebugLoggingPlugin({outputPath: debugOutputFile});
      await plugin.beforeRunCallback({
        invocationContext: mockInvocationContext,
      });

      const llmRequest: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [{role: 'user', parts: [{text: 'Test prompt'}]}],
        config: {
          systemInstruction: 'You are a helpful assistant.',
          temperature: 0.7,
        },
        liveConnectConfig: {},
        toolsDict: {
          search_tool: {name: 'search_tool'} as unknown as BaseTool,
        },
      };

      const result = await plugin.beforeModelCallback({
        callbackContext: mockCallbackContext,
        llmRequest,
      });

      expect(result).toBeUndefined();
      const state = plugin.getInvocationState(
        mockInvocationContext.invocationId,
      )!;
      const llmEntries = state.entries.filter(
        (e) => e.entry_type === 'llm_request',
      );
      expect(llmEntries).toHaveLength(1);
      expect(llmEntries[0].data['model']).toBe('gemini-2.5-flash');
      expect(llmEntries[0].data['content_count']).toBe(1);
      expect(llmEntries[0].data['tools']).toEqual(['search_tool']);
      const config = llmEntries[0].data['config'] as Record<string, unknown>;
      expect(config['system_instruction']).toBe('You are a helpful assistant.');
      expect(config['temperature']).toBe(0.7);
    });

    it('afterModelCallback logs LLM responses', async () => {
      const plugin = new DebugLoggingPlugin({outputPath: debugOutputFile});
      await plugin.beforeRunCallback({
        invocationContext: mockInvocationContext,
      });

      const llmResponse: LlmResponse = {
        content: {
          role: 'model',
          parts: [{text: 'Hello! How can I help?'}],
        },
        turnComplete: true,
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          totalTokenCount: 30,
        },
      };

      const result = await plugin.afterModelCallback({
        callbackContext: mockCallbackContext,
        llmResponse,
      });

      expect(result).toBeUndefined();
      const state = plugin.getInvocationState(
        mockInvocationContext.invocationId,
      )!;
      const llmEntries = state.entries.filter(
        (e) => e.entry_type === 'llm_response',
      );
      expect(llmEntries).toHaveLength(1);
      expect(llmEntries[0].data['turn_complete']).toBe(true);
      expect(
        (llmEntries[0].data['content'] as Record<string, unknown>)['role'],
      ).toBe('model');
      expect(llmEntries[0].data['usage_metadata']).toEqual({
        prompt_token_count: 10,
        candidates_token_count: 20,
        total_token_count: 30,
        cached_content_token_count: null,
      });
    });

    it('beforeToolCallback and afterToolCallback log tool calls and responses', async () => {
      const plugin = new DebugLoggingPlugin({outputPath: debugOutputFile});
      await plugin.beforeRunCallback({
        invocationContext: mockInvocationContext,
      });

      const mockTool = {name: 'test_tool'} as unknown as BaseTool;
      const toolArgs = {param1: 'value1', param2: 42};
      const resultData = {output: 'success', data: [1, 2, 3]};

      await plugin.beforeToolCallback({
        tool: mockTool,
        toolArgs,
        toolContext: mockToolContext,
      });
      await plugin.afterToolCallback({
        tool: mockTool,
        toolArgs,
        toolContext: mockToolContext,
        result: resultData,
      });

      const state = plugin.getInvocationState(
        mockInvocationContext.invocationId,
      )!;
      const callEntries = state.entries.filter(
        (e) => e.entry_type === 'tool_call',
      );
      const respEntries = state.entries.filter(
        (e) => e.entry_type === 'tool_response',
      );

      expect(callEntries).toHaveLength(1);
      expect(callEntries[0].data['tool_name']).toBe('test_tool');
      expect(callEntries[0].data['args']).toEqual({
        param1: 'value1',
        param2: 42,
      });

      expect(respEntries).toHaveLength(1);
      expect(respEntries[0].data['tool_name']).toBe('test_tool');
      expect(respEntries[0].data['result']).toEqual(resultData);
    });

    it('onEventCallback logs events', async () => {
      const plugin = new DebugLoggingPlugin({outputPath: debugOutputFile});
      await plugin.beforeRunCallback({
        invocationContext: mockInvocationContext,
      });

      const event = createEvent({
        author: 'test-agent',
        content: {
          role: 'model',
          parts: [{text: 'Response text'}],
        },
      });

      const result = await plugin.onEventCallback({
        invocationContext: mockInvocationContext,
        event,
      });

      expect(result).toBeUndefined();
      const state = plugin.getInvocationState(
        mockInvocationContext.invocationId,
      )!;
      const eventEntries = state.entries.filter(
        (e) => e.entry_type === 'event',
      );
      expect(eventEntries).toHaveLength(1);
      expect(eventEntries[0].data['author']).toBe('test-agent');
      expect(eventEntries[0].data['event_id']).toBe(event.id);
    });

    it('onModelErrorCallback and onToolErrorCallback log errors', async () => {
      const plugin = new DebugLoggingPlugin({outputPath: debugOutputFile});
      await plugin.beforeRunCallback({
        invocationContext: mockInvocationContext,
      });

      const llmRequest: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        liveConnectConfig: {},
        toolsDict: {},
      };
      const modelError = new TypeError('Test model error');
      await plugin.onModelErrorCallback({
        callbackContext: mockCallbackContext,
        llmRequest,
        error: modelError,
      });

      const mockTool = {name: 'test_tool'} as unknown as BaseTool;
      const toolError = new RangeError('Tool execution failed');
      await plugin.onToolErrorCallback({
        tool: mockTool,
        toolArgs: {param1: 'value1'},
        toolContext: mockToolContext,
        error: toolError,
      });

      const state = plugin.getInvocationState(
        mockInvocationContext.invocationId,
      )!;
      const modelErrorEntries = state.entries.filter(
        (e) => e.entry_type === 'llm_error',
      );
      const toolErrorEntries = state.entries.filter(
        (e) => e.entry_type === 'tool_error',
      );

      expect(modelErrorEntries).toHaveLength(1);
      expect(modelErrorEntries[0].data['error_type']).toBe('TypeError');
      expect(modelErrorEntries[0].data['error_message']).toBe(
        'Test model error',
      );

      expect(toolErrorEntries).toHaveLength(1);
      expect(toolErrorEntries[0].data['tool_name']).toBe('test_tool');
      expect(toolErrorEntries[0].data['error_type']).toBe('RangeError');
    });
  });

  describe('File Output', () => {
    it('afterRunCallback writes YAML document to file and cleans up state', async () => {
      const plugin = new DebugLoggingPlugin({outputPath: debugOutputFile});

      await plugin.beforeRunCallback({
        invocationContext: mockInvocationContext,
      });
      await plugin.onUserMessageCallback({
        invocationContext: mockInvocationContext,
        userMessage: {role: 'user', parts: [{text: 'Test message'}]},
      });
      await plugin.afterRunCallback({
        invocationContext: mockInvocationContext,
      });

      expect(fs.existsSync(debugOutputFile)).toBe(true);
      expect(
        plugin.getInvocationState(mockInvocationContext.invocationId),
      ).toBeUndefined();

      const raw = fs.readFileSync(debugOutputFile, 'utf-8');
      const documents = yaml.loadAll(raw) as Array<Record<string, unknown>>;

      expect(documents).toHaveLength(1);
      expect(documents[0]['invocation_id']).toBe('test-invocation-id');
      expect(documents[0]['session_id']).toBe('test-session-id');
      const entries = documents[0]['entries'] as Array<Record<string, unknown>>;
      expect(entries.length).toBeGreaterThanOrEqual(3);
    });

    it('includes or excludes session_state_snapshot based on includeSessionState', async () => {
      const fileWithState = path.join(tempDir, 'with_state.yaml');
      const fileWithoutState = path.join(tempDir, 'without_state.yaml');

      const pluginWith = new DebugLoggingPlugin({
        outputPath: fileWithState,
        includeSessionState: true,
      });
      await pluginWith.beforeRunCallback({
        invocationContext: mockInvocationContext,
      });
      await pluginWith.afterRunCallback({
        invocationContext: mockInvocationContext,
      });

      const pluginWithout = new DebugLoggingPlugin({
        outputPath: fileWithoutState,
        includeSessionState: false,
      });
      await pluginWithout.beforeRunCallback({
        invocationContext: mockInvocationContext,
      });
      await pluginWithout.afterRunCallback({
        invocationContext: mockInvocationContext,
      });

      const docsWith = yaml.loadAll(
        fs.readFileSync(fileWithState, 'utf-8'),
      ) as Array<{
        entries: Array<{entry_type: string; data: Record<string, unknown>}>;
      }>;
      const snapshotsWith = docsWith[0].entries.filter(
        (e) => e.entry_type === 'session_state_snapshot',
      );
      expect(snapshotsWith).toHaveLength(1);
      expect(
        (snapshotsWith[0].data['state'] as Record<string, unknown>)['key1'],
      ).toBe('value1');

      const docsWithout = yaml.loadAll(
        fs.readFileSync(fileWithoutState, 'utf-8'),
      ) as Array<{entries: Array<{entry_type: string}>}>;
      const snapshotsWithout = docsWithout[0].entries.filter(
        (e) => e.entry_type === 'session_state_snapshot',
      );
      expect(snapshotsWithout).toHaveLength(0);
    });

    it('multiple invocations append separate YAML documents to the same file', async () => {
      const plugin = new DebugLoggingPlugin({outputPath: debugOutputFile});

      const ctx1 = {
        ...mockInvocationContext,
        invocationId: 'invocation-1',
      } as unknown as InvocationContext;
      const ctx2 = {
        ...mockInvocationContext,
        invocationId: 'invocation-2',
      } as unknown as InvocationContext;

      await plugin.beforeRunCallback({invocationContext: ctx1});
      await plugin.afterRunCallback({invocationContext: ctx1});

      await plugin.beforeRunCallback({invocationContext: ctx2});
      await plugin.afterRunCallback({invocationContext: ctx2});

      const documents = yaml.loadAll(
        fs.readFileSync(debugOutputFile, 'utf-8'),
      ) as Array<Record<string, unknown>>;
      expect(documents).toHaveLength(2);
      expect(documents[0]['invocation_id']).toBe('invocation-1');
      expect(documents[1]['invocation_id']).toBe('invocation-2');
    });
  });

  describe('Serialization and System Instruction Options', () => {
    it('serializes content with text, functionCall, inlineData, and null', () => {
      const plugin = new DebugLoggingPlugin();
      expect(plugin.serializeContent(null)).toBeNull();

      const content: Content = {
        role: 'model',
        parts: [
          {text: 'Hello'},
          {
            functionCall: {
              id: 'fc-1',
              name: 'test_func',
              args: {arg1: 'val1'},
            },
          },
          {
            inlineData: {
              mimeType: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUg==',
            },
          },
        ],
      };

      const serialized = plugin.serializeContent(content)!;
      expect(serialized['role']).toBe('model');
      const parts = serialized['parts'] as Array<Record<string, unknown>>;
      expect(parts).toHaveLength(3);
      expect(parts[0]['text']).toBe('Hello');
      expect(parts[1]['function_call']).toEqual({
        id: 'fc-1',
        name: 'test_func',
        args: {arg1: 'val1'},
      });
      expect(parts[2]['inline_data']).toEqual({
        mime_type: 'image/png',
        display_name: null,
        _data_omitted: true,
      });
    });

    it('safeSerialize handles bytes and nested structures', () => {
      const plugin = new DebugLoggingPlugin();
      expect(plugin.safeSerialize(Buffer.from('binary data'))).toBe(
        '<bytes: 11 bytes>',
      );
      expect(
        plugin.safeSerialize({
          list: [1, 2, {nested: 'value'}],
          set: new Set([3, 4]),
          string: 'text',
        }),
      ).toEqual({
        list: [1, 2, {nested: 'value'}],
        set: [3, 4],
        string: 'text',
      });
    });

    it('includes only system_instruction_length when includeSystemInstruction is false', async () => {
      const plugin = new DebugLoggingPlugin({
        outputPath: debugOutputFile,
        includeSystemInstruction: false,
      });
      await plugin.beforeRunCallback({
        invocationContext: mockInvocationContext,
      });

      const llmRequest: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        config: {
          systemInstruction: 'Full system instruction text',
        },
        liveConnectConfig: {},
        toolsDict: {},
      };

      await plugin.beforeModelCallback({
        callbackContext: mockCallbackContext,
        llmRequest,
      });

      const state = plugin.getInvocationState(
        mockInvocationContext.invocationId,
      )!;
      const llmEntries = state.entries.filter(
        (e) => e.entry_type === 'llm_request',
      );
      const config = llmEntries[0].data['config'] as Record<string, unknown>;
      expect(config['system_instruction']).toBeUndefined();
      expect(config['system_instruction_length']).toBe(28);
    });
  });

  describe('Security and Credential Redaction', () => {
    it('redacts credentials in session state and stateDelta', async () => {
      mockInvocationContext.session.state = {
        key1: 'value1',
        'temp:oauth2_credential': createOAuthCredential(),
        'user:profile': {
          name: 'test-user',
          refresh_token: SENTINEL_REFRESH_TOKEN,
        },
      };

      const plugin = new DebugLoggingPlugin({outputPath: debugOutputFile});
      await plugin.beforeRunCallback({
        invocationContext: mockInvocationContext,
      });

      const event = createEvent({
        author: 'test-agent',
        actions: createEventActions({
          stateDelta: {
            'temp:oauth2_credential': createOAuthCredential(),
            counter: 7,
          },
        }),
      });
      await plugin.onEventCallback({
        invocationContext: mockInvocationContext,
        event,
      });
      await plugin.afterRunCallback({
        invocationContext: mockInvocationContext,
      });

      const raw = fs.readFileSync(debugOutputFile, 'utf-8');
      expect(raw).not.toContain(SENTINEL_ACCESS_TOKEN);
      expect(raw).not.toContain(SENTINEL_REFRESH_TOKEN);
      expect(raw).not.toContain(SENTINEL_CLIENT_SECRET);

      const documents = yaml.loadAll(raw) as Array<{
        entries: Array<{entry_type: string; data: Record<string, unknown>}>;
      }>;
      const snapshot = documents[0].entries.find(
        (e) => e.entry_type === 'session_state_snapshot',
      )!;
      const state = snapshot.data['state'] as Record<string, unknown>;
      expect(state['temp:oauth2_credential']).toBe('[REDACTED]');
      expect(
        (state['user:profile'] as Record<string, unknown>)['refresh_token'],
      ).toBe('[REDACTED]');
      expect((state['user:profile'] as Record<string, unknown>)['name']).toBe(
        'test-user',
      );
      expect(state['key1']).toBe('value1');
    });

    it('redacts credential objects nested under arbitrary keys or containers', () => {
      const plugin = new DebugLoggingPlugin();
      const result = plugin.safeSerialize({
        some_users_own_key: [
          {inner: [createOAuthCredential(), 'keep-me']},
          {label: 'deep', payload: createOAuthCredential()},
        ],
      }) as Record<string, unknown>;

      const nested = result['some_users_own_key'] as Array<
        Record<string, unknown>
      >;
      expect(nested[0]['inner']).toEqual(['[REDACTED]', 'keep-me']);
      expect(nested[1]).toEqual({label: 'deep', payload: '[REDACTED]'});
    });

    it('redacts hyphenated, camelCase, and scoped sensitive keys while preserving usage counters', () => {
      const plugin = new DebugLoggingPlugin();
      const result = plugin.safeSerialize({
        headers: {
          'X-Api-Key': SENTINEL_CLIENT_SECRET,
          'Proxy-Authorization': SENTINEL_ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
        oauth2: {
          auth_code: SENTINEL_AUTH_CODE,
          auth_response_uri: `https://x/cb?code=${SENTINEL_AUTH_CODE}`,
          code_verifier: SENTINEL_CODE_VERIFIER,
          client_id: 'test-client-id',
        },
        scoped: {
          api_key: SENTINEL_CLIENT_SECRET,
          'user:api_key': SENTINEL_CLIENT_SECRET,
          'app:client_secret': SENTINEL_CLIENT_SECRET,
          apiKey: SENTINEL_CLIENT_SECRET,
          bearer_token: SENTINEL_ACCESS_TOKEN,
          serviceAccountCredentials: SENTINEL_CLIENT_SECRET,
        },
        usage_metadata: {
          prompt_token_count: 12,
          candidates_token_count: 34,
          total_token_count: 46,
        },
        max_output_tokens: 1024,
      }) as Record<string, unknown>;

      expect(result['headers']).toEqual({
        'X-Api-Key': '[REDACTED]',
        'Proxy-Authorization': '[REDACTED]',
        'Content-Type': 'application/json',
      });
      expect(result['oauth2']).toEqual({
        auth_code: '[REDACTED]',
        auth_response_uri: '[REDACTED]',
        code_verifier: '[REDACTED]',
        client_id: 'test-client-id',
      });
      expect(
        Object.values(result['scoped'] as Record<string, unknown>),
      ).toEqual(Array(6).fill('[REDACTED]'));
      expect(result['usage_metadata']).toEqual({
        prompt_token_count: 12,
        candidates_token_count: 34,
        total_token_count: 46,
      });
      expect(result['max_output_tokens']).toBe(1024);
    });

    it('redacts armored private key blocks inside strings while preserving surrounding prose', () => {
      const plugin = new DebugLoggingPlugin();
      expect(
        plugin.safeSerialize(
          `here is my key ${SENTINEL_PRIVATE_KEY} please rotate it`,
        ),
      ).toBe('here is my key [REDACTED] please rotate it');

      expect(
        plugin.safeSerialize({
          pgp: '-----BEGIN PGP PRIVATE KEY BLOCK-----\nsentinel\n-----END PGP PRIVATE KEY BLOCK-----',
          rsa: '-----BEGIN RSA PRIVATE KEY-----\nsentinel\n-----END RSA PRIVATE KEY-----',
          unterminated: '-----BEGIN PRIVATE KEY-----\nsentinel-key-body\n',
          prose: 'notes about a PRIVATE KEY----- and -----BEGIN elsewhere',
        }),
      ).toEqual({
        pgp: '[REDACTED]',
        rsa: '[REDACTED]',
        unterminated: '[REDACTED]',
        prose: 'notes about a PRIVATE KEY----- and -----BEGIN elsewhere',
      });
    });

    it('bounds walk depth on deeply nested or cyclic structures', () => {
      const plugin = new DebugLoggingPlugin();
      let deep: unknown = {api_key: SENTINEL_CLIENT_SECRET};
      for (let i = 0; i < 60; i++) {
        deep = {level: deep};
      }

      const serialized = JSON.stringify(plugin.safeSerialize(deep));
      expect(serialized).toContain('<dict ...>');
      expect(serialized).not.toContain(SENTINEL_CLIENT_SECRET);
    });

    it.skipIf(process.platform === 'win32')(
      'writes output file with owner-only mode 0600 and warns if pre-existing file is world-readable',
      async () => {
        const plugin = new DebugLoggingPlugin({outputPath: debugOutputFile});
        await plugin.beforeRunCallback({
          invocationContext: mockInvocationContext,
        });
        await plugin.afterRunCallback({
          invocationContext: mockInvocationContext,
        });

        const mode = fs.statSync(debugOutputFile).mode & 0o777;
        expect(mode & 0o077).toBe(0);

        const worldReadableFile = path.join(tempDir, 'world_readable.yaml');
        fs.writeFileSync(worldReadableFile, '');
        fs.chmodSync(worldReadableFile, 0o644);

        const warnSpy = vi.spyOn(getLogger(), 'warn');
        const plugin2 = new DebugLoggingPlugin({outputPath: worldReadableFile});
        await plugin2.beforeRunCallback({
          invocationContext: mockInvocationContext,
        });
        await plugin2.afterRunCallback({
          invocationContext: mockInvocationContext,
        });

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('readable beyond its owner'),
        );
      },
    );
  });

  describe('PluginManager Integration', () => {
    it('registers and executes full lifecycle through PluginManager', async () => {
      const plugin = new DebugLoggingPlugin({outputPath: debugOutputFile});
      const manager = new PluginManager([plugin]);

      await manager.runBeforeRunCallback({
        invocationContext: mockInvocationContext,
      });
      await manager.runOnUserMessageCallback({
        invocationContext: mockInvocationContext,
        userMessage: {role: 'user', parts: [{text: 'Via PluginManager'}]},
      });
      await manager.runAfterRunCallback({
        invocationContext: mockInvocationContext,
      });

      const docs = yaml.loadAll(
        fs.readFileSync(debugOutputFile, 'utf-8'),
      ) as Array<{entries: Array<{entry_type: string}>}>;
      expect(docs).toHaveLength(1);
      expect(docs[0].entries.map((e) => e.entry_type)).toEqual([
        'invocation_start',
        'user_message',
        'session_state_snapshot',
        'invocation_end',
      ]);
    });
  });
});
