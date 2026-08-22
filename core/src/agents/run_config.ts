/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AudioTranscriptionConfig,
  ContextWindowCompressionConfig,
  Modality,
  ProactivityConfig,
  RealtimeInputConfig,
  SpeechConfig,
} from '@google/genai';

import {logger} from '../utils/logger.js';

/**
 * The streaming mode for the run config.
 */
export enum StreamingMode {
  NONE = 'none',
  SSE = 'sse',
  /**
   * Bidirectional streaming. Not yet supported; passing this value to
   * `createRunConfig` throws. Use {@link StreamingMode.SSE} for token
   * streaming.
   */
  BIDI = 'bidi',
}

/**
 * Configs for runtime behavior of agents.
 */
export interface RunConfig {
  /**
   * Speech configuration for the live agent.
   */
  speechConfig?: SpeechConfig;

  /**
   * The output modalities. If not set, it's default to AUDIO.
   */
  responseModalities?: Modality[];

  /**
   * Whether or not to save the input blobs as artifacts.
   */
  saveInputBlobsAsArtifacts?: boolean;

  /**
   * Whether to support CFC (Compositional Function Calling). Only applicable
   * for StreamingMode.SSE. If it's true. the LIVE API will be invoked. Since
   * only LIVE API supports CFC
   *
   * WARNING: This feature is **experimental** and its API or behavior may
   * change in future releases.
   */
  supportCfc?: boolean;

  /**
   * Streaming mode. Supported values are {@link StreamingMode.NONE} and
   * {@link StreamingMode.SSE}. {@link StreamingMode.BIDI} is not yet
   * supported and is rejected by `createRunConfig`.
   */
  streamingMode?: StreamingMode;

  /**
   * Output audio transcription config.
   */
  outputAudioTranscription?: AudioTranscriptionConfig;

  /**
   * Input transcription for live agents with audio input from user.
   */
  inputAudioTranscription?: AudioTranscriptionConfig;

  /**
   * If enabled, the model will detect emotions and adapt its responses
   * accordingly.
   */
  enableAffectiveDialog?: boolean;

  /**
   * Configures the proactivity of the model. This allows the model to respond
   * proactively to the input and to ignore irrelevant input.
   */
  proactivity?: ProactivityConfig;

  /**
   * Realtime input config for live agents with audio input from user.
   */
  realtimeInputConfig?: RealtimeInputConfig;

  /**
   * Context window compression config. When the running context exceeds
   * `triggerTokens`, the server compresses older history to `targetTokens`.
   */
  contextWindowCompression?: ContextWindowCompressionConfig;

  /**
   * A limit on the total number of llm calls for a given run.
   *
   * Valid Values:
   *   - More than 0 and less than sys.maxsize: The bound on the number of llm
   *     calls is enforced, if the value is set in this range.
   *   - Less than or equal to 0: This allows for unbounded number of llm calls.
   */
  maxLlmCalls?: number;

  /**
   * If true, the agent loop will suspend on ANY tool call, allowing the client
   * to intercept and execute tools (Client-Side Tool Execution).
   */
  pauseOnToolCalls?: boolean;

  /**
   * If true, a plain-text user reply (e.g. "yes"/"no") may resolve a pending
   * `requireConfirmation` tool gate. Off by default so an ordinary chat message
   * on a web/API surface is never silently reinterpreted as a security
   * decision; interactive front-ends (e.g. `adk run`) opt in explicitly.
   */
  plainTextToolConfirmation?: boolean;

  /**
   * Request-level metadata passed from an incoming A2A request or caller.
   */
  a2aMetadata?: Record<string, unknown>;

  /**
   * If true, a `requireConfirmation` gate may be answered by a message that
   * arrived over A2A.
   *
   * Off by default: a remote peer is not the human operator, and a peer that
   * can post to the task would otherwise be able to approve a dangerous tool
   * call on the operator's behalf — the thing the gate exists to prevent. Turn
   * it on only where the peer is a trusted relay for a real person: a front-end
   * that renders the prompt and sends back what they chose.
   *
   * A deliberate divergence from adk-python, which refuses a remote-delivered
   * confirmation outright and offers no way back. The default matches; the
   * option does not exist there.
   */
  allowRemoteToolConfirmation?: boolean;

  /**
   * Set by the A2A executor to record that this run's message came from a
   * remote peer. Not part of the configuration surface: an application setting
   * it by hand is asserting something about the message's provenance that only
   * the transport can know.
   *
   * Read by the tool-confirmation resume path only. The other two interrupts a
   * peer can answer — `adk_request_credential` and `adk_request_input` — are
   * answerable by a client by design: a credential is something a client holds,
   * and an input request asks for data, not for judgement. Confirmation is the
   * one that asks a specific human to take responsibility for an action, which
   * is why it is the one a peer cannot stand in for.
   *
   * @internal
   */
  remoteDelivered?: boolean;
}

/**
 * Creates a {@link RunConfig} with production-safe defaults.
 *
 * Default values applied when the corresponding field is absent from `params`:
 * - `saveInputBlobsAsArtifacts` → `false`
 * - `supportCfc` → `false`
 * - `enableAffectiveDialog` → `false`
 * - `streamingMode` → {@link StreamingMode.NONE}
 * - `maxLlmCalls` → `500` (validated via `validateMaxLlmCalls`)
 * - `pauseOnToolCalls` → `false`
 *
 * @param params - Optional partial {@link RunConfig} overriding defaults.
 * @returns A merged {@link RunConfig} object.
 * @throws {Error} When `params.maxLlmCalls` exceeds `Number.MAX_SAFE_INTEGER`.
 * @throws {Error} When `params.streamingMode` is {@link StreamingMode.BIDI}.
 */
export function createRunConfig(params: Partial<RunConfig> = {}) {
  validateStreamingMode(params.streamingMode);
  return {
    saveInputBlobsAsArtifacts: false,
    supportCfc: false,
    enableAffectiveDialog: false,
    streamingMode: StreamingMode.NONE,
    pauseOnToolCalls: false,
    ...params,
    maxLlmCalls: validateMaxLlmCalls(params.maxLlmCalls ?? 500),
  };
}

function validateStreamingMode(streamingMode?: StreamingMode): void {
  if (streamingMode === StreamingMode.BIDI) {
    throw new Error(
      'StreamingMode.BIDI is not supported; use StreamingMode.SSE.',
    );
  }
}

function validateMaxLlmCalls(value: number): number {
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `maxLlmCalls should be less than ${Number.MAX_SAFE_INTEGER}.`,
    );
  }

  if (value <= 0) {
    logger.warn(
      'maxLlmCalls is less than or equal to 0. This will result in no enforcement on total number of llm calls that will be made for a run. This may not be ideal, as this could result in a never ending communication between the model and the agent in certain cases.',
    );
  }
  return value;
}
