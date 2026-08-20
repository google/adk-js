/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig, Schema} from '@google/genai';
import {context, trace} from '@opentelemetry/api';
import {FinishTaskTool} from '../tools/finish_task_tool.js';
import {FunctionTool} from '../tools/function_tool.js';
import {AsyncQueue} from '../utils/async_queue.js';
import {isBaseNode, type BaseNode} from '../workflow/base_node.js';
import {NodeContext} from '../workflow/node_context.js';
import {NodeTool} from '../workflow/nodes/node_tool.js';
import {runLlmAgentAsNode} from '../workflow/run_llm_agent_as_node.js';

import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';

import {BaseCodeExecutor} from '../code_executors/base_code_executor.js';

import {
  createEvent,
  createNewEventId,
  Event,
  getFunctionCalls,
  getFunctionResponses,
  isFinalResponse,
  populateClientFunctionCallId,
} from '../events/event.js';
import {isDefaultEventActions} from '../events/event_actions.js';

import {BaseExampleProvider} from '../examples/base_example_provider.js';
import {Example} from '../examples/example.js';
import {BaseLlm, isBaseLlm} from '../models/base_llm.js';
import {BaseLlmConnection} from '../models/base_llm_connection.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {LLMRegistry} from '../models/registry.js';

import {BaseTool, isBaseTool} from '../tools/base_tool.js';
import {BaseToolset} from '../tools/base_toolset.js';

import {logger} from '../utils/logger.js';
import {canUseOutputSchemaWithTools} from '../utils/output_schema_utils.js';
import {Context} from './context.js';

import {
  runAsyncGeneratorWithOtelContext,
  traceCallLlm,
  tracer,
} from '../telemetry/tracing.js';
import {parseWithSchema, SchemaLike} from '../utils/schema.js';
import {isZodObject, zodObjectToSchema} from '../utils/simple_zod_to_json.js';
import {BaseAgent, BaseAgentConfig} from './base_agent.js';
import {
  BaseLlmRequestProcessor,
  BaseLlmResponseProcessor,
} from './processors/base_llm_processor.js';

import {
  generateAuthEvent,
  generateRequestConfirmationEvent,
  getLongRunningFunctionCalls,
  handleFunctionCallsAsync,
} from './functions.js';

import {AUTH_PREPROCESSOR} from '../auth/auth_preprocessor.js';
import {BaseContextCompactor} from '../context/base_context_compactor.js';
import {InvocationContext, requireAgent} from './invocation_context.js';
import {LiveRequest, LiveRequestQueue} from './live_request_queue.js';
import {AGENT_TRANSFER_LLM_REQUEST_PROCESSOR} from './processors/agent_transfer_llm_request_processor.js';
import {BASIC_LLM_REQUEST_PROCESSOR} from './processors/basic_llm_request_processor.js';
import {CODE_EXECUTION_REQUEST_PROCESSOR} from './processors/code_execution_request_processor.js';
import {CONTENT_REQUEST_PROCESSOR} from './processors/content_request_processor.js';
import {ContextCompactorRequestProcessor} from './processors/context_compactor_request_processor.js';
import {IDENTITY_LLM_REQUEST_PROCESSOR} from './processors/identity_llm_request_processor.js';
import {INSTRUCTIONS_LLM_REQUEST_PROCESSOR} from './processors/instructions_llm_request_processor.js';
import {INTERACTIONS_REQUEST_PROCESSOR} from './processors/interactions_request_processor.js';
import {REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR} from './processors/request_confirmation_llm_request_processor.js';
import {REQUEST_INPUT_LLM_REQUEST_PROCESSOR} from './processors/request_input_llm_request_processor.js';
import {TOOL_FILTER_REQUEST_PROCESSOR} from './processors/tool_filter_request_processor.js';
import {ReadonlyContext} from './readonly_context.js';
import {StreamingMode} from './run_config.js';

/**
 * Maximum number of reconnect attempts on transient live connection failure
 * when a session resumption handle is available.
 */
const MAX_LIVE_RECONNECT_ATTEMPTS = 5;

/**
 * Delay before closing the parent connection on agent transfer. Gives the
 * server-side model a moment to flush any pending audio for the final turn
 * before teardown. Mirrors `DEFAULT_TRANSFER_AGENT_DELAY` (1.0s) in the Python
 * ADK live flow; the value is an empirical heuristic, not a guarantee.
 */
const TRANSFER_AGENT_DELAY_MS = 1000;

/**
 * Sentinel thrown from `runReceiveLoop` to break out of the receive iterator
 * and signal `runLiveFlow` to reconnect using the stored resumption handle.
 * Used when the server sends `goAway` or any other recoverable terminal.
 */
class LiveReconnectSignal extends Error {
  constructor(readonly reason: string) {
    super(`live reconnect requested: ${reason}`);
    this.name = 'LiveReconnectSignal';
  }
}

/**
 * Classifies errors that should trigger a reconnect attempt instead of
 * propagating. Matches the Python flow's allowlist of recoverable codes.
 */
