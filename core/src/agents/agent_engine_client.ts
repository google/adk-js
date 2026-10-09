/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {helpers, protos, v1} from '@google-cloud/aiplatform';
import type {common} from 'protobufjs';

export interface AgentEngineConfig {
  project: string;
  location: string;
  reasoningEngineId: string;
}

export interface SessionConfig {
  userId?: string;
  sessionId?: string;
}

export interface QueryConfig extends SessionConfig {
  message: unknown;
  [key: string]: unknown;
}

export class AgentExecutionError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AgentExecutionError';
  }
}

/**
 * The concrete member of `helpers.toValue`'s declared return union. The
 * declaration is widened to `null | object | undefined | IValue` because the
 * helper also accepts protobuf messages; for a plain object it always returns
 * a `Value`.
 */
type ToValueResult = protos.google.protobuf.IValue | undefined;

/**
 * Wraps a request config in the `google.protobuf.Struct` that the
 * ReasoningEngine `input` field expects.
 */
function buildInputStruct(
  config: object,
): protos.google.protobuf.IStruct | undefined {
  const value = helpers.toValue(config) as ToValueResult;

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
function parseOutput(output: protos.google.protobuf.IValue): unknown {
  return helpers.fromValue(output as common.IValue);
}

/**
 * Parses a single SSE line (or the trailing buffer) into its JSON payload.
 *
 * Returns `undefined` for blank lines and for the `[DONE]` sentinel, neither of
 * which carry a payload. The single `data:` prefix check covers both the
 * `data: {...}` and `data:{...}` forms because the trailing `trim()` eats the
 * optional space.
 */
function parseFragment(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  const payload = trimmed.startsWith('data:')
    ? trimmed.slice(5).trim()
    : trimmed;
  if (payload === '[DONE]') return undefined;

  try {
    return JSON.parse(payload);
  } catch (e) {
    throw new AgentExecutionError(
      `Failed to parse stream fragment: ${payload}`,
      e,
    );
  }
}

async function* parseStream(
  stream: AsyncIterable<unknown>,
): AsyncGenerator<unknown, void, unknown> {
  let buffer = '';
  for await (const chunk of stream) {
    const chunkData = (chunk as {data?: unknown})?.data;
    if (chunkData === undefined) {
      if (typeof chunk === 'object' && chunk !== null) {
        yield chunk;
      }
      continue;
    }

    const dataStr =
      chunkData instanceof Uint8Array
        ? new TextDecoder().decode(chunkData)
        : String(chunkData);

    buffer += dataStr;
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep the incomplete remaining part in buffer

    for (const line of lines) {
      const fragment = parseFragment(line);
      if (fragment !== undefined) {
        yield fragment;
      }
    }
  }

  // Flush whatever is left once the stream ends.
  const last = parseFragment(buffer);
  if (last !== undefined) {
    yield last;
  }
}

export class AgentEngineClient {
  private client: v1.ReasoningEngineExecutionServiceClient;
  private reasoningEnginePath: string;

  constructor(config: AgentEngineConfig) {
    this.client = new v1.ReasoningEngineExecutionServiceClient({
      apiEndpoint: `${config.location}-aiplatform.googleapis.com`,
    });
    this.reasoningEnginePath = this.client.reasoningEnginePath(
      config.project,
      config.location,
      config.reasoningEngineId,
    );
  }

  /**
   * Creates a remote session.
   *
   * @returns The `create_session` payload returned by the Agent Engine. When
   *     `config.sessionId` is omitted the engine generates one, and this is the
   *     only place the caller can read it back from.
   */
  async createSession(config: SessionConfig): Promise<unknown> {
    try {
      const [response] = await this.client.queryReasoningEngine({
        name: this.reasoningEnginePath,
        classMethod: 'create_session',
        input: buildInputStruct(config),
      });
      return response.output ? parseOutput(response.output) : undefined;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AgentExecutionError(
        `Failed to create session: ${message}`,
        err,
      );
    }
  }

  async query(config: QueryConfig): Promise<unknown> {
    try {
      const [response] = await this.client.queryReasoningEngine({
        name: this.reasoningEnginePath,
        classMethod: 'query',
        input: buildInputStruct(config),
      });
      return response.output ? parseOutput(response.output) : undefined;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AgentExecutionError(`Failed to execute query: ${message}`, err);
    }
  }

  async *streamQuery(
    config: QueryConfig,
  ): AsyncGenerator<unknown, void, unknown> {
    try {
      const stream = this.client.streamQueryReasoningEngine({
        name: this.reasoningEnginePath,
        classMethod: 'query',
        input: buildInputStruct(config),
      });
      yield* parseStream(stream);
    } catch (err: unknown) {
      // `parseStream` already reports fragment failures as an
      // AgentExecutionError; re-wrapping would nest the same message twice.
      if (err instanceof AgentExecutionError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new AgentExecutionError(
        `Failed to execute stream query: ${message}`,
        err,
      );
    }
  }
}
