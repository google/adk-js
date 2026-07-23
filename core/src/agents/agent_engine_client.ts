/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {helpers, v1} from '@google-cloud/aiplatform';

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
      const trimmed = line.trim();
      if (!trimmed) continue;

      let payload = trimmed;
      if (trimmed.startsWith('data: ')) {
        payload = trimmed.substring(6).trim();
      } else if (trimmed.startsWith('data:')) {
        payload = trimmed.substring(5).trim();
      }

      if (payload === '[DONE]') continue;

      try {
        yield JSON.parse(payload);
      } catch (e) {
        // If we can't parse a single line, it might be heavily fragmented without linebreaks,
        // but typically aiplatform streams are well-formed SSE lines or complete JSON lines.
        // We will just put it back to buffer if it's the last processed, or throw if it's earlier.
        throw new AgentExecutionError(
          `Failed to parse stream fragment: ${payload}`,
          e,
        );
      }
    }
  }

  // Handle remaining buffer
  const trimmed = buffer.trim();
  if (trimmed && trimmed !== '[DONE]') {
    let payload = trimmed;
    if (trimmed.startsWith('data: ')) payload = trimmed.substring(6).trim();
    else if (trimmed.startsWith('data:')) payload = trimmed.substring(5).trim();
    if (payload !== '[DONE]') {
      try {
        yield JSON.parse(payload);
      } catch (e) {
        throw new AgentExecutionError(
          `Failed to parse stream fragment: ${payload}`,
          e,
        );
      }
    }
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

  private buildInputStruct(
    config: unknown,
  ): Record<string, unknown> | undefined {
    if (!config) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (helpers.toValue(config) as any)?.structValue;
  }

  async createSession(config: SessionConfig): Promise<void> {
    try {
      await this.client.queryReasoningEngine({
        name: this.reasoningEnginePath,
        classMethod: 'create_session',
        input: this.buildInputStruct(config),
      });
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
        input: this.buildInputStruct(config),
      });
      if (!response.output) return undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return helpers.fromValue(response.output as any);
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
        input: this.buildInputStruct(config),
      });
      yield* parseStream(stream);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AgentExecutionError(
        `Failed to execute stream query: ${message}`,
        err,
      );
    }
  }
}