function isRecoverableLiveError(err: unknown): boolean {
  if (err instanceof LiveReconnectSignal) return true;
  if (!(err instanceof Error)) return false;
  const code = (err as {code?: unknown}).code;
  // Standard WebSocket close codes treated as transient by the Python flow.
  if (code === 1006 || code === 1011 || code === 1012) {
    return true;
  }
  const message = err.message ?? '';
  return /ConnectionClosed|connection closed|ECONNRESET|socket hang up/i.test(
    message,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Copies the live-relevant fields from the run config onto the live connect
 * config so the model connection is opened with the caller's modalities,
 * speech, transcription, and proactivity settings.
 */
const LIVE_KEYS = [
  'responseModalities',
  'speechConfig',
  'outputAudioTranscription',
  'inputAudioTranscription',
  'realtimeInputConfig',
  'contextWindowCompression',
  'proactivity',
  'enableAffectiveDialog',
] as const;

function applyLiveRunConfig(
  runConfig: InvocationContext['runConfig'],
  llmRequest: LlmRequest,
): void {
  if (!runConfig) return;
  const liveConfig = (llmRequest.liveConnectConfig ??= {});
  for (const k of LIVE_KEYS) {
    if (runConfig[k] !== undefined) {
      (liveConfig as Record<string, unknown>)[k] = runConfig[k];
    }
  }
}

/**
 * Input/output schema type for agent.
 */
export type LlmAgentSchema =
  | z3.ZodObject<z3.ZodRawShape>
  | z4.ZodObject<z4.ZodRawShape>
  | Schema;

/** An object that can provide an instruction string. */
export type InstructionProvider = (
  context: ReadonlyContext,
) => string | Promise<string>;

/**
 * A callback that runs before a request is sent to the model.
 *
 * @param params.context The current callback context.
 * @param params.request The raw model request. Callback can mutate the request.
 * @returns The content to return to the user. When present, the model call
 *     will be skipped and the provided content will be returned to user.
 */
export type SingleBeforeModelCallback = (params: {
  context: Context;
  request: LlmRequest;
}) => LlmResponse | undefined | Promise<LlmResponse | undefined>;

/**
 * A single callback or a list of callbacks.
 *
 * When a list of callbacks is provided, the callbacks will be called in the
 * order they are listed until a callback does not return None.
 */
export type BeforeModelCallback =
  | SingleBeforeModelCallback
  | SingleBeforeModelCallback[];

/**
 * A callback that runs after a response is received from the model.
 *
 * @param params.context The current callback context.
 * @param params.response The actual model response.
 * @returns The content to return to the user. When present, the actual model
 *     response will be ignored and the provided content will be returned to
 *     user.
 */
export type SingleAfterModelCallback = (params: {
  context: Context;
  response: LlmResponse;
}) => LlmResponse | undefined | Promise<LlmResponse | undefined>;

/**
 * A single callback or a list of callbacks.
 *
 * When a list of callbacks is provided, the callbacks will be called in the
 order they are listed until a callback does not return None.
 */
export type AfterModelCallback =
  | SingleAfterModelCallback
  | SingleAfterModelCallback[];

/**
 * A callback that runs before a tool is called.
 *
 * @param params.tool The tool to be called.
 * @param params.args The arguments to the tool.
 * @param params.context Context for the tool call.
 * @returns The tool response. When present, the returned tool response will
 *     be used and the framework will skip calling the actual tool.
 */
export type SingleBeforeToolCallback = (params: {
  tool: BaseTool;
  args: Record<string, unknown>;
  context: Context;
}) =>
  | Record<string, unknown>
  | undefined
  | Promise<Record<string, unknown> | undefined>;

/**
 * A single callback or a list of callbacks.
 *
 * When a list of callbacks is provided, the callbacks will be called in the
 * order they are listed until a callback does not return None.
 */
export type BeforeToolCallback =
  | SingleBeforeToolCallback
  | SingleBeforeToolCallback[];

/**
 * A callback that runs after a tool is called.
 *
 * @param params.tool The tool to be called.
 * @param params.args The arguments to the tool.
 * @param params.context Context for the tool call.
 * @param params.response The response from the tool.
 * @returns When present, the returned record will be used as tool result.
 */
export type SingleAfterToolCallback = (params: {
  tool: BaseTool;
  args: Record<string, unknown>;
  context: Context;
  response: Record<string, unknown>;
}) =>
  | Record<string, unknown>
  | undefined
  | Promise<Record<string, unknown> | undefined>;

/**
 * A single callback or a list of callbacks.
 *
 * When a list of callbacks is provided, the callbacks will be called in the
 * order they are listed until acallback does not return None.
 */
export type AfterToolCallback =
  | SingleAfterToolCallback
  | SingleAfterToolCallback[];

/** A list of examples or an example provider. */
export type ExamplesUnion = Example[] | BaseExampleProvider;

/** A union of tool types that can be provided to an agent. */
export type ToolUnion = BaseTool | BaseToolset | BaseNode;

const ADK_AGENT_NAME_LABEL_KEY = 'adk_agent_name';

/**
 * The configuration options for creating an LLM-based agent.
 */
export interface LlmAgentConfig extends BaseAgentConfig {
  /**
   * The model to use for the agent.
   */
  model?: string | BaseLlm;

  /** Instructions for the LLM model, guiding the agent's behavior. */
  instruction?: string | InstructionProvider;

  /**
   * Instructions for all the agents in the entire agent tree.
   *
   * ONLY the globalInstruction in root agent will take effect.
   *
   * For example: use globalInstruction to make all agents have a stable
   * identity or personality.
   *
   * @deprecated Use GlobalInstructionPlugin instead.
   */
  globalInstruction?: string | InstructionProvider;

  /** Tools available to this agent. */
  tools?: ToolUnion[];

  /**
   * The additional content generation configurations.
   *
   * NOTE: not all fields are usable, e.g. tools must be configured via
   * `tools`, thinking_config must be configured via `planner` in LlmAgent.
   *
   * For example: use this config to adjust model temperature, configure safety
   * settings, etc.
   */
  generateContentConfig?: GenerateContentConfig;

  /**
   * Disallows LLM-controlled transferring to the parent agent.
   *
   * NOTE: Setting this as True also prevents this agent to continue reply to
   * the end-user. This behavior prevents one-way transfer, in which end-user
   * may be stuck with one agent that cannot transfer to other agents in the
   * agent tree.
   */
  disallowTransferToParent?: boolean;

  /** Disallows LLM-controlled transferring to the peer agents. */
  disallowTransferToPeers?: boolean;

  // TODO - b/425992518: consider more complex contex engineering mechanims.
  /**
   * Controls content inclusion in model requests.
   *
   * Options:
   *   default: Model receives relevant conversation history
   *   none: Model receives no prior history, operates solely on current
   *   instruction and input
   */
  includeContents?: 'default' | 'none';

  /**
   * The agent's execution mode when run as a workflow node.
   *
   * - `single_turn` (default): the agent runs once against the node input.
   * - `task`: the agent is given a `finish_task` tool and runs a multi-round
   *   loop until it calls `finish_task`, whose arguments (conforming to
   *   `outputSchema`) become the node output. Mirrors Python's `Agent(mode=...)`.
   */
  mode?: 'single_turn' | 'task';

  /** The input schema when agent is used as a tool. */
  inputSchema?: LlmAgentSchema;

  /** The output schema when agent replies. */
  outputSchema?: LlmAgentSchema;

  /**
   * The key in session state to store the output of the agent.
   *
   * Typically use cases:
   * - Extracts agent reply for later use, such as in tools, callbacks, etc.
   * - Connects agents to coordinate with each other.
   */
  outputKey?: string;

  /**
   * Callbacks to be called before calling the LLM.
   */
  beforeModelCallback?: BeforeModelCallback;

  /**
   * Callbacks to be called after calling the LLM.
   */
  afterModelCallback?: AfterModelCallback;

  /**
   * Callbacks to be called before calling the tool.
   */
  beforeToolCallback?: BeforeToolCallback;

  /**
   * Callbacks to be called after calling the tool.
   */
  afterToolCallback?: AfterToolCallback;

  /**
   * Processors to run before the LLM request is sent.
   */
  requestProcessors?: BaseLlmRequestProcessor[];

  /**
   * Processors to run after the LLM response is received.
   */
  responseProcessors?: BaseLlmResponseProcessor[];

  /**
   * A list of context compactors to evaluate in priority order.
   * Modifies the session history to keep context overhead within limits.
   */
  contextCompactors?: BaseContextCompactor[];

  /**
   * Instructs the agent to make a plan and execute it step by step.
   */
  codeExecutor?: BaseCodeExecutor;
}

async function convertToolUnionToTools(
  toolUnion: ToolUnion,
  context?: ReadonlyContext,
): Promise<BaseTool[]> {
  if (isBaseTool(toolUnion)) {
    return [toolUnion];
  }
  if (isBaseNode(toolUnion)) {
    // A node/Workflow passed as a tool is auto-wrapped as a NodeTool so the
    // model can call it (mirrors Python's Agent(tools=[node/workflow])).
    return [new NodeTool(toolUnion)];
  }
  return await toolUnion.getTools(context);
}

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all LlmAgent instances.
 */
const LLM_AGENT_SIGNATURE_SYMBOL = Symbol.for('google.adk.llmAgent');

/**
 * Type guard to check if an object is an instance of LlmAgent.
 * @param obj The object to check.
 * @returns True if the object is an instance of LlmAgent, false otherwise.
 */
export function isLlmAgent(obj: unknown): obj is LlmAgent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    LLM_AGENT_SIGNATURE_SYMBOL in obj &&
    obj[LLM_AGENT_SIGNATURE_SYMBOL] === true
  );
}

/**
 * An agent that uses a large language model to generate responses.
 */
export class LlmAgent extends BaseAgent<LlmAgentConfig> {
  /** A unique symbol to identify ADK LLM agent class. */
  readonly [LLM_AGENT_SIGNATURE_SYMBOL] = true;

  model?: string | BaseLlm;
  instruction: string | InstructionProvider;
  /** @deprecated Use GlobalInstructionPlugin instead. */
  globalInstruction: string | InstructionProvider;
  tools: ToolUnion[];
  generateContentConfig?: GenerateContentConfig;
  disallowTransferToParent: boolean;
  disallowTransferToPeers: boolean;
  includeContents: 'default' | 'none';

