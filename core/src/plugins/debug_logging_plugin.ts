/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import * as yaml from 'js-yaml';
import * as fs from 'node:fs';

import {BaseAgent} from '../agents/base_agent.js';
import {Context} from '../agents/context.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {AuthCredentialTypes} from '../auth/auth_credential.js';
import {Event, isFinalResponse} from '../events/event.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {State} from '../sessions/state.js';
import {BaseTool} from '../tools/base_tool.js';
import {logger} from '../utils/logger.js';
import {toSnakeCaseKey} from '../utils/object_notation_utils.js';

import {BasePlugin} from './base_plugin.js';

const DEBUG_LOGGING_PLUGIN_SYMBOL = Symbol.for('google.adk.debugLoggingPlugin');

const REDACTED = '[REDACTED]';

const AUTH_CREDENTIAL_TYPES = new Set<string>([
  AuthCredentialTypes.API_KEY,
  AuthCredentialTypes.HTTP,
  AuthCredentialTypes.OAUTH2,
  AuthCredentialTypes.OPEN_ID_CONNECT,
  AuthCredentialTypes.SERVICE_ACCOUNT,
]);

/**
 * Mapping keys whose value is a secret, for credentials that reach the plugin
 * as plain objects rather than as credential models.
 */
const SENSITIVE_KEYS = new Set([
  'access_token',
  'api_key',
  'auth_code',
  'auth_response_uri',
  'authorization',
  'client_secret',
  'code_verifier',
  'google_access_id',
  'id_token',
  'password',
  'private_key',
  'private_key_id',
  'proxy_authorization',
  'refresh_token',
  'secret',
  'sig',
  'signature',
  'token',
  'x_amz_credential',
  'x_amz_signature',
  'x_api_key',
  'x_goog_credential',
  'x_goog_security_token',
  'x_goog_signature',
]);

/**
 * Substrings that name a secret wherever they sit in a key.
 */
const SENSITIVE_SUBSTRINGS = [
  'api_key',
  'credentials',
  'passwd',
  'password',
  'private_key',
  'secret',
] as const;

/**
 * A key ending in one of these names a secret (e.g., `bearer_token`,
 * `session_token`), while preserving usage counters like `prompt_token_count`.
 */
const SENSITIVE_SUFFIXES = ['_token'] as const;

/**
 * Session state keys are namespaced by scope. The scope is stripped before
 * matching so that `user:api_key` and `app:client_secret` are redacted.
 */
const STATE_PREFIXES = [State.APP_PREFIX, State.USER_PREFIX] as const;

/**
 * Matches armored private key blocks inside any string.
 */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;

/**
 * File mode restricting access to owner read/write only.
 */
const OUTPUT_FILE_MODE = 0o600;

/**
 * Bounds recursive object walking to avoid infinite loops on cyclic structures.
 */
const MAX_WALK_DEPTH = 20;

/**
 * Whether a mapping key names a credential-bearing value.
 */
function isSensitiveKey(key: unknown): boolean {
  if (typeof key !== 'string') {
    return false;
  }
  let normalized = toSnakeCaseKey(key);

  if (normalized.startsWith(State.TEMP_PREFIX)) {
    return true;
  }
  for (const prefix of STATE_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length);
      break;
    }
  }
  if (
    SENSITIVE_KEYS.has(normalized) ||
    SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  ) {
    return true;
  }
  return SENSITIVE_SUBSTRINGS.some((marker) => normalized.includes(marker));
}

/**
 * Blanks any armored private key block, leaving the rest of the string.
 */
function redactPrivateKeys(value: string): string {
  return String(value).replace(PRIVATE_KEY_BLOCK, REDACTED);
}

/**
 * Whether `obj` is a structural ADK credential object.
 */
function isCredentialObject(obj: unknown): boolean {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }
  const record = obj as Record<string, unknown>;
  const authType = record['authType'] ?? record['auth_type'];
  return typeof authType === 'string' && AUTH_CREDENTIAL_TYPES.has(authType);
}

/**
 * Options for configuring {@link DebugLoggingPlugin}.
 */
export interface DebugLoggingPluginOptions {
  /**
   * The name of the plugin instance.
   * @defaultValue 'debug_logging_plugin'
   */
  name?: string;

  /**
   * Path to the output YAML debug file.
   * @defaultValue 'adk_debug.yaml'
   */
  outputPath?: string;

