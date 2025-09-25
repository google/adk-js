/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AudioTranscriptionConfig, Modality, ProactivityConfig, RealtimeInputConfig, SpeechConfig} from '@google/genai';

import {getLogger} from '../utils/logger.js';

const logger = getLogger();

/**
 * The streaming mode for the run config.
 */
export enum StreamingMode {
  NONE = 'none',
  SSE = 'sse',
  BIDI = 'bidi',
}

/**
 * Configs for runtime behavior of agents.
 */
export class RunConfig {
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
  saveInputBlobsAsArtifacts: boolean;

  /**
   * Whether to support CFC (Compositional Function Calling). Only applicable
   * for StreamingMode.SSE. If it's true. the LIVE API will be invoked. Since
   * only LIVE API supports CFC
   *
   * WARNING: This feature is **experimental** and its API or behavior may
   * change in future releases.
   */
  supportCfc: boolean;

  /**
   * Streaming mode, None or StreamingMode.SSE or StreamingMode.BIDI.
   */
  streamingMode: StreamingMode;

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
  enableAffectiveDialog: boolean;

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
   * A limit on the total number of llm calls for a given run.
   *
   * Valid Values:
   *   - More than 0 and less than sys.maxsize: The bound on the number of llm
   *     calls is enforced, if the value is set in this range.
   *   - Less than or equal to 0: This allows for unbounded number of llm calls.
   */
  maxLlmCalls: number;

  constructor(params: Partial<RunConfig> = {}) {
    this.speechConfig = params.speechConfig;
    this.responseModalities = params.responseModalities;
    this.saveInputBlobsAsArtifacts = params.saveInputBlobsAsArtifacts || false;
    this.supportCfc = params.supportCfc || false;
    this.streamingMode = params.streamingMode || StreamingMode.NONE;
    this.outputAudioTranscription = params.outputAudioTranscription;
    this.inputAudioTranscription = params.inputAudioTranscription;
    this.enableAffectiveDialog = params.enableAffectiveDialog || false;
    this.realtimeInputConfig = params.realtimeInputConfig;
    this.maxLlmCalls = validateMaxLlmCalls(params.maxLlmCalls || 500);
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
        'maxLlmCalls is less than or equal to 0. This will result in no enforcement on total number of llm calls that will be made for a run. This may not be ideal, as this could result in a never ending communication between the model and the agent in certain cases.');
  }
  return value;
}