  /**
   * Whether {@link includeContents} was set by the caller rather than defaulted.
   *
   * A workflow node runs its agent for a single turn on the input the graph
   * handed it, so the agent must not also read the surrounding conversation —
   * unless the author asked for it. Mirrors Python checking
   * `'include_contents' in agent.model_fields_set`.
   */
  readonly includeContentsExplicit: boolean;
  mode?: 'single_turn' | 'task';
  inputSchema?: Schema;
  outputSchema?: Schema;
  /**
   * The input schema exactly as it was supplied, before conversion into the
   * genai dialect.
   *
   * `inputSchema` is normalized to a genai `Schema` because that is what the
   * model API and function declarations require, but that conversion is lossy:
   * a Zod refinement, transform, or custom error message has no genai
   * equivalent. Validation therefore uses the original, falling back to the
   * converted form when the schema was given in the genai dialect to begin
   * with.
   */
  readonly inputSchemaSource?: SchemaLike;
  /** The output schema as supplied — see {@link inputSchemaSource}. */
  readonly outputSchemaSource?: SchemaLike;
  outputKey?: string;
  private _finishTaskTool?: FinishTaskTool;
  beforeModelCallback?: BeforeModelCallback;
  afterModelCallback?: AfterModelCallback;
  beforeToolCallback?: BeforeToolCallback;
  afterToolCallback?: AfterToolCallback;
  requestProcessors: BaseLlmRequestProcessor[];
  responseProcessors: BaseLlmResponseProcessor[];
  codeExecutor?: BaseCodeExecutor;

  constructor(config: LlmAgentConfig) {
    // Node defaults for an agent used in a graph, matching adk-python's
    // `build_node`: an agent re-runs on resume (its turn is what the reply is
    // addressed to), and a task-mode agent holds the graph until it produces an
    // output, since a turn that only asks the user a question produces none.
    super({
      ...config,
      rerunOnResume: config.rerunOnResume ?? true,
      waitForOutput: config.waitForOutput ?? config.mode === 'task',
    });
    this.model = config.model;
    this.instruction = config.instruction ?? '';
    this.globalInstruction = config.globalInstruction ?? '';
    this.tools = config.tools ?? [];
    this.generateContentConfig = config.generateContentConfig;
    this.disallowTransferToParent = config.disallowTransferToParent ?? false;
    this.disallowTransferToPeers = config.disallowTransferToPeers ?? false;
    this.includeContents = config.includeContents ?? 'default';
    this.includeContentsExplicit = config.includeContents !== undefined;
    this.inputSchemaSource = config.inputSchema;
    this.outputSchemaSource = config.outputSchema;
    this.inputSchema = isZodObject(config.inputSchema)
      ? zodObjectToSchema(config.inputSchema)
      : config.inputSchema;
    this.outputSchema = isZodObject(config.outputSchema)
      ? zodObjectToSchema(config.outputSchema)
      : config.outputSchema;
    this.mode = config.mode;
    this.outputKey = config.outputKey;
    this.beforeModelCallback = config.beforeModelCallback;
    this.afterModelCallback = config.afterModelCallback;
    this.beforeToolCallback = config.beforeToolCallback;
    this.afterToolCallback = config.afterToolCallback;
    this.codeExecutor = config.codeExecutor;

    // TODO - b/425992518: Define these processor arrays.
    // Orders matter, don't change. Append new processors to the end
    this.requestProcessors = config.requestProcessors ?? [
      BASIC_LLM_REQUEST_PROCESSOR,
      AUTH_PREPROCESSOR,
      IDENTITY_LLM_REQUEST_PROCESSOR,
      INSTRUCTIONS_LLM_REQUEST_PROCESSOR,
      REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR,
      REQUEST_INPUT_LLM_REQUEST_PROCESSOR,
      CONTENT_REQUEST_PROCESSOR,
      INTERACTIONS_REQUEST_PROCESSOR,
      CODE_EXECUTION_REQUEST_PROCESSOR,
      TOOL_FILTER_REQUEST_PROCESSOR,
    ];

    if (
      !config.requestProcessors &&
      config.contextCompactors &&
      config.contextCompactors.length > 0
    ) {
      // Find where CONTENT_REQUEST_PROCESSOR is to place compaction immediately before it.
      const contentIndex = this.requestProcessors.indexOf(
        CONTENT_REQUEST_PROCESSOR,
      );
      if (contentIndex !== -1) {
        this.requestProcessors.splice(
          contentIndex,
          0,
          new ContextCompactorRequestProcessor(config.contextCompactors),
        );
      } else {
        this.requestProcessors.push(
          new ContextCompactorRequestProcessor(config.contextCompactors),
        );
      }
    }

    this.responseProcessors = config.responseProcessors ?? [];

    // Preserve the agent transfer behavior.
    const agentTransferDisabled =
      this.disallowTransferToParent &&
      this.disallowTransferToPeers &&
      !this.subAgents?.length;
    if (!agentTransferDisabled) {
      this.requestProcessors.push(AGENT_TRANSFER_LLM_REQUEST_PROCESSOR);
    }

    // Validate generateContentConfig.
    if (config.generateContentConfig) {
      if (config.generateContentConfig.tools) {
        throw new Error('All tools must be set via LlmAgent.tools.');
      }
      if (config.generateContentConfig.systemInstruction) {
        throw new Error(
          'System instruction must be set via LlmAgent.instruction.',
        );
      }
      if (config.generateContentConfig.responseSchema) {
        throw new Error(
          'Response schema must be set via LlmAgent.output_schema.',
        );
      }
    } else {
      this.generateContentConfig = {};
    }

    // Validate output schema related configurations.
    if (this.outputSchema) {
      const transferRequested =
        config.disallowTransferToParent === false ||
        config.disallowTransferToPeers === false ||
        !!this.subAgents?.length;
      if (transferRequested) {
        logger.warn(
          `Invalid config for agent ${
            this.name
          }: outputSchema cannot co-exist with agent transfer configurations. Setting disallowTransferToParent=true, disallowTransferToPeers=true`,
        );
      }
      this.disallowTransferToParent = true;
      this.disallowTransferToPeers = true;
    }
  }

  /**
   * The resolved BaseLlm instance.
   *
   * When not set, the agent will inherit the model from its ancestor.
   */
  get canonicalModel(): BaseLlm {
    if (isBaseLlm(this.model)) {
      return this.model;
    }

    if (typeof this.model === 'string' && this.model) {
      return LLMRegistry.newLlm(this.model);
    }

    let ancestorAgent = this.parentAgent;
    while (ancestorAgent) {
      if (isLlmAgent(ancestorAgent)) {
        return ancestorAgent.canonicalModel;
      }
      ancestorAgent = ancestorAgent.parentAgent;
    }
    throw new Error(`No model found for ${this.name}.`);
  }

  /**
   * The `finish_task` tool for this agent (task mode). Lazily created and cached
   * so its declaration (derived from `outputSchema`) is stable across turns.
   */
  get finishTaskTool(): FinishTaskTool {
    if (!this._finishTaskTool) {
      this._finishTaskTool = new FinishTaskTool(this.outputSchema);
    }
    return this._finishTaskTool;
  }

  /**
   * The resolved instruction field to construct instruction for this
   * agent.
   *
   * This method is only for use by Agent Development Kit.
   * @param context The context to retrieve the session state.
   * @returns The resolved instruction field.
   */
  async canonicalInstruction(
    context: ReadonlyContext,
  ): Promise<{instruction: string; requireStateInjection: boolean}> {
    if (typeof this.instruction === 'string') {
      return {instruction: this.instruction, requireStateInjection: true};
    }
    return {
      instruction: await this.instruction(context),
      requireStateInjection: false,
    };
  }

