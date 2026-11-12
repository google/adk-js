/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {helpers, protos, v1} from '@google-cloud/aiplatform';
import type {common} from 'protobufjs';
import {getErrorMessage} from '../utils/error_utils.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';

/** Identifies the deployed Agent Engine that an {@link AgentEngineClient} calls. */
export interface AgentEngineConfig {
  project: string;
  location: string;
  reasoningEngineId: string;
  /**
   * Overrides the API endpoint. By default the endpoint is resolved from
   * `location`, and `global` resolves to `aiplatform.googleapis.com`.
   */
  apiEndpoint?: string;
}

/**
 * Arguments for a session operation on a deployed Agent Engine.
 *
 * The client sends `userId`, `sessionId` and `expireTime` as `user_id`,
 * `session_id` and `expire_time`, which are the argument names the remote
 * methods read. When both spellings are given, the snake_case value wins.
 * Other keys are sent unchanged.
 */
export interface SessionConfig {
  userId?: string;
  user_id?: string;
  sessionId?: string;
  session_id?: string;
  state?: Record<string, unknown>;
  ttl?: string;
  expireTime?: string;
  expire_time?: string;
  appName?: string;
  app_name?: string;
  /**
   * Overrides the remote class method that the client calls. The client sends
   * it on the request itself, never inside `input`.
   */
  classMethod?: string;
  [key: string]: unknown;
}

/**
 * Arguments for {@link AgentEngineClient.query} and
 * {@link AgentEngineClient.streamQuery}.
 *
 * The client sends `runConfig` and `stateDelta` as `run_config` and
 * `state_delta`, in addition to the renames that {@link SessionConfig}
 * describes.
 */
export interface QueryConfig extends SessionConfig {
  message: unknown;
  /**
   * The run configuration for the remote agent. The client renames only this
   * top-level key and sends the contents unchanged. Use the field names that
   * the remote engine expects, for example `max_llm_calls` for a Python
   * engine.
   */
  runConfig?: Record<string, unknown>;
  /** The same as {@link QueryConfig.runConfig}. When both are given, this wins. */
  run_config?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Arguments for {@link AgentEngineClient.getSession}. */
export type GetSessionConfig = SessionConfig;

/** Arguments for {@link AgentEngineClient.listSessions}. */
export type ListSessionsConfig = SessionConfig;

/** Arguments for {@link AgentEngineClient.deleteSession}. */
export type DeleteSessionConfig = SessionConfig;

/** Thrown when a call to a deployed Agent Engine fails. */
export class AgentExecutionError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AgentExecutionError';
  }
}

/** The protobuf conversion helpers of the lazily loaded SDK. */
type AiplatformHelpers = typeof helpers;

/** The SDK helpers and the gRPC client, created together on first use. */
interface LoadedClient {
  helpers: AiplatformHelpers;
  client: v1.ReasoningEngineExecutionServiceClient;
}

/** Parameters of `AgentEngineClient.callQueryMethod`. */
interface QueryMethodCall {
  config: SessionConfig;
  defaultClassMethod: string;
  errorPrefix: string;
}

/**
 * Top-level request keys that the remote methods read in snake_case, as
 * `[camelCase, snake_case]` pairs.
 */
const WIRE_KEY_ALIASES = [
  ['userId', 'user_id'],
  ['sessionId', 'session_id'],
  ['expireTime', 'expire_time'],
  ['runConfig', 'run_config'],
  ['stateDelta', 'state_delta'],
] as const;

/**
 * Builds the `input` payload of a request from a caller config.
 *
 * Only top-level keys change: nested objects such as `state` or `message` go
 * out as they are. `classMethod` is removed because it belongs on the request
 * itself, and `undefined` values are removed because `google.protobuf.Struct`
 * cannot represent them.
 */
function toWireInput(
  config: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const input: Record<string, unknown> = {...config};
  delete input['classMethod'];
  for (const [camel, snake] of WIRE_KEY_ALIASES) {
    input[snake] = input[snake] ?? input[camel];
    delete input[camel];
  }
  for (const key of Object.keys(input)) {
    if (input[key] === undefined) {
      delete input[key];
    }
  }
  return input;
}

