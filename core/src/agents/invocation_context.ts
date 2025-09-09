/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {BaseArtifactService} from '../artifacts/base_artifact_service.js';
import {BaseCredentialService} from '../auth/credential_service/base_credential_service.js';
import {BaseMemoryService} from '../memory/base_memory_service.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {Session} from '../sessions/session.js';
import {randomUUID} from '../utils/env_aware_utils.js';

import {ActiveStreamingTool} from './active_streaming_tool.js';
import {BaseAgent} from './base_agent.js';
import {LiveRequestQueue} from './live_request_queue.js';
import {RunConfig} from './run_config.js';
import {TranscriptionEntry} from './transcription_entry.js';

interface InvocationContextParams {
  artifactService?: BaseArtifactService;
  sessionService?: BaseSessionService;
  memoryService?: BaseMemoryService;
  credentialService?: BaseCredentialService;
  invocationId: string;
  branch?: string;
  agent: BaseAgent;
  userContent?: Content;
  session: Session;
  endInvocation?: boolean;
  transcriptionCache?: TranscriptionEntry[];
  runConfig?: RunConfig;
  liveRequestQueue?: LiveRequestQueue;
  activeStreamingTools?: Record<string, ActiveStreamingTool>;
}

/**
 * A container to keep track of the cost of invocation.
 *
 * While we don't expect the metrics captured here to be a direct
 * representative of monetary cost incurred in executing the current
 * invocation, they in some ways have an indirect effect.
 */
class InvocationCostManager {
  private numberOfLlmCalls: number = 0;

  /**
   * Increments the number of llm calls and enforces the limit.
   *
   * @param runConfig the run config of the invocation.
   * @throws If number of llm calls made exceed the set threshold.
   */
  incrementAndEnforceLlmCallsLimit(runConfig?: RunConfig) {
    this.numberOfLlmCalls++;

    if (runConfig && runConfig.maxLlmCalls > 0 &&
        this.numberOfLlmCalls > runConfig.maxLlmCalls) {
      throw new Error(
          `Max number of llm calls limit of ${runConfig.maxLlmCalls} exceeded`);
    }
  }
}

/**
 * An invocation context represents the data of a single invocation of an agent.
 *
 * An invocation:
 *     1. Starts with a user message and ends with a final response.
 *     2. Can contain one or multiple agent calls.
 *     3. Is handled by runner.run().
 *
 *   An invocation runs an agent until it does not request to transfer to
 * another agent.
 *
 *   An agent call:
 *     1. Is handled by agent.run().
 *     2. Ends when agent.run() ends.
 *
 *   An LLM agent call is an agent with a BaseLLMFlow.
 *  An LLM agent call can contain one or multiple steps.
 *
 *  An LLM agent runs steps in a loop until:
 *    1. A final response is generated.
 *    2. The agent transfers to another agent.
 *    3. The end_invocation is set to true by any callbacks or tools.
 *
 *  A step:
 *    1. Calls the LLM only once and yields its response.
 *   2. Calls the tools and yields their responses if requested.
 *
 *  The summarization of the function response is considered another step, since
 *  it is another llm call.
 *  A step ends when it's done calling llm and tools, or if the end_invocation
 *  is set to true at any time.
 *
 *  ```
 *     ┌─────────────────────── invocation ──────────────────────────┐
 *     ┌──────────── llm_agent_call_1 ────────────┐ ┌─ agent_call_2 ─┐
 *     ┌──── step_1 ────────┐ ┌───── step_2 ──────┐
 *     [call_llm] [call_tool] [call_llm] [transfer]
 *  ```
 */
export class InvocationContext {
  readonly artifactService?: BaseArtifactService;
  readonly sessionService?: BaseSessionService;
  readonly memoryService?: BaseMemoryService;
  readonly credentialService?: BaseCredentialService;

  /**
   * The id of this invocation context.
   */
  readonly invocationId: string;

  /**
   * The branch of the invocation context.
   *
   * The format is like agent_1.agent_2.agent_3, where agent_1 is the parent of
   * agent_2, and agent_2 is the parent of agent_3.
   *
   * Branch is used when multiple sub-agents shouldn't see their peer agents'
   * conversation history.
   */
  branch?: string;

  /**
   * The current agent of this invocation context.
   */
  agent: BaseAgent;

  /**
   * The user content that started this invocation.
   */
  readonly userContent?: Content;

  /**
   * The current session of this invocation context.
   */
  readonly session: Session;

  /**
   * Whether to end this invocation.
   * Set to True in callbacks or tools to terminate this invocation.
   */
  endInvocation: boolean;

  /**
   * Caches necessary, data audio or contents, that are needed by transcription.
   */
  transcriptionCache?: TranscriptionEntry[];

  /**
   * Configurations for live agents under this invocation.
   */
  runConfig?: RunConfig;

  /**
   * A container to keep track of different kinds of costs incurred as a part of
   * this invocation.
   */
  private readonly invocationCostManager = new InvocationCostManager();

  /**
   * The queue to receive live requests.
   */
  liveRequestQueue?: LiveRequestQueue;

  /**
   * The running streaming tools of this invocation.
   */
  activeStreamingTools?: Record<string, ActiveStreamingTool>;

  /**
   * @param params The parameters for creating an invocation context.
   */
  constructor(params: InvocationContextParams) {
    this.artifactService = params.artifactService;
    this.sessionService = params.sessionService;
    this.memoryService = params.memoryService;
    this.invocationId = params.invocationId;
    this.branch = params.branch;
    this.agent = params.agent;
    this.userContent = params.userContent;
    this.session = params.session;
    this.endInvocation = params.endInvocation || false;
    this.transcriptionCache = params.transcriptionCache;
    this.runConfig = params.runConfig;
    this.liveRequestQueue = params.liveRequestQueue;
    this.activeStreamingTools = params.activeStreamingTools;
  }

  /**
   * The app name of the current session.
   */
  get appName() {
    return this.session.appName;
  }

  /**
   * The user ID of the current session.
   */
  get userId() {
    return this.session.userId;
  }

  /**
   * Tracks number of llm calls made.
   *
   * @throws If number of llm calls made exceed the set threshold.
   */
  incrementLlmCallCount() {
    this.invocationCostManager.incrementAndEnforceLlmCallsLimit(this.runConfig);
  }
}

export function newInvocationContextId(): string {
  return `e-${randomUUID()}`;
}