  /**
   * The resolved globalInstruction field to construct global instruction.
   *
   * This method is only for use by Agent Development Kit.
   * @param context The context to retrieve the session state.
   * @returns The resolved globalInstruction field.
   * @deprecated Use GlobalInstructionPlugin instead.
   */
  async canonicalGlobalInstruction(
    context: ReadonlyContext,
  ): Promise<{instruction: string; requireStateInjection: boolean}> {
    if (typeof this.globalInstruction === 'string') {
      return {
        instruction: this.globalInstruction,
        requireStateInjection: true,
      };
    }
    return {
      instruction: await this.globalInstruction(context),
      requireStateInjection: false,
    };
  }

  /**
   * The resolved tools field as a list of BaseTool based on the context.
   *
   * This method is only for use by Agent Development Kit.
   */
  async canonicalTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const resolvedTools: BaseTool[] = [];
    for (const toolUnion of this.tools) {
      const tools = await convertToolUnionToTools(toolUnion, context);
      resolvedTools.push(...tools);
    }
    return resolvedTools;
  }

  /**
   * Normalizes a callback or an array of callbacks into an array of callbacks.
   *
   * @param callback The callback or an array of callbacks.
   * @returns An array of callbacks.
   */
  private static normalizeCallbackArray<T>(callback?: T | T[]): T[] {
    if (!callback) {
      return [];
    }
    if (Array.isArray(callback)) {
      return callback;
    }
    return [callback];
  }

  /**
   * The resolved beforeModelCallback field as a list of
   * SingleBeforeModelCallback.
   *
   * This method is only for use by Agent Development Kit.
   */
  get canonicalBeforeModelCallbacks(): SingleBeforeModelCallback[] {
    return LlmAgent.normalizeCallbackArray(this.beforeModelCallback);
  }

  /**
   * The resolved afterModelCallback field as a list of
   * SingleAfterModelCallback.
   *
   * This method is only for use by Agent Development Kit.
   */
  get canonicalAfterModelCallbacks(): SingleAfterModelCallback[] {
    return LlmAgent.normalizeCallbackArray(this.afterModelCallback);
  }

  /**
   * The resolved beforeToolCallback field as a list of
   * BeforeToolCallback.
   *
   * This method is only for use by Agent Development Kit.
   */
  get canonicalBeforeToolCallbacks(): SingleBeforeToolCallback[] {
    return LlmAgent.normalizeCallbackArray(this.beforeToolCallback);
  }

  /**
   * The resolved afterToolCallback field as a list of AfterToolCallback.
   *
   * This method is only for use by Agent Development Kit.
   */
  get canonicalAfterToolCallbacks(): SingleAfterToolCallback[] {
    return LlmAgent.normalizeCallbackArray(this.afterToolCallback);
  }

  /**
   * Saves the agent's final response to the session state if configured.
   *
   * It extracts the text content from the final response event, optionally
   * parses it as JSON based on the output schema, and stores the result in the
   * session state using the specified output key.
   *
   * @param event The event to process.
   */
  private maybeSaveOutputToState(event: Event) {
    if (event.author !== this.name) {
      logger.debug(
        `Skipping output save for agent ${this.name}: event authored by ${
          event.author
        }`,
      );
      return;
    }
    if (!this.outputKey) {
      logger.debug(
        `Skipping output save for agent ${this.name}: outputKey is not set`,
      );
      return;
    }
    if (!isFinalResponse(event)) {
      logger.debug(
        `Skipping output save for agent ${
          this.name
        }: event is not a final response`,
      );
      return;
    }
    if (!event.content?.parts?.length) {
      logger.debug(
        `Skipping output save for agent ${this.name}: event content is empty`,
      );
      return;
    }

    const resultStr: string = event.content.parts
      .map((part) => (part.text ? part.text : ''))
      .join('');
    let result: unknown = resultStr;
    if (this.outputSchema) {
      // If the result from the final chunk is just whitespace or empty,
      // it means this is an empty final chunk of a stream.
      // Do not attempt to parse it as JSON.
      if (!resultStr.trim()) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(resultStr);
      } catch (e) {
        // A model can return malformed JSON. Log and keep the raw text so the
        // failure is visible without dropping the response, exactly as this
        // path already behaved.
        logger.error(`Error parsing output for agent ${this.name}`, e);
        event.actions.stateDelta[this.outputKey] = resultStr;
        return;
      }
      try {
        result = this.validateOutput(parsed);
      } catch (e) {
        // Well-formed JSON that violates the schema. Report it, but still
        // write the parsed value: `outputKey` has always held the object the
        // model returned, and substituting the raw string on failure would
        // change the type a consumer reads. Rejecting outright is defensible,
        // but is a separate behaviour change.
        logger.error(
          `Output for agent ${this.name} does not satisfy its output schema`,
          e,
        );
        result = parsed;
      }
    }
    event.actions.stateDelta[this.outputKey] = result;
  }

  /**
   * Validates a value against this agent's output schema, in whichever dialect
   * it was declared, and returns the parsed value.
   *
   * Prefers the schema as supplied ({@link outputSchemaSource}) over the genai
   * form derived from it, since the conversion drops constraints Zod can
   * express and genai cannot.
   *
   * @throws if the value does not satisfy the schema.
   */
  validateOutput(value: unknown): unknown {
    return parseWithSchema(this.outputSchemaSource ?? this.outputSchema, value);
  }

  /**
   * Runs this agent as a workflow node.
   *
   * Where {@link BaseAgent.runImpl} delegates straight to `runAsync`, an
   * `LlmAgent` has a node input to inject into the conversation, instruction
   * placeholders to resolve against it, a reply to promote to node output, and
   * — in `task` mode — a `finish_task` round-trip to drive. All of that lives
   * in `runLlmAgentAsNode`, mirroring adk-python's `LlmAgent._run_impl`
   * delegating to `run_llm_agent_as_node`.
   */
  protected override async *runImpl(
    ctx: NodeContext,
    nodeInput: unknown,
  ): AsyncGenerator<Event, void, void> {
    yield* runLlmAgentAsNode(this, ctx, nodeInput);
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    while (true) {
      let lastEvent: Event | undefined = undefined;
      let stepHadToolCalls = false;
      for await (const event of this.runOneStepAsync(context)) {
        if (context.abortSignal?.aborted) {
          return;
        }

        lastEvent = event;
        if (
          getFunctionCalls(event).length > 0 ||
          getFunctionResponses(event).length > 0
        ) {
          stepHadToolCalls = true;
        }
        this.maybeSaveOutputToState(event);
        yield event;
      }

      if (!lastEvent) {
        break;
      }

      const isEmptyMetadataEvent =
        lastEvent.author === this.name &&
        !lastEvent.partial &&
        (!lastEvent.content?.parts || lastEvent.content.parts.length === 0) &&
        isDefaultEventActions(lastEvent.actions);

      if (
        isFinalResponse(lastEvent) &&
        !(isEmptyMetadataEvent && stepHadToolCalls)
      ) {
        break;
      }

      if (lastEvent.partial) {
        logger.warn('The last event is partial, which is not expected.');
        break;
      }
    }
  }

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    for await (const event of this.runLiveFlow(context)) {
      if (context.abortSignal?.aborted) {
        return;
      }

      this.maybeSaveOutputToState(event);
      yield event;
    }
    if (context.endInvocation) {
      return;
    }
  }

  // --------------------------------------------------------------------------
  // #START LlmFlow Logic
  // --------------------------------------------------------------------------
  /**
   * Runs the bidirectional (live) flow for this agent.
   *
   * Establishes a live connection to the model, drains the invocation's
   * `liveRequestQueue` into the connection on a parallel task, and yields
   * events derived from server messages until the queue closes, the model
   * finishes, or an agent transfer occurs.
   *
   * If the live connection drops (network failure, server `goAway`) and a
   * session resumption handle has been observed, the flow transparently
   * reconnects using that handle up to {@link MAX_LIVE_RECONNECT_ATTEMPTS}
   * times. Subsequent reconnects skip `sendHistory` because the server
   * already holds the conversation state associated with the handle.
   */
  private async *runLiveFlow(
    invocationContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    if (!invocationContext.liveRequestQueue) {
      throw new Error('liveRequestQueue is required for LlmAgent.runLiveFlow.');
    }

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    // =========================================================================
    // Preprocess: same processors as runAsync. Yields agent-emitted events
    // (e.g. instruction injection metadata events) to the caller.
    // =========================================================================
    for await (const event of this.runLivePreprocess(
      invocationContext,
      llmRequest,
    )) {
      yield event;
    }

    if (
      invocationContext.endInvocation ||
      invocationContext.abortSignal?.aborted
    ) {
      return;
    }

    // =========================================================================
    // Apply live-only request config from the run config.
    // =========================================================================
    applyLiveRunConfig(invocationContext.runConfig, llmRequest);

    const llm = this.canonicalModel;
    let reconnectAttempts = 0;

    // Outer reconnect loop. Re-enters on recoverable failures when a session
    // resumption handle is available; the server restores state on the new
    // connection so we skip history replay.
    while (true) {
      if (invocationContext.abortSignal?.aborted) {
        return;
      }

      // Apply the latest resumption handle before each connect attempt.
      const handle = invocationContext.liveSessionResumptionHandle;
      if (handle) {
        llmRequest.liveConnectConfig ??= {};
        llmRequest.liveConnectConfig.sessionResumption = {
          handle,
          transparent: true,
        };
      }

      let connection: BaseLlmConnection;
      try {
        connection = await llm.connect(llmRequest);
      } catch (err) {
        if (
          isRecoverableLiveError(err) &&
          invocationContext.liveSessionResumptionHandle
        ) {
          reconnectAttempts += 1;
          if (reconnectAttempts > MAX_LIVE_RECONNECT_ATTEMPTS) {
            logger.error(
              `Max live reconnection attempts reached (${reconnectAttempts}).`,
              err,
            );
            throw err;
          }
          logger.info(
            `Live connect failed (attempt ${reconnectAttempts}); retrying with session handle.`,
            err,
          );
          continue;
        }
        throw err;
      }

      // Skip history replay when resuming -- server already has the state.
      if (
        llmRequest.contents.length > 0 &&
        !invocationContext.liveSessionResumptionHandle
      ) {
        await connection.sendHistory(llmRequest.contents);
      }

      let sendError: unknown;
      const sendAbort = new AbortController();
      // Stop the send loop when either the invocation aborts or this
      // attempt's connection is torn down. AbortSignal.any cleans up its
      // listeners on the input signals automatically.
      const combinedAbort = invocationContext.abortSignal
        ? AbortSignal.any([invocationContext.abortSignal, sendAbort.signal])
        : sendAbort.signal;
      const sendTask = this.runSendLoop(
        connection,
        invocationContext.liveRequestQueue,
        combinedAbort,
        invocationContext.abortSignal,
      );
      sendTask.catch((error) => {
        logger.error('Error in live send loop:', error);
        sendError = error;
        sendAbort.abort(error);
        connection.close().catch((err) => {
          logger.warn('Error closing connection after send loop failure:', err);
        });
      });

      let reconnect = false;
      try {
        yield* this.runReceiveLoop(
          invocationContext,
          connection,
          llmRequest,
          sendAbort,
        );
      } catch (err) {
        const canReconnect =
          !!invocationContext.liveSessionResumptionHandle &&
          (err instanceof LiveReconnectSignal || isRecoverableLiveError(err));
        if (canReconnect) {
          reconnect = true;
          logger.info(
            'Live connection closed; will reconnect with session handle.',
            err,
          );
        } else {
          // Tear down before rethrowing.
          await this.teardownLiveConnection(sendAbort, connection, sendTask);
          throw err;
        }
      }

      // Cancel send loop for this attempt; receive loop has exited.
      await this.teardownLiveConnection(sendAbort, connection, sendTask);

      if (invocationContext.abortSignal?.aborted) {
        return;
      }

      if (sendError) {
        throw sendError;
      }

      if (!reconnect) {
        return;
      }

      reconnectAttempts += 1;
      if (reconnectAttempts > MAX_LIVE_RECONNECT_ATTEMPTS) {
        throw new Error(
          `Max live reconnection attempts reached (${reconnectAttempts}).`,
        );
      }
    }
  }

  private async *runLivePreprocess(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    for (const processor of this.requestProcessors) {
      for await (const event of processor.runAsync(
        invocationContext,
        llmRequest,
      )) {
        if (invocationContext.abortSignal?.aborted) {
          return;
        }
        yield event;
      }
    }
    for (const toolUnion of this.tools) {
      const toolContext = new Context({invocationContext});
      const tools = (
        await convertToolUnionToTools(
          toolUnion,
          new ReadonlyContext(invocationContext),
        )
      ).filter(
        (tool) =>
          !llmRequest.allowedTools ||
          llmRequest.allowedTools.includes(tool.name),
      );
      for (const tool of tools) {
        await tool.processLlmRequest({toolContext, llmRequest});
        if (invocationContext.abortSignal?.aborted) {
          return;
        }
      }
    }
  }

  private async runSendLoop(
    connection: BaseLlmConnection,
    liveRequestQueue: LiveRequestQueue,
    sendAbortSignal?: AbortSignal,
    invocationAbortSignal?: AbortSignal,
  ): Promise<void> {
    while (true) {
      if (sendAbortSignal?.aborted || invocationAbortSignal?.aborted) {
        return;
      }
      let liveRequest: LiveRequest;
      try {
        // Pass the abort signal so a parked read is released on teardown
        // (reconnect, agent transfer) instead of stranding a waiter that
        // would later steal a request from the next connection's send loop.
        liveRequest = await liveRequestQueue.get(sendAbortSignal);
      } catch (error) {
        if (sendAbortSignal?.aborted || invocationAbortSignal?.aborted) {
          return;
        }
        throw error;
      }
      try {
        await this.dispatchLiveRequest(connection, liveRequest);
      } catch (error) {
        if (sendAbortSignal?.aborted || invocationAbortSignal?.aborted) {
          logger.debug('Send failed after teardown:', error);
          return;
        }
        logger.error('Error dispatching live request to model:', error);
        throw error;
      }
      // Cooperative yield: avoid starving the event loop when the queue is
      // backlogged so receive-loop events get a chance to interleave.
      await Promise.resolve();
      if (liveRequest.close) {
        return;
      }
    }
  }

  private async dispatchLiveRequest(
    connection: BaseLlmConnection,
    liveRequest: LiveRequest,
  ): Promise<void> {
    if (liveRequest.close) {
      await connection.close();
      return;
    }
    if (liveRequest.activityStart) {
      await connection.sendActivityStart?.();
      return;
    }
    if (liveRequest.activityEnd) {
      await connection.sendActivityEnd?.();
      return;
    }
    if (liveRequest.blob) {
      await connection.sendRealtime(liveRequest.blob);
      return;
    }
    if (liveRequest.content) {
      await connection.sendContent(liveRequest.content);
    }
  }

  /**
   * Tears down a live attempt: stops the send loop, closes the connection
   * (swallowing close errors), and waits for the send task to settle. Used
   * before reconnecting or propagating an error.
   */
  private async teardownLiveConnection(
    sendAbort: AbortController,
    connection: BaseLlmConnection,
    sendTask: Promise<void>,
  ): Promise<void> {
    sendAbort.abort();
    try {
      await connection.close();
    } catch (error) {
      logger.warn('Error closing live connection:', error);
    }
    await sendTask.catch(() => undefined);
  }

  private async *runReceiveLoop(
    invocationContext: InvocationContext,
    connection: BaseLlmConnection,
    llmRequest: LlmRequest,
    sendAbort: AbortController,
  ): AsyncGenerator<Event, void, void> {
    for await (const llmResponse of connection.receive()) {
      if (invocationContext.abortSignal?.aborted) {
        return;
      }
      if (sendAbort.signal.aborted) {
        return;
      }

      // Capture the latest server-provided resumption handle on the
      // invocation context so that any subsequent reconnect attempt can
      // resume server-side state instead of replaying history.
      if (llmResponse.liveSessionResumptionUpdate?.newHandle) {
        invocationContext.liveSessionResumptionHandle =
          llmResponse.liveSessionResumptionUpdate.newHandle;
      }

      // GoAway is the server's "I'm about to close; reconnect with your
      // resumption handle" signal. Throw a sentinel to break the outer
      // reconnect loop in runLiveFlow.
      if (llmResponse.goAway) {
        logger.info('Received goAway from live server; triggering reconnect.');
        throw new LiveReconnectSignal('goAway');
      }

      // Input transcriptions are the user speaking; echoed user-role
      // content (e.g. function responses) likewise belongs to the user side.
      const author =
        llmResponse.inputTranscription || llmResponse.content?.role === 'user'
          ? 'user'
          : this.name;

      const modelResponseEvent = createEvent({
        invocationId: invocationContext.invocationId,
        author,
        branch: invocationContext.branch,
      });

      for await (const event of this.postprocessLive(
        invocationContext,
        llmRequest,
        llmResponse,
        modelResponseEvent,
      )) {
        yield event;

        // Send function responses directly through the connection rather
        // than via the live request queue. The TS LiveRequestQueue rejects
        // sends after close (strict semantics), and callers commonly close
        // the queue at end-of-input before the model finishes ferrying tool
        // results back. Python's queue tolerates post-close sends, but
        // porting that semantics is out of scope here.
        if (event.content && getFunctionResponses(event).length > 0) {
          await connection.sendContent(event.content);
        }

        const taskCompleted = getFunctionResponses(event).some(
          (r) => r.name === 'task_completed',
        );
        if (taskCompleted) {
          await sleep(TRANSFER_AGENT_DELAY_MS);
          return;
        }

        // Handle agent transfer triggered by a transfer_to_agent function
        // response. The active connection is closed and the destination
        // sub-agent's runLive is yielded into the same generator.
        const transferTo = event.actions?.transferToAgent;
        if (transferTo) {
          // Brief delay lets the model finish flushing pending audio for
          // the in-flight turn before we tear down the connection.
          await sleep(TRANSFER_AGENT_DELAY_MS);
          // Stop the parent send loop before the sub-agent starts its own,
          // so the two never consume the shared liveRequestQueue
          // concurrently (mirrors `send_task.cancel()` in the Python flow).
          sendAbort.abort();
          await connection.close();
          const agent = requireAgent(invocationContext);
          const subAgent = agent.rootAgent.findAgent(transferTo);
          if (subAgent) {
            const previousAgent = invocationContext.agent;
            invocationContext.agent = subAgent;
            // Child agent starts its own live session; do not carry over
            // the parent's resumption handle.
            const previousHandle =
              invocationContext.liveSessionResumptionHandle;
            invocationContext.liveSessionResumptionHandle = undefined;
            try {
              for await (const subEvent of subAgent.runLive(
                invocationContext,
              )) {
                yield subEvent;
              }
            } finally {
              invocationContext.agent = previousAgent;
              invocationContext.liveSessionResumptionHandle = previousHandle;
            }
          }
          return;
        }
      }
    }
  }

  private async *postprocessLive(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
    llmResponse: LlmResponse,
    modelResponseEvent: Event,
  ): AsyncGenerator<Event, void, void> {
    for (const processor of this.responseProcessors) {
      for await (const event of processor.runAsync(
        invocationContext,
        llmResponse,
      )) {
        yield event;
      }
    }

    // Skip purely empty responses, but allow control signals to surface.
    if (
      !llmResponse.content &&
      !llmResponse.errorCode &&
      !llmResponse.interrupted &&
      !llmResponse.turnComplete &&
      !llmResponse.inputTranscription &&
      !llmResponse.outputTranscription &&
      !llmResponse.usageMetadata &&
      !llmResponse.liveSessionResumptionUpdate
    ) {
      return;
    }

    // The connection layer (GeminiLlmConnection.receive) emits resumption
    // updates and transcriptions as standalone, single-field responses --
    // never combined with `content`. Each is therefore handled with an early
    // return; if that invariant changes, co-located fields would be dropped
    // here and these branches would need to merge instead.
    if (llmResponse.liveSessionResumptionUpdate) {
      yield createEvent({
        ...modelResponseEvent,
        liveSessionResumptionUpdate: llmResponse.liveSessionResumptionUpdate,
      });
      return;
    }

    if (llmResponse.inputTranscription) {
      yield createEvent({
        ...modelResponseEvent,
        inputTranscription: llmResponse.inputTranscription,
        partial: llmResponse.partial,
      });
      return;
    }
    if (llmResponse.outputTranscription) {
      yield createEvent({
        ...modelResponseEvent,
        outputTranscription: llmResponse.outputTranscription,
        partial: llmResponse.partial,
      });
      return;
    }

    const mergedEvent = createEvent({
      ...modelResponseEvent,
      ...llmResponse,
    });

    const functionCalls = getFunctionCalls(mergedEvent);
    if (mergedEvent.content && functionCalls.length) {
      populateClientFunctionCallId(mergedEvent);
      mergedEvent.longRunningToolIds = Array.from(
        getLongRunningFunctionCalls(functionCalls, llmRequest.toolsDict),
      );
    }

    yield mergedEvent;

    // Execute any function calls returned in this event.
    if (!functionCalls.length) {
      return;
    }

    const functionResponseEvent = await handleFunctionCallsAsync({
      invocationContext,
      functionCallEvent: mergedEvent,
      toolsDict: llmRequest.toolsDict,
      beforeToolCallbacks: this.canonicalBeforeToolCallbacks,
      afterToolCallbacks: this.canonicalAfterToolCallbacks,
    });
    if (!functionResponseEvent) {
      return;
    }
    const authEvent = generateAuthEvent(
      invocationContext,
      functionResponseEvent,
    );
    if (authEvent) {
      yield authEvent;
    }
    yield functionResponseEvent;
  }

  private async *runOneStepAsync(
    invocationContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    // =========================================================================
    // Preprocess before calling the LLM
    // =========================================================================
    // Runs request processors.
    for (const processor of this.requestProcessors) {
      for await (const event of processor.runAsync(
        invocationContext,
        llmRequest,
      )) {
        if (invocationContext.abortSignal?.aborted) {
          return;
        }

        yield event;
      }
    }
    // TODO - b/425992518: check if tool preprocessors can be simplified.
    // Run pre-processors for tools.
    const allTools = [...this.tools];
    if (this.mode === 'task') {
      // Task mode: the agent completes by calling `finish_task` (whose params
      // mirror the output schema) rather than emitting structured output.
      allTools.push(this.finishTaskTool);
    } else if (
      this.outputSchema &&
      allTools.length > 0 &&
      !canUseOutputSchemaWithTools(this.canonicalModel.model)
    ) {
      const setModelResponseTool = new FunctionTool({
        name: 'set_model_response',
        description:
          'Call this tool to submit your final response conforming to the output schema. Use this tool only when you have collected all the information and are ready to return the final answer.',
        parameters: this.outputSchema,
        execute: async (args, toolContext) => {
          if (toolContext) {
            toolContext.actions.skipSummarization = true;
          }
          return JSON.stringify(args);
        },
      });
      allTools.push(setModelResponseTool);
    }
    // Collect turn metadata and event actions
    // TODO - b/425992518: misleading, this is passing metadata.
    const modelResponseEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author: this.name,
      branch: invocationContext.branch,
    });
    for (const toolUnion of allTools) {
      const toolContext = new Context({
        invocationContext,
        eventActions: modelResponseEvent.actions,
      });

      // process all tools from this tool union
      const tools = (
        await convertToolUnionToTools(
          toolUnion,
          new ReadonlyContext(invocationContext),
        )
      ).filter((tool) => {
        // If allowedTools is not set, allow all tools. Otherwise, only allow
        // tools that are in the allowedTools set.
        // The allowedTools set is populated by request processors.
        return (
          !llmRequest.allowedTools ||
          llmRequest.allowedTools.includes(tool.name) ||
          tool.name === 'set_model_response'
        );
      });

      for (const tool of tools) {
        await tool.processLlmRequest({toolContext, llmRequest});

        if (invocationContext.abortSignal?.aborted) {
          return;
        }
      }
    }
    // =========================================================================
    // Global runtime interruption
    // =========================================================================
    // TODO - b/425992518: global runtime interruption, hacky, fix.
    if (
      invocationContext.endInvocation ||
      invocationContext.abortSignal?.aborted
    ) {
      return;
    }

    // =========================================================================
    // Calls the LLM
    // =========================================================================
    const span = tracer.startSpan('call_llm');
    const ctx = trace.setSpan(context.active(), span);
    yield* runAsyncGeneratorWithOtelContext<LlmAgent, Event>(
      ctx,
      this,
      async function* () {
        const responsesGenerator = async function* (this: LlmAgent) {
          for await (const llmResponse of this.callLlmAsync(
            invocationContext,
            llmRequest,
            modelResponseEvent,
          )) {
            if (invocationContext.abortSignal?.aborted) {
              return;
            }

            // ======================================================================
            // Postprocess after calling the LLM
            // ======================================================================
            for await (const event of this.postprocess(
              invocationContext,
              llmRequest,
              llmResponse,
              modelResponseEvent,
            )) {
              if (invocationContext.abortSignal?.aborted) {
                return;
              }

              // Update the mutable event id to avoid conflict
              modelResponseEvent.id = createNewEventId();
              modelResponseEvent.timestamp = new Date().getTime();
              yield event;
            }
          }
        };

        yield* this.runAndHandleError(
          responsesGenerator.call(this),
          invocationContext,
          llmRequest,
          modelResponseEvent,
        );
      },
    );
    span.end();
  }

  private async *postprocess(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
    llmResponse: LlmResponse,
    modelResponseEvent: Event,
  ): AsyncGenerator<Event, void, void> {
    // =========================================================================
    // Runs response processors
    // =========================================================================
    for (const processor of this.responseProcessors) {
      for await (const event of processor.runAsync(
        invocationContext,
        llmResponse,
      )) {
        if (invocationContext.abortSignal?.aborted) {
          return;
        }

        yield event;
      }
    }

    // =========================================================================
    // Builds the merged model response event
    // =========================================================================
    // A response with NO content that carries usageMetadata is the stream
    // aggregator's end-of-turn usage report, not an absent model response. In
    // SSE streaming, close() reports a turn's token counts this way whenever the
    // turn's parts were already yielded (i.e. any turn ending in a tool call),
    // so skipping it loses that turn's usage entirely -- silently, because
    // downstream "no usage reported" and "zero tokens used" are the same value.
    //
    // Deliberately narrow: this covers `content === undefined` ONLY. A response
    // with an empty PARTS ARRAY stays suppressed, because emitting one puts
    // `content: {parts: []}` into session history and Vertex then rejects the
    // NEXT request with HTTP 400 (#21, #22). A content-less event carries no
    // such content, and buildContents() skips events without `content.role`, so
    // it never enters history at all.
    const isUsageOnlyReport =
      !llmResponse.content && !!llmResponse.usageMetadata;

    // If no model response, skip.
    if (
      (!llmResponse.content || llmResponse.content.parts?.length === 0) &&
      !llmResponse.errorCode &&
      !llmResponse.interrupted &&
      !isUsageOnlyReport
    ) {
      return;
    }

    // Merge llm response with model response event.
    const mergedEvent = createEvent({
      ...modelResponseEvent,
      ...llmResponse,
    });

    if (mergedEvent.content) {
      const functionCalls = getFunctionCalls(mergedEvent);
      const setModelResponseCall = functionCalls.find(
        (call) => call.name === 'set_model_response',
      );
      if (setModelResponseCall) {
        const args = setModelResponseCall.args;
        mergedEvent.content.parts = [{text: JSON.stringify(args)}];
        mergedEvent.actions.skipSummarization = true;
      } else if (functionCalls && functionCalls.length) {
        populateClientFunctionCallId(mergedEvent);
        // TODO - b/425992518: hacky, transaction log, simplify.
        // Long running is a property of tool in registry.
        mergedEvent.longRunningToolIds = Array.from(
          getLongRunningFunctionCalls(functionCalls, llmRequest.toolsDict),
        );
      }
    }
    yield mergedEvent;

    // =========================================================================
    // Process function calls if any, which inlcudes agent transfer.
    // =========================================================================
    if (!getFunctionCalls(mergedEvent)?.length) {
      return;
    }

    if (invocationContext.runConfig?.pauseOnToolCalls) {
      invocationContext.endInvocation = true;
      return;
    }

    // Call functions
    // TODO - b/425992518: bloated funciton input, fix.
    // Tool callback passed to get rid of cyclic dependency.
    // A NodeTool (running a node/workflow) streams the node's intermediate and
    // interrupt events into `invocationContext.eventQueue`; drain it concurrently
    // so those events interleave into this agent's output stream. The tool runs
    // in a self-contained task that captures its result/error and always closes
    // the queue, so there is a single error path (no unhandled rejection).
    const eventQueue = new AsyncQueue<Event>();
    invocationContext.eventQueue = eventQueue;
    const toolTask = (async (): Promise<{
      event: Event | null;
      error?: unknown;
    }> => {
      try {
        const event = await handleFunctionCallsAsync({
          invocationContext: invocationContext,
          functionCallEvent: mergedEvent,
          toolsDict: llmRequest.toolsDict,
          beforeToolCallbacks: this.canonicalBeforeToolCallbacks,
          afterToolCallbacks: this.canonicalAfterToolCallbacks,
        });
        return {event};
      } catch (error) {
        return {event: null, error};
      } finally {
        eventQueue.close();
      }
    })();
    for await (const queuedEvent of eventQueue) {
      yield queuedEvent;
    }
    const {event: functionResponseEvent, error: toolError} = await toolTask;
    invocationContext.eventQueue = undefined;
    if (toolError) {
      throw toolError;
    }

    if (!functionResponseEvent || invocationContext.abortSignal?.aborted) {
      return;
    }

    // Yiels an authentication event if any.
    // TODO - b/425992518: transaction log session, simplify.
    const authEvent = generateAuthEvent(
      invocationContext,
      functionResponseEvent,
    );
    if (authEvent) {
      yield authEvent;
    }

    // Yields a tool confirmation event if any.
    const toolConfirmationEvent = generateRequestConfirmationEvent({
      invocationContext: invocationContext,
      functionCallEvent: mergedEvent,
      functionResponseEvent: functionResponseEvent,
    });
    if (toolConfirmationEvent) {
      yield toolConfirmationEvent;
      invocationContext.endInvocation = true;
      return;
    }

    yield functionResponseEvent;

    // If model instruct to transfer to an agent, run the transferred agent.
    const nextAgentName = functionResponseEvent.actions.transferToAgent;
    if (nextAgentName) {
      const nextAgent = this.getAgentByName(invocationContext, nextAgentName);
      for await (const event of nextAgent.runAsync(invocationContext)) {
        if (invocationContext.abortSignal?.aborted) {
          return;
        }

        yield event;
      }
    }
  }

  /**
   * Retrieves an agent from the agent tree by its name.
   *
   * Performing a depth-first search to locate the agent with the given name.
   * - Starts searching from the root agent of the current invocation context.
   * - Traverses down the agent tree to find the specified agent.
   *
   * @param invocationContext The current invocation context.
   * @param agentName The name of the agent to retrieve.
   * @returns The agent with the given name.
   * @throws Error if the agent is not found.
   */
  private getAgentByName(
    invocationContext: InvocationContext,
    agentName: string,
  ): BaseAgent {
    const rootAgent = requireAgent(invocationContext).rootAgent;
    const agentToRun = rootAgent.findAgent(agentName);
    if (!agentToRun) {
      throw new Error(`Agent ${agentName} not found in the agent tree.`);
    }
    return agentToRun;
  }

  protected async *callLlmAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
    modelResponseEvent: Event,
  ): AsyncGenerator<LlmResponse, void, void> {
    // Runs before_model_callback if it exists.
    const beforeModelResponse = await this.handleBeforeModelCallback(
      invocationContext,
      llmRequest,
      modelResponseEvent,
    );

    if (invocationContext.abortSignal?.aborted) {
      return;
    }

    if (beforeModelResponse) {
      yield beforeModelResponse;
      return;
    }

    llmRequest.config ??= {};
    llmRequest.config.labels ??= {};

    // Add agent name as a label to the llm_request. This will help with slicing
    // the billing reports on a per-agent basis.
    if (!llmRequest.config.labels[ADK_AGENT_NAME_LABEL_KEY]) {
      llmRequest.config.labels[ADK_AGENT_NAME_LABEL_KEY] = this.name;
    }

    const llm = this.canonicalModel;
    if (invocationContext.runConfig?.supportCfc) {
      // TODO - b/425992518: Implement CFC call path
      // This is a hack, underneath it calls runLive. Which makes
      // runLive/run mixed.
      throw new Error('CFC is not yet supported in callLlmAsync');
    } else {
      invocationContext.incrementLlmCallCount();
      const responsesGenerator = llm.generateContentAsync(
        llmRequest,
        /* stream= */ invocationContext.runConfig?.streamingMode ===
          StreamingMode.SSE,
        invocationContext.abortSignal,
      );

      for await (const llmResponse of responsesGenerator) {
        traceCallLlm({
          invocationContext,
          eventId: modelResponseEvent.id,
          llmRequest,
          llmResponse,
        });

        if (invocationContext.abortSignal?.aborted) {
          return;
        }

        // Runs after_model_callback if it exists.
        const alteredLlmResponse = await this.handleAfterModelCallback(
          invocationContext,
          llmResponse,
          modelResponseEvent,
        );

        if (invocationContext.abortSignal?.aborted) {
          return;
        }

        yield alteredLlmResponse ?? llmResponse;
      }
    }
  }

  private async handleBeforeModelCallback(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
    modelResponseEvent: Event,
  ): Promise<LlmResponse | undefined> {
    // TODO - b/425992518: Clean up eventActions from Context here as
    // modelResponseEvent.actions is always empty.
    const callbackContext = new Context({
      invocationContext,
      eventActions: modelResponseEvent.actions,
    });

    // Plugin callbacks before canonical callbacks
    const beforeModelCallbackResponse =
      await invocationContext.pluginManager.runBeforeModelCallback({
        callbackContext,
        llmRequest,
      });
    if (invocationContext.abortSignal?.aborted) {
      return;
    }

    if (beforeModelCallbackResponse) {
      return beforeModelCallbackResponse;
    }

    // If no override was returned from the plugins, run the canonical callbacks
    for (const callback of this.canonicalBeforeModelCallbacks) {
      const callbackResponse = await callback({
        context: callbackContext,
        request: llmRequest,
      });

      if (invocationContext.abortSignal?.aborted) {
        return;
      }

      if (callbackResponse) {
        return callbackResponse;
      }
    }
    return undefined;
  }

  private async handleAfterModelCallback(
    invocationContext: InvocationContext,
    llmResponse: LlmResponse,
    modelResponseEvent: Event,
  ): Promise<LlmResponse | undefined> {
    const callbackContext = new Context({
      invocationContext,
      eventActions: modelResponseEvent.actions,
    });

    // Plugin callbacks before canonical callbacks
    const afterModelCallbackResponse =
      await invocationContext.pluginManager.runAfterModelCallback({
        callbackContext,
        llmResponse,
      });
    if (afterModelCallbackResponse) {
      return afterModelCallbackResponse;
    }

    // If no override was returned from the plugins, run the canonical callbacks
    for (const callback of this.canonicalAfterModelCallbacks) {
      const callbackResponse = await callback({
        context: callbackContext,
        response: llmResponse,
      });

      if (invocationContext.abortSignal?.aborted) {
        return;
      }

      if (callbackResponse) {
        return callbackResponse;
      }
    }
    return undefined;
  }

  protected async *runAndHandleError<T extends LlmResponse | Event>(
    responseGenerator: AsyncGenerator<T, void, void>,
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
    modelResponseEvent: Event,
  ): AsyncGenerator<T, void, void> {
    try {
      for await (const response of responseGenerator) {
        if (invocationContext.abortSignal?.aborted) {
          return;
        }

        yield response;
      }
    } catch (modelError: unknown) {
      // Return an LlmResponse with error details.
      // Note: this will cause agent to work better if there's a loop.
      const callbackContext = new Context({
        invocationContext,
        eventActions: modelResponseEvent.actions,
      });

      // Wrapped LLM should throw Error-typed errors
      if (modelError instanceof Error) {
        // Try plugins to recover from the error
        const onModelErrorCallbackResponse =
          await invocationContext.pluginManager.runOnModelErrorCallback({
            callbackContext: callbackContext,
            llmRequest: llmRequest,
            error: modelError as Error,
          });

        if (onModelErrorCallbackResponse) {
          yield onModelErrorCallbackResponse as T;
        } else {
          // If no plugins, just return the message.
          let errorCode = 'UNKNOWN_ERROR';
          let errorMessage = modelError.message;

          try {
            const errorResponse = JSON.parse(modelError.message) as {
              error: {code: number; message: string};
            };
            if (errorResponse?.error) {
              errorCode = String(errorResponse.error.code || 'UNKNOWN_ERROR');
              errorMessage = errorResponse.error.message || errorMessage;
            }
          } catch {
            // Ignore JSON parse error, use original message.
          }

          if (modelResponseEvent.actions) {
            yield createEvent({
              invocationId: invocationContext.invocationId,
              author: this.name,
              errorCode,
              errorMessage,
            }) as T;
          } else {
            // We are yielding an LlmResponse
            yield {
              errorCode,
              errorMessage,
            } as T;
          }
        }
      } else {
        logger.error('Unknown error during response generation', modelError);
        throw modelError;
      }
    }
  }

  // --------------------------------------------------------------------------
  // #END LlmFlow Logic
  // --------------------------------------------------------------------------

  // TODO - b/425992518: omitted Py LlmAgent features.
  // - code_executor
  // - configurable agents by yaml config
}