  /**
   * Whether to include a session state snapshot at the end of each invocation.
   * @defaultValue true
   */
  includeSessionState?: boolean;

  /**
   * Whether to include full system instructions in LLM request logs.
   * @defaultValue true
   */
  includeSystemInstruction?: boolean;
}

/**
 * A single debug log entry recorded during an invocation.
 */
export interface DebugEntry {
  timestamp: string;
  entry_type: string;
  invocation_id?: string;
  agent_name?: string;
  data: Record<string, unknown>;
}

/**
 * Per-invocation debug state written as a YAML document.
 */
export interface InvocationDebugState {
  invocation_id: string;
  session_id: string;
  app_name: string;
  user_id?: string;
  start_time: string;
  entries: DebugEntry[];
}

/**
 * Type guard to check if an object is an instance of {@link DebugLoggingPlugin}.
 */
export function isDebugLoggingPlugin(obj: unknown): obj is DebugLoggingPlugin {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    DEBUG_LOGGING_PLUGIN_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[DEBUG_LOGGING_PLUGIN_SYMBOL] === true
  );
}

/**
 * A plugin that captures complete debug information to a YAML file.
 *
 * This plugin records detailed interaction data including:
 * - LLM requests (model, system instruction, contents, tools)
 * - LLM responses (content, usage metadata, errors)
 * - Function calls with arguments
 * - Function responses with results
 * - Events yielded from the runner
 * - Session state at the end of each invocation
 *
 * Each invocation is appended to the output file as a separate YAML document
 * (separated by `---`). Credentials, sensitive keys, `temp:`-scoped state keys,
 * and armored private key blocks are automatically redacted to `[REDACTED]`.
 */
export class DebugLoggingPlugin extends BasePlugin {
  readonly [DEBUG_LOGGING_PLUGIN_SYMBOL] = true;

  readonly outputPath: string;
  readonly includeSessionState: boolean;
  readonly includeSystemInstruction: boolean;

  private readonly invocationStates = new Map<string, InvocationDebugState>();
  private warnedAboutOutputMode = false;

  constructor(options: DebugLoggingPluginOptions = {}) {
    super(options.name ?? 'debug_logging_plugin');
    this.outputPath = options.outputPath ?? 'adk_debug.yaml';
    this.includeSessionState = options.includeSessionState ?? true;
    this.includeSystemInstruction = options.includeSystemInstruction ?? true;
  }

  /**
   * Exposes active invocation states for testing and inspection.
   */
  getInvocationState(invocationId: string): InvocationDebugState | undefined {
    return this.invocationStates.get(invocationId);
  }

  private getTimestamp(): string {
    return new Date().toISOString();
  }

  /**
   * Serializes a Gemini `Content` object to a dictionary for YAML output.
   */
  serializeContent(
    content: Content | null | undefined,
  ): Record<string, unknown> | null {
    if (!content) {
      return null;
    }

    const parts: Array<Record<string, unknown>> = [];
    if (content.parts) {
      for (const part of content.parts) {
        const partData: Record<string, unknown> = {};

        if (part.text) {
          partData['text'] = part.text;
        }

        if (part.functionCall) {
          partData['function_call'] = {
            id: part.functionCall.id ?? null,
            name: part.functionCall.name ?? null,
            args: this.safeSerialize(part.functionCall.args),
          };
        }

        if (part.functionResponse) {
          partData['function_response'] = {
            id: part.functionResponse.id ?? null,
            name: part.functionResponse.name ?? null,
            response: this.safeSerialize(part.functionResponse.response),
          };
        }

        if (part.inlineData) {
          partData['inline_data'] = {
            mime_type: part.inlineData.mimeType ?? null,
            display_name: part.inlineData.displayName ?? null,
            _data_omitted: true,
          };
        }

        if (part.fileData) {
          partData['file_data'] = {
            file_uri: part.fileData.fileUri ?? null,
            mime_type: part.fileData.mimeType ?? null,
          };
        }

        if (part.codeExecutionResult) {
          partData['code_execution_result'] = {
            outcome: String(part.codeExecutionResult.outcome ?? ''),
            output: part.codeExecutionResult.output ?? null,
          };
        }

        if (part.executableCode) {
          partData['executable_code'] = {
            language: String(part.executableCode.language ?? ''),
            code: part.executableCode.code ?? null,
          };
        }

        if (Object.keys(partData).length > 0) {
          parts.push(partData);
        }
      }
    }

    return {
      role: content.role ?? null,
      parts,
    };
  }