/**
 * The concrete member of `helpers.toValue`'s declared return union. The
 * declaration is widened to `null | object | undefined | IValue` because the
 * helper also accepts protobuf messages; for a plain object it always returns
 * a `Value`.
 */
type ToValueResult = protos.google.protobuf.IValue | undefined;

/**
 * Wraps a request payload in the `google.protobuf.Struct` that the
 * ReasoningEngine `input` field expects.
 */
function buildInputStruct(
  sdkHelpers: AiplatformHelpers,
  input: object,
): protos.google.protobuf.IStruct | undefined {
  const value = sdkHelpers.toValue(input) as ToValueResult;

  return value?.structValue ?? undefined;
}

/**
 * Unwraps a `google.protobuf.Value` response payload into a plain JS value.
 *
 * `helpers.fromValue` is typed against protobufjs' `common.IValue`, which
 * declares `nullValue` as the literal `0`, while the generated aiplatform
 * protos declare it as the `NullValue` enum. The two shapes are otherwise
 * identical, so the named cast is safe and — unlike `any` — still breaks the
 * build if either side changes.
 */
function parseOutput(
  sdkHelpers: AiplatformHelpers,
  output: protos.google.protobuf.IValue,
): unknown {
  return sdkHelpers.fromValue(output as common.IValue);
}

/** Server-sent event fields that carry no payload. */
const IGNORED_SSE_FIELDS: ReadonlySet<string> = new Set([
  'event',
  'id',
  'retry',
]);

/** The end-of-stream marker some servers send in place of a payload. */
const DONE_SENTINEL = '[DONE]';

function parseFragment(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch (e) {
    throw new AgentExecutionError(
      `Failed to parse stream fragment: ${payload}`,
      e,
    );
  }
}

/**
 * Emits the server-sent event held in `dataLines`, then clears it.
 *
 * Emits nothing for an empty payload or for the `[DONE]` sentinel. Some servers
 * send one JSON value per `data` line with no blank line between events. When
 * the joined payload is not valid JSON, each line is parsed on its own, and the
 * original error is thrown only if that also fails.
 */
function* dispatchEvent(dataLines: string[]): Generator<unknown> {
  if (dataLines.length === 0) {
    return;
  }
  const lines = dataLines.splice(0);
  const payload = lines.join('\n').trim();
  if (payload === '' || payload === DONE_SENTINEL) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = parseFragment(payload);
  } catch (e) {
    if (lines.length === 1) {
      throw e;
    }
    const values: unknown[] = [];
    try {
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed !== '' && trimmed !== DONE_SENTINEL) {
          values.push(JSON.parse(trimmed));
        }
      }
    } catch {
      throw e;
    }
    yield* values;
    return;
  }
  yield parsed;
}

/**
 * Handles one line of a stream that is either server-sent events (SSE) or
 * newline-delimited JSON (NDJSON).
 *
 * SSE `data` lines collect in `dataLines` until a blank line ends the event.
 * When a new `data` line arrives and the buffered lines are already a complete
 * JSON value, the buffered event is dispatched immediately. Comment lines and
 * the `event`, `id` and `retry` fields are skipped. Any other line is one
 * NDJSON value. Leading spaces and tabs are removed before the field name is
 * read, so an indented `data:` line is still a data line.
 */
function* processLine(
  rawLine: string,
  dataLines: string[],
): Generator<unknown> {
  const line = (
    rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
  ).replace(/^[ \t]+/, '');
  if (line === '') {
    yield* dispatchEvent(dataLines);
    return;
  }
  if (line.startsWith(':')) {
    return;
  }

  const colon = line.indexOf(':');
  const field = colon === -1 ? line : line.slice(0, colon);
  if (IGNORED_SSE_FIELDS.has(field)) {
    return;
  }
  if (field === 'data') {
    if (dataLines.length === 1) {
      const buffered = dataLines[0].trim();
      if (buffered === DONE_SENTINEL) {
        yield* dispatchEvent(dataLines);
      } else if (buffered !== '') {
        try {
          JSON.parse(buffered);
          yield* dispatchEvent(dataLines);
        } catch {
          // Keep buffering until a blank line.
        }
      }
    }
    const value = colon === -1 ? '' : line.slice(colon + 1);
    dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    return;
  }

  yield* dispatchEvent(dataLines);
  const trimmed = line.trim();
  if (trimmed === '' || trimmed === DONE_SENTINEL) {
    return;
  }
  yield parseFragment(trimmed);
}

