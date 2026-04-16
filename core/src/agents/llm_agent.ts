/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig, Schema} from '@google/genai';
import {context, trace} from '@opentelemetry/api';

import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';

import {BaseCodeExecutor} from '../code_executors/base_code_executor.js';

import {
  createEvent,
  createNewEventId,
  Event,
  getFunctionCalls,
  isFinalResponse,
} from '../events/event.js';

import {BaseExampleProvider} from '../examples/base_example_provider.js';
import {Example} from '../examples/example.js';
import {BaseLlm, isBaseLlm} from '../models/base_llm.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {LLMRegistry} from '../models/registry.js';

import {BaseTool, isBaseTool} from '../tools/base_tool.js';
import {BaseToolset} from '../tools/base_toolset.js';

import {logger} from '../utils/logger.js';
import {Context} from './context.js';

import {
  runAsyncGeneratorWithOtelContext,
  traceCallLlm,
  tracer,
} from '../telemetry/tracing.js';
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
  populateClientFunctionCallId,
} from './functions.js';

import {BaseContextCompactor} from '../context/base_context_compactor.js';
import {InvocationContext} from './invocation_context.js';
import {AGENT_TRANSFER_LLM_REQUEST_PROCESSOR} from './processors/agent_transfer_llm_request_processor.js';
import {BASIC_LLM_REQUEST_PROCESSOR} from './processors/basic_llm_request_processor.js';
import {CODE_EXECUTION_REQUEST_PROCESSOR} from './processors/code_execution_request_processor.js';
import {CONTENT_REQUEST_PROCESSOR} from './processors/content_request_processor.js';
import {ContextCompactorRequestProcessor} from './processors/context_compactor_request_processor.js';
import {IDENTITY_LLM_REQUEST_PROCESSOR} from './processors/identity_llm_request_processor.js';
import {INSTRUCTIONS_LLM_REQUEST_PROCESSOR} from './processors/instructions_llm_request_processor.js';
import {REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR} from './processors/request_confirmation_llm_request_processor.js';
import {TOOL_FILTER_REQUEST_PROCESSOR} from './processors/tool_filter_request_processor.js';
import {ReadonlyContext} from './readonly_context.js';
import {StreamingMode} from './run_config.js';

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
export type ToolUnion = BaseTool | BaseToolset;

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
export class LlmAgent extends BaseAgent {
  /** A unique symbol to identify ADK LLM agent class. */
  readonly [LLM_AGENT_SIGNATURE_SYMBOL] = true;

  model?: string | BaseLlm;
  instruction: string | InstructionProvider;
  globalInstruction: string | InstructionProvider;
  tools: ToolUnion[];
  generateContentConfig?: GenerateContentConfig;
  disallowTransferToParent: boolean;
  disallowTransferToPeers: boolean;
  includeContents: 'default' | 'none';
  inputSchema?: Schema;
  outputSchema?: Schema;
  outputKey?: string;
  beforeModelCallback?: BeforeModelCallback;
  afterModelCallback?: AfterModelCallback;
  beforeToolCallback?: BeforeToolCallback;
  afterToolCallback?: AfterToolCallback;
  requestProcessors: BaseLlmRequestProcessor[];
  responseProcessors: BaseLlmResponseProcessor[];
  codeExecutor?: BaseCodeExecutor;

  constructor(config: LlmAgentConfig) {
    super(config);
    this.model = config.model;
    this.instruction = config.instruction ?? '';
    this.globalInstruction = config.globalInstruction ?? '';
    this.tools = config.tools ?? [];
    this.generateContentConfig = config.generateContentConfig;
    this.disallowTransferToParent = config.disallowTransferToParent ?? false;
    this.disallowTransferToPeers = config.disallowTransferToPeers ?? false;
    this.includeContents = config.includeContents ?? 'default';
    this.inputSchema = isZodObject(config.inputSchema)
      ? zodObjectToSchema(config.inputSchema)
      : config.inputSchema;
    this.outputSchema = isZodObject(config.outputSchema)
      ? zodObjectToSchema(config.outputSchema)
      : config.outputSchema;
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
      IDENTITY_LLM_REQUEST_PROCESSOR,
      INSTRUCTIONS_LLM_REQUEST_PROCESSOR,
      REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR,
      CONTENT_REQUEST_PROCESSOR,
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
      if (!this.disallowTransferToParent || !this.disallowTransferToPeers) {
        logger.warn(
          `Invalid config for agent ${
            this.name
          }: outputSchema cannot co-exist with agent transfer configurations. Setting disallowTransferToParent=true, disallowTransferToPeers=true`,
        );
        this.disallowTransferToParent = true;
        this.disallowTransferToPeers = true;
      }
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
      // TODO - b/425992518: Use a proper Schema validation utility.
      // Should use output schema to validate the JSON.
      try {
        result = JSON.parse(resultStr);
      } catch (e) {
        logger.error(`Error parsing output for agent ${this.name}`, e);
      }
    }
    event.actions.stateDelta[this.outputKey] = result;
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    while (true) {
      let lastEvent: Event | undefined = undefined;
      for await (const event of this.runOneStepAsync(context)) {
        if (context.abortSignal?.aborted) {
          return;
        }

        lastEvent = event;
        this.maybeSaveOutputToState(event);
        yield event;
      }

      if (!lastEvent || isFinalResponse(lastEvent)) {
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
  // eslint-disable-next-line require-yield
  private async *runLiveFlow(
    _invocationContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // TODO - b/425992518: remove dummy logic, implement this.
    await Promise.resolve();
    throw new Error('LlmAgent.runLiveFlow not implemented');
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
    for (const toolUnion of this.tools) {
      const toolContext = new Context({invocationContext});

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
          llmRequest.allowedTools.includes(tool.name)
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
    // TODO - b/425992518: misleading, this is passing metadata.
    const modelResponseEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author: this.name,
      branch: invocationContext.branch,
    });
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
    // If no model response, skip.
    if (
      !llmResponse.content &&
      !llmResponse.errorCode &&
      !llmResponse.interrupted
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
      if (functionCalls?.length) {
        // TODO - b/425992518: rename topopulate if missing.
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
    const functionResponseEvent = await handleFunctionCallsAsync({
      invocationContext: invocationContext,
      functionCallEvent: mergedEvent,
      toolsDict: llmRequest.toolsDict,
      beforeToolCallbacks: this.canonicalBeforeToolCallbacks,
      afterToolCallbacks: this.canonicalAfterToolCallbacks,
    });

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

    // Yields the function response event.
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
    const rootAgent = invocationContext.agent.rootAgent;
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

    // Calls the LLM.
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
            // We are yielding an Event
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