  /**
   * Safely serializes an arbitrary value to a YAML/JSON-compatible format with
   * credential, sensitive key, and private key redaction.
   */
  safeSerialize(obj: unknown, depth = 0): unknown {
    if (obj === null || obj === undefined) {
      return null;
    }
    if (isCredentialObject(obj)) {
      return REDACTED;
    }
    if (depth > MAX_WALK_DEPTH) {
      return Array.isArray(obj) ? '<list ...>' : '<dict ...>';
    }

    const childDepth = depth + 1;

    if (typeof obj === 'string') {
      return redactPrivateKeys(obj);
    }
    if (typeof obj === 'number' || typeof obj === 'boolean') {
      return obj;
    }
    if (obj instanceof Date) {
      return obj.toISOString();
    }
    if (Buffer.isBuffer(obj) || obj instanceof Uint8Array) {
      return `<bytes: ${obj.byteLength} bytes>`;
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.safeSerialize(item, childDepth));
    }
    if (obj instanceof Set) {
      return Array.from(obj).map((item) =>
        this.safeSerialize(item, childDepth),
      );
    }
    if (obj instanceof Map) {
      const result: Record<string, unknown> = {};
      for (const [k, v] of obj.entries()) {
        const keyStr = String(k);
        result[keyStr] = isSensitiveKey(keyStr)
          ? REDACTED
          : this.safeSerialize(v, childDepth);
      }
      return result;
    }
    if (typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (v === undefined) {
          continue;
        }
        result[k] = isSensitiveKey(k)
          ? REDACTED
          : this.safeSerialize(v, childDepth);
      }
      return result;
    }

    try {
      return String(obj);
    } catch {
      return '<unserializable>';
    }
  }

  private addEntry(
    invocationId: string,
    entryType: string,
    agentName?: string,
    data: Record<string, unknown> = {},
  ): void {
    const state = this.invocationStates.get(invocationId);
    if (!state) {
      logger.warn(
        `No debug state for invocation ${invocationId}, skipping entry`,
      );
      return;
    }

    const entry: DebugEntry = {
      timestamp: this.getTimestamp(),
      entry_type: entryType,
      invocation_id: invocationId,
      ...(agentName !== undefined ? {agent_name: agentName} : {}),
      data: (this.safeSerialize(data) as Record<string, unknown>) ?? {},
    };
    state.entries.push(entry);
  }

  override async onUserMessageCallback({
    invocationContext,
    userMessage,
  }: {
    invocationContext: InvocationContext;
    userMessage: Content;
  }): Promise<Content | undefined> {
    this.addEntry(invocationContext.invocationId, 'user_message', undefined, {
      content: this.serializeContent(userMessage),
    });
    return undefined;
  }

  override async beforeRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    const invocationId = invocationContext.invocationId;
    const session = invocationContext.session;

    const state: InvocationDebugState = {
      invocation_id: invocationId,
      session_id: session.id,
      app_name: session.appName,
      ...(invocationContext.userId ? {user_id: invocationContext.userId} : {}),
      start_time: this.getTimestamp(),
      entries: [],
    };
    this.invocationStates.set(invocationId, state);

    this.addEntry(
      invocationId,
      'invocation_start',
      invocationContext.agent?.name,
      {
        branch: invocationContext.branch ?? null,
      },
    );
    return undefined;
  }

  override async onEventCallback({
    invocationContext,
    event,
  }: {
    invocationContext: InvocationContext;
    event: Event;
  }): Promise<Event | undefined> {
    const invocationId = invocationContext.invocationId;

    const eventData: Record<string, unknown> = {
      event_id: event.id,
      author: event.author ?? null,
      content: this.serializeContent(event.content),
      is_final_response: isFinalResponse(event),
      partial: event.partial ?? null,
      turn_complete: event.turnComplete ?? null,
      branch: event.branch ?? null,
    };

    if (event.actions) {
      const actionsData: Record<string, unknown> = {};
      if (
        event.actions.stateDelta &&
        Object.keys(event.actions.stateDelta).length > 0
      ) {
        actionsData['state_delta'] = this.safeSerialize(
          event.actions.stateDelta,
        );
      }
      if (
        event.actions.artifactDelta &&
        Object.keys(event.actions.artifactDelta).length > 0
      ) {
        actionsData['artifact_delta'] = {...event.actions.artifactDelta};
      }
      if (event.actions.transferToAgent) {
        actionsData['transfer_to_agent'] = event.actions.transferToAgent;
      }
      if (event.actions.escalate) {
        actionsData['escalate'] = event.actions.escalate;
      }
      if (
        event.actions.requestedAuthConfigs &&
        Object.keys(event.actions.requestedAuthConfigs).length > 0
      ) {
        actionsData['requested_auth_configs'] = Object.keys(
          event.actions.requestedAuthConfigs,
        ).length;
      }
      if (Object.keys(actionsData).length > 0) {
        eventData['actions'] = actionsData;
      }
    }

    if (event.groundingMetadata) {
      eventData['has_grounding_metadata'] = true;
    }

    if (event.usageMetadata) {
      eventData['usage_metadata'] = {
        prompt_token_count: event.usageMetadata.promptTokenCount ?? null,
        candidates_token_count:
          event.usageMetadata.candidatesTokenCount ?? null,
        total_token_count: event.usageMetadata.totalTokenCount ?? null,
      };
    }

    if (event.errorCode) {
      eventData['error_code'] = event.errorCode;
      eventData['error_message'] = event.errorMessage ?? null;
    }

    if (event.longRunningToolIds && event.longRunningToolIds.length > 0) {
      eventData['long_running_tool_ids'] = [...event.longRunningToolIds];
    }

    this.addEntry(invocationId, 'event', event.author, eventData);
    return undefined;
  }

  override async afterRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    const invocationId = invocationContext.invocationId;
    const state = this.invocationStates.get(invocationId);

    if (!state) {
      logger.warn(
        `No debug state for invocation ${invocationId}, skipping write`,
      );
      return;
    }

    if (this.includeSessionState) {
      const session = invocationContext.session;
      this.addEntry(invocationId, 'session_state_snapshot', undefined, {
        state: this.safeSerialize(session.state),
        event_count: session.events?.length ?? 0,
      });
    }

    this.addEntry(invocationId, 'invocation_end');

    let fd: number | undefined;
    try {
      fd = fs.openSync(
        this.outputPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
        OUTPUT_FILE_MODE,
      );
      if (
        process.platform !== 'win32' &&
        !this.warnedAboutOutputMode &&
        (fs.fstatSync(fd).mode & 0o077) !== 0
      ) {
        this.warnedAboutOutputMode = true;
        logger.warn(
          `Debug output file ${this.outputPath} is readable beyond its owner and holds whole prompts and responses; restrict it to mode 600.`,
        );
      }
      const yamlDoc =
        '---\n' +
        yaml.dump(state, {
          noRefs: true,
          lineWidth: 120,
          sortKeys: false,
        });
      fs.writeFileSync(fd, yamlDoc, {encoding: 'utf-8'});
      logger.debug(
        `Wrote debug data for invocation ${invocationId} to ${this.outputPath}`,
      );
    } catch (e) {
      logger.error(`Failed to write debug data: ${e}`);
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore close errors
        }
      }
      this.invocationStates.delete(invocationId);
    }
  }

  override async beforeAgentCallback({
    callbackContext,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    this.addEntry(
      callbackContext.invocationId,
      'agent_start',
      callbackContext.agentName,
      {
        branch: callbackContext.invocationContext?.branch ?? null,
      },
    );
    return undefined;
  }

  override async afterAgentCallback({
    callbackContext,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    this.addEntry(
      callbackContext.invocationId,
      'agent_end',
      callbackContext.agentName,
    );
    return undefined;
  }

  override async beforeModelCallback({
    callbackContext,
    llmRequest,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    const requestData: Record<string, unknown> = {
      model: llmRequest.model ?? null,
      content_count: llmRequest.contents?.length ?? 0,
      contents: (llmRequest.contents ?? []).map((c) =>
        this.serializeContent(c),
      ),
    };

    if (llmRequest.toolsDict && Object.keys(llmRequest.toolsDict).length > 0) {
      requestData['tools'] = Object.keys(llmRequest.toolsDict);
    }

    if (llmRequest.config) {
      const config = llmRequest.config;
      const configData: Record<string, unknown> = {};

      if (this.includeSystemInstruction && config.systemInstruction) {
        configData['system_instruction'] = config.systemInstruction;
      } else if (config.systemInstruction) {
        if (typeof config.systemInstruction === 'string') {
          configData['system_instruction_length'] =
            config.systemInstruction.length;
        } else {
          configData['has_system_instruction'] = true;
        }
      }

      if (config.temperature !== undefined && config.temperature !== null) {
        configData['temperature'] = config.temperature;
      }
      if (config.topP !== undefined && config.topP !== null) {
        configData['top_p'] = config.topP;
      }
      if (config.topK !== undefined && config.topK !== null) {
        configData['top_k'] = config.topK;
      }
      if (
        config.maxOutputTokens !== undefined &&
        config.maxOutputTokens !== null
      ) {
        configData['max_output_tokens'] = config.maxOutputTokens;
      }
      if (config.responseMimeType) {
        configData['response_mime_type'] = config.responseMimeType;
      }
      if (config.responseSchema) {
        configData['has_response_schema'] = true;
      }

      if (Object.keys(configData).length > 0) {
        requestData['config'] = configData;
      }
    }

    this.addEntry(
      callbackContext.invocationId,
      'llm_request',
      callbackContext.agentName,
      requestData,
    );
    return undefined;
  }

  override async afterModelCallback({
    callbackContext,
    llmResponse,
  }: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    const responseData: Record<string, unknown> = {
      content: this.serializeContent(llmResponse.content),
      partial: llmResponse.partial ?? null,
      turn_complete: llmResponse.turnComplete ?? null,
    };

    if (llmResponse.errorCode) {
      responseData['error_code'] = llmResponse.errorCode;
      responseData['error_message'] = llmResponse.errorMessage ?? null;
    }

    if (llmResponse.usageMetadata) {
      responseData['usage_metadata'] = {
        prompt_token_count: llmResponse.usageMetadata.promptTokenCount ?? null,
        candidates_token_count:
          llmResponse.usageMetadata.candidatesTokenCount ?? null,
        total_token_count: llmResponse.usageMetadata.totalTokenCount ?? null,
        cached_content_token_count:
          llmResponse.usageMetadata.cachedContentTokenCount ?? null,
      };
    }

    if (llmResponse.groundingMetadata) {
      responseData['has_grounding_metadata'] = true;
    }

    if (llmResponse.finishReason) {
      responseData['finish_reason'] = String(llmResponse.finishReason);
    }

    if (llmResponse.modelVersion) {
      responseData['model_version'] = llmResponse.modelVersion;
    }

    this.addEntry(
      callbackContext.invocationId,
      'llm_response',
      callbackContext.agentName,
      responseData,
    );
    return undefined;
  }

  override async onModelErrorCallback({
    callbackContext,
    llmRequest,
    error,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
    error: Error;
  }): Promise<LlmResponse | undefined> {
    this.addEntry(
      callbackContext.invocationId,
      'llm_error',
      callbackContext.agentName,
      {
        error_type: error.name || 'Error',
        error_message: error.message || String(error),
        model: llmRequest.model ?? null,
      },
    );
    return undefined;
  }

  override async beforeToolCallback({
    tool,
    toolArgs,
    toolContext,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    this.addEntry(
      toolContext.invocationId,
      'tool_call',
      toolContext.agentName,
      {
        tool_name: tool.name,
        function_call_id: toolContext.functionCallId ?? null,
        args: this.safeSerialize(toolArgs),
      },
    );
    return undefined;
  }

  override async afterToolCallback({
    tool,
    toolContext,
    result,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    this.addEntry(
      toolContext.invocationId,
      'tool_response',
      toolContext.agentName,
      {
        tool_name: tool.name,
        function_call_id: toolContext.functionCallId ?? null,
        result: this.safeSerialize(result),
      },
    );
    return undefined;
  }

  override async onToolErrorCallback({
    tool,
    toolArgs,
    toolContext,
    error,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    error: Error;
  }): Promise<Record<string, unknown> | undefined> {
    this.addEntry(
      toolContext.invocationId,
      'tool_error',
      toolContext.agentName,
      {
        tool_name: tool.name,
        function_call_id: toolContext.functionCallId ?? null,
        args: this.safeSerialize(toolArgs),
        error_type: error.name || 'Error',
        error_message: error.message || String(error),
      },
    );
    return undefined;
  }
}