async function* parseStream(
  stream: AsyncIterable<unknown>,
): AsyncGenerator<unknown, void, unknown> {
  // One streaming decoder keeps a multi-byte character that is split across
  // two chunks intact.
  const decoder = new TextDecoder('utf-8');
  const dataLines: string[] = [];
  let buffer = '';
  for await (const chunk of stream) {
    const chunkData = (chunk as {data?: unknown})?.data;
    if (chunkData === undefined) {
      if (typeof chunk === 'object' && chunk !== null) {
        yield chunk;
      }
      continue;
    }

    buffer +=
      chunkData instanceof Uint8Array
        ? decoder.decode(chunkData, {stream: true})
        : String(chunkData);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // Keep the incomplete remaining part in buffer

    for (const line of lines) {
      yield* processLine(line, dataLines);
    }
  }

  // Flush whatever is left once the stream ends, including an event that has
  // no closing blank line.
  buffer += decoder.decode();
  for (const line of buffer.split('\n')) {
    yield* processLine(line, dataLines);
  }
  yield* dispatchEvent(dataLines);
}

/**
 * Calls an agent deployed to Vertex AI Agent Engine.
 *
 * The client loads the optional peer dependency `@google-cloud/aiplatform` on
 * its first call, not when it is constructed. Call
 * {@link AgentEngineClient.close} to release
 * the underlying gRPC channel.
 */
export class AgentEngineClient {
  private readonly apiEndpoint: string;
  private readonly reasoningEnginePath: string;
  private clientPromise?: Promise<LoadedClient>;

  constructor(config: AgentEngineConfig) {
    this.apiEndpoint =
      config.apiEndpoint ??
      (config.location === 'global'
        ? 'aiplatform.googleapis.com'
        : `${config.location}-aiplatform.googleapis.com`);
    this.reasoningEnginePath = `projects/${config.project}/locations/${config.location}/reasoningEngines/${config.reasoningEngineId}`;
  }

  /**
   * Creates a remote session.
   *
   * Calls the `async_create_session` class method unless `config.classMethod`
   * names another one.
   *
   * @returns The session payload returned by the Agent Engine. When
   *     `config.sessionId` is omitted the engine generates one, and this is the
   *     only place the caller can read it back from.
   */
  async createSession(config: SessionConfig): Promise<unknown> {
    return this.callQueryMethod({
      config,
      defaultClassMethod: 'async_create_session',
      errorPrefix: 'Failed to create session',
    });
  }

  /**
   * Reads a remote session.
   *
   * Calls the `async_get_session` class method unless `config.classMethod`
   * names another one.
   *
   * @throws {@link AgentExecutionError} if the user id or the session id is
   *     missing, or if the call fails.
   */
  async getSession(config: GetSessionConfig): Promise<unknown> {
    const userId = config.user_id ?? config.userId;
    const sessionId = config.session_id ?? config.sessionId;
    if (!userId || !sessionId) {
      throw new AgentExecutionError(
        'Failed to get session: user_id and session_id are required',
      );
    }
    return this.callQueryMethod({
      config,
      defaultClassMethod: 'async_get_session',
      errorPrefix: 'Failed to get session',
    });
  }

  /**
   * Lists the remote sessions of a user.
   *
   * Calls the `async_list_sessions` class method unless `config.classMethod`
   * names another one.
   */
  async listSessions(config: ListSessionsConfig): Promise<unknown> {
    return this.callQueryMethod({
      config,
      defaultClassMethod: 'async_list_sessions',
      errorPrefix: 'Failed to list sessions',
    });
  }

  /**
   * Deletes a remote session.
   *
   * Calls the `async_delete_session` class method unless `config.classMethod`
   * names another one.
   */
  async deleteSession(config: DeleteSessionConfig): Promise<void> {
    await this.callQueryMethod({
      config,
      defaultClassMethod: 'async_delete_session',
      errorPrefix: 'Failed to delete session',
    });
  }

  /**
   * Sends a query and waits for the whole response.
   *
   * Calls the `query` class method unless `config.classMethod` names another
   * one.
   */
  async query(config: QueryConfig): Promise<unknown> {
    return this.callQueryMethod({
      config,
      defaultClassMethod: 'query',
      errorPrefix: 'Failed to execute query',
    });
  }

  /**
   * Sends a query and yields each streamed response value.
   *
   * Calls the `async_stream_query` class method unless `config.classMethod`
   * names another one. The stream can be server-sent events or
   * newline-delimited JSON.
   */
  async *streamQuery(
    config: QueryConfig,
  ): AsyncGenerator<unknown, void, unknown> {
    try {
      const {helpers: sdkHelpers, client} = await this.getClient();
      const stream = client.streamQueryReasoningEngine({
        name: this.reasoningEnginePath,
        classMethod: config.classMethod ?? 'async_stream_query',
        input: buildInputStruct(sdkHelpers, toWireInput(config)),
      });
      yield* parseStream(stream);
    } catch (err: unknown) {
      // `parseStream` already reports fragment failures as an
      // AgentExecutionError; re-wrapping would nest the same message twice.
      if (err instanceof AgentExecutionError) {
        throw err;
      }
      throw new AgentExecutionError(
        `Failed to execute stream query: ${getErrorMessage(err)}`,
        err,
      );
    }
  }

  /**
   * Closes the underlying gRPC client.
   *
   * Does nothing if no call has created the client yet, and is safe to call
   * more than once. A later call creates a new client.
   */
  async close(): Promise<void> {
    const pending = this.clientPromise;
    if (!pending) {
      return;
    }
    this.clientPromise = undefined;

    let loaded: LoadedClient;
    try {
      loaded = await pending;
    } catch {
      // The call that started the creation already reported this failure, and
      // there is no client to close.
      return;
    }
    await loaded.client.close();
  }

  private async callQueryMethod({
    config,
    defaultClassMethod,
    errorPrefix,
  }: QueryMethodCall): Promise<unknown> {
    try {
      const {helpers: sdkHelpers, client} = await this.getClient();
      const [response] = await client.queryReasoningEngine({
        name: this.reasoningEnginePath,
        classMethod: config.classMethod ?? defaultClassMethod,
        input: buildInputStruct(sdkHelpers, toWireInput(config)),
      });
      return response.output
        ? parseOutput(sdkHelpers, response.output)
        : undefined;
    } catch (err: unknown) {
      throw new AgentExecutionError(
        `${errorPrefix}: ${getErrorMessage(err)}`,
        err,
      );
    }
  }

  /**
   * Resolves the SDK helpers and the gRPC client, loading the optional peer on
   * first use.
   *
   * A created client is kept. A failure is not kept, so the next call tries
   * again, for example once the peer is installed.
   */
  private getClient(): Promise<LoadedClient> {
    if (!this.clientPromise) {
      const promise = this.createClient();
      this.clientPromise = promise;
      promise.catch(() => {
        if (this.clientPromise === promise) {
          this.clientPromise = undefined;
        }
      });
    }
    return this.clientPromise;
  }

  private async createClient(): Promise<LoadedClient> {
    const aiplatform = await loadOptionalPeer(
      {packageName: '@google-cloud/aiplatform', feature: 'AgentEngineClient'},
      () => import('@google-cloud/aiplatform'),
    );
    return {
      helpers: aiplatform.helpers,
      client: new aiplatform.v1.ReasoningEngineExecutionServiceClient({
        apiEndpoint: this.apiEndpoint,
      }),
    };
  }
}
