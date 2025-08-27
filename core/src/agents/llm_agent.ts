/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig, Schema, ThinkingConfig} from '@google/genai';
import {z} from 'zod';

import {createNewEventId, Event} from '../events/event.js';
import {BaseExampleProvider} from '../examples/base_example_provider.js';
import {Example} from '../examples/example.js';
import {BaseLlm} from '../models/base_llm.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {LLMRegistry} from '../models/registry.js';
import {BaseTool} from '../tools/base_tool.js';
import {BaseToolset} from '../tools/base_toolset.js';
import {FunctionTool} from '../tools/function_tool.js';
import {ToolContext} from '../tools/tool_context.js';

import {BaseAgent, BaseAgentConfig} from './base_agent.js';
import {BaseLlmRequestProcessor, BaseLlmResponseProcessor} from './base_llm_processor.js';
import {CallbackContext} from './callback_context.js';
import {getContents, getCurrentTurnContents} from './content_processor_utils.js';
// TODO - b/425992518: handleFunctionCallsAsync reusable, other can merge in.
import {generateAuthEvent, getLongRunningFunctionCalls, handleFunctionCallsAsync, populateClientFunctionCallId} from './functions.js';
import {injectSessionState} from './instructions.js';
import {InvocationContext} from './invocation_context.js';
import {ReadonlyContext} from './readonly_context.js';

/** An object that can provide an instruction string. */
export type InstructionProvider = (
    context: ReadonlyContext,
    ) => string|Promise<string>;

/**
 * A callback that runs before a request is sent to the model.
 *
 * @param context The current callback context.
 * @param request The raw model request. Callback can mutate the request.
 * @returns The content to return to the user. When present, the model call
 *     will be skipped and the provided content will be returned to user.
 */
export type SingleBeforeModelCallback =
    (params: {context: CallbackContext; request: LlmRequest;}) =>
        LlmResponse|undefined|Promise<LlmResponse|undefined>;

/**
 * A single callback or a list of callbacks.
 *
 * When a list of callbacks is provided, the callbacks will be called in the
 * order they are listed until a callback does not return None.
 */
export type BeforeModelCallback =
    |SingleBeforeModelCallback|SingleBeforeModelCallback[];

/**
 * A callback that runs after a response is received from the model.
 *
 * @param context The current callback context.
 * @param response The actual model response.
 * @returns The content to return to the user. When present, the actual model
 *     response will be ignored and the provided content will be returned to
 *     user.
 */
export type SingleAfterModelCallback =
    (params: {context: CallbackContext; response: LlmResponse;}) =>
        LlmResponse|undefined|Promise<LlmResponse|undefined>;

/**
 * A single callback or a list of callbacks.
 *
 * When a list of callbacks is provided, the callbacks will be called in the
 order they are listed until a callback does not return None.
 */
export type AfterModelCallback =
    |SingleAfterModelCallback|SingleAfterModelCallback[];

/** A generic dictionary type. */
export type Dict = {
  [key: string]: unknown
};

/**
 * A callback that runs before a tool is called.
 *
 * @param tool The tool to be called.
 * @param args The arguments to the tool.
 * @param tool_context: ToolContext,
 * @returns The tool response. When present, the returned tool response will
 *     be used and the framework will skip calling the actual tool.
 */
export type SingleBeforeToolCallback =
    (params: {tool: BaseTool; args: Dict; context: ToolContext;}) =>
        Dict|undefined|Promise<Dict|undefined>;

/**
 * A single callback or a list of callbacks.
 *
 * When a list of callbacks is provided, the callbacks will be called in the
 * order they are listed until a callback does not return None.
 */
export type BeforeToolCallback =
    |SingleBeforeToolCallback|SingleBeforeToolCallback[];

/**
 * A callback that runs after a tool is called.
 *
 * @param tool The tool to be called.
 * @param args The arguments to the tool.
 * @param tool_context: ToolContext,
 * @param tool_response: The response from the tool.
 * @returns When present, the returned dict will be used as tool result.
 */
export type SingleAfterToolCallback = (params: {
  tool: BaseTool; args: Dict; context: ToolContext; response: Dict;
}) => Dict|undefined|Promise<Dict|undefined>;

/**
 * A single callback or a list of callbacks.
 *
 * When a list of callbacks is provided, the callbacks will be called in the
 * order they are listed until acallback does not return None.
 */
export type AfterToolCallback =
    |SingleAfterToolCallback|SingleAfterToolCallback[];

/** A list of examples or an example provider. */
export type ExamplesUnion = Example[]|BaseExampleProvider;

/** A union of tool types that can be provided to an agent. */
export type ToolUnion = BaseTool|BaseToolset;

const ADK_AGENT_NAME_LABEL_KEY = 'adk_agent_name';

export interface LlmAgentConfig extends BaseAgentConfig {
  /**
   * The model to use for the agent.
   */
  model?: string|BaseLlm;

  /** Instructions for the LLM model, guiding the agent's behavior. */
  instruction?: string|InstructionProvider;

  /**
   * Instructions for all the agents in the entire agent tree.
   *
   * ONLY the globalInstruction in root agent will take effect.
   *
   * For example: use globalInstruction to make all agents have a stable
   * identity or personality.
   */
  globalInstruction?: string|InstructionProvider;

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
  includeContents?: 'default'|'none';

  /** The input schema when agent is used as a tool. */
  inputSchema?: Schema;

  /**
   * The output schema when agent replies.
   *
   * NOTE:
   *   When this is set, agent can ONLY reply and CANNOT use any tools, such as
   *   function tools, RAGs, agent transfer, etc.
   */
  outputSchema?: Schema;

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
}

async function convertToolUnionToTools(
    toolUnion: ToolUnion,
    context: ReadonlyContext,
    ): Promise<BaseTool[]> {
  if (toolUnion instanceof BaseTool) {
    return [toolUnion];
  }
  return await toolUnion.getTools(context);
}

// --------------------------------------------------------------------------
// #START Request Processors
// --------------------------------------------------------------------------
class BasicLlmRequestProcessor extends BaseLlmRequestProcessor {
  override async *
      runAsync(
          invocationContext: InvocationContext,
          llmRequest: LlmRequest,
          ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!(agent instanceof LlmAgent)) {
      return;
    }

    // set model string, not model instance.
    llmRequest.model = agent.canonicalModel.model;

    llmRequest.config = {...agent.generateContentConfig ?? {}};
    if (agent.outputSchema) {
      llmRequest.setOutputSchema(agent.outputSchema);
    }

    if (invocationContext.runConfig) {
      llmRequest.liveConnectConfig.responseModalities =
          invocationContext.runConfig.responseModalities;
      llmRequest.liveConnectConfig.speechConfig =
          invocationContext.runConfig.speechConfig;
      llmRequest.liveConnectConfig.outputAudioTranscription =
          invocationContext.runConfig.outputAudioTranscription;
      llmRequest.liveConnectConfig.inputAudioTranscription =
          invocationContext.runConfig.inputAudioTranscription;
      llmRequest.liveConnectConfig.realtimeInputConfig =
          invocationContext.runConfig.realtimeInputConfig;
      llmRequest.liveConnectConfig.enableAffectiveDialog =
          invocationContext.runConfig.enableAffectiveDialog;
      llmRequest.liveConnectConfig.proactivity =
          invocationContext.runConfig.proactivity;
    }
  }
}
const BASIC_LLM_REQUEST_PROCESSOR = new BasicLlmRequestProcessor();


class IdentityLlmRequestProcessor extends BaseLlmRequestProcessor {
  override async *
      runAsync(
          invocationContext: InvocationContext,
          llmRequest: LlmRequest,
          ): AsyncGenerator<Event, void, undefined> {
    const agent = invocationContext.agent;
    const si = [`You are an agent. Your internal name is "${agent.name}".`];
    if (agent.description) {
      si.push(`The description about you is "${agent.description}"`);
    }
    llmRequest.appendInstructions(si);
  }
}
const IDENTITY_LLM_REQUEST_PROCESSOR = new IdentityLlmRequestProcessor();


class InstructionsLlmRequestProcessor extends BaseLlmRequestProcessor {
  /**
   * Handles instructions and global instructions for LLM flow.
   */
  async *
      runAsync(
          invocationContext: InvocationContext,
          llmRequest: LlmRequest,
          ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!(agent instanceof LlmAgent) ||
        !(agent.rootAgent instanceof LlmAgent)) {
      return;
    }
    const rootAgent: LlmAgent = agent.rootAgent;

    // TODO - b/425992518: unexpected and buggy for performance.
    // Global instruction should be explicitly scoped.
    // Step 1: Appends global instructions if set by RootAgent.
    if (rootAgent instanceof LlmAgent && rootAgent.globalInstruction) {
      const {instruction, requireStateInjection} =
          await rootAgent.canonicalGlobalInstruction(
              new ReadonlyContext(invocationContext),
          );
      let instructionWithState = instruction;
      if (requireStateInjection) {
        instructionWithState = await injectSessionState(
            instruction,
            new ReadonlyContext(invocationContext),
        );
      }
      llmRequest.appendInstructions([instructionWithState]);
    }

    // Step 2: Appends agent local instructions if set.
    // TODO - b/425992518: requireStateInjection means user passed a
    // instruction processor. We need to make it more explicit.
    if (agent.instruction) {
      const {instruction, requireStateInjection} =
          await agent.canonicalInstruction(
              new ReadonlyContext(invocationContext),
          );
      let instructionWithState = instruction;
      if (requireStateInjection) {
        instructionWithState = await injectSessionState(
            instruction,
            new ReadonlyContext(invocationContext),
        );
      }
      llmRequest.appendInstructions([instructionWithState]);
    }
  }
}
const INSTRUCTIONS_LLM_REQUEST_PROCESSOR =
    new InstructionsLlmRequestProcessor();


class ContentRequestProcessor implements BaseLlmRequestProcessor {
  async *
      runAsync(invocationContext: InvocationContext, llmRequest: LlmRequest):
          AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!agent || !(agent instanceof LlmAgent)) {
      return;
    }

    if (agent.includeContents === 'default') {
      // Include full conversation history
      llmRequest.contents = getContents(
          invocationContext.session.events,
          agent.name,
          invocationContext.branch,
      );
    } else {
      // Include current turn context only (no conversation history).
      llmRequest.contents = getCurrentTurnContents(
          invocationContext.session.events,
          agent.name,
          invocationContext.branch,
      );
    }

    return;
  }
}

const CONTENT_REQUEST_PROCESSOR = new ContentRequestProcessor();

class AgentTransferLlmRequestProcessor extends BaseLlmRequestProcessor {
  private readonly toolName = 'transfer_to_agent' as const;
  private readonly tool = new FunctionTool({
    name: this.toolName,
    description:
        'Transfer the question to another agent. This tool hands off control to another agent when it is more suitable to answer the user question according to the agent description.',
    parameters: z.object({
      agentName: z.string().describe('the agent name to transfer to.'),
    }),
    execute:
        function(args: {agentName: string}, toolContext?: ToolContext) {
          if (!toolContext) {
            throw new Error('toolContext is required.');
          }
          toolContext.actions.transferToAgent = args.agentName;
        },
  });

  override async *
      runAsync(
          invocationContext: InvocationContext,
          llmRequest: LlmRequest,
          ): AsyncGenerator<Event, void, void> {
    if (!(invocationContext.agent instanceof LlmAgent)) {
      return;
    }

    const transferTargets = this.getTransferTargets(invocationContext.agent);
    if (!transferTargets.length) {
      return;
    }

    llmRequest.appendInstructions([
      this.buildTargetAgentsInstructions(
          invocationContext.agent,
          transferTargets,
          ),
    ]);

    const toolContext = new ToolContext({invocationContext});
    await this.tool.processLlmRequest({toolContext, llmRequest});
  }

  private buildTargetAgentsInfo(targetAgent: BaseAgent): string {
    return `
Agent name: ${targetAgent.name}
Agent description: ${targetAgent.description}
`;
  }

  private buildTargetAgentsInstructions(
      agent: LlmAgent,
      targetAgents: BaseAgent[],
      ): string {
    let instructions = `
You have a list of other agents to transfer to:

${targetAgents.map(this.buildTargetAgentsInfo).join('\n')}

If you are the best to answer the question according to your description, you
can answer it.

If another agent is better for answering the question according to its
description, call \`${this.toolName}\` function to transfer the
question to that agent. When transferring, do not generate any text other than
the function call.
`;

    if (agent.parentAgent && !agent.disallowTransferToParent) {
      instructions += `
Your parent agent is ${agent.parentAgent.name}. If neither the other agents nor
you are best for answering the question according to the descriptions, transfer
to your parent agent.
`;
    }
    return instructions;
  }

  private getTransferTargets(agent: LlmAgent): BaseAgent[] {
    const targets: BaseAgent[] = [];
    targets.push(...agent.subAgents);

    if (!agent.parentAgent || !(agent.parentAgent instanceof LlmAgent)) {
      return targets;
    }

    if (!agent.disallowTransferToParent) {
      targets.push(agent.parentAgent);
    }

    if (!agent.disallowTransferToPeers) {
      targets.push(
          ...agent.parentAgent.subAgents.filter(
              (peerAgent) => peerAgent.name !== agent.name,
              ),
      );
    }

    return targets;
  }
}

const AGENT_TRANSFER_LLM_REQUEST_PROCESSOR =
    new AgentTransferLlmRequestProcessor();

// --------------------------------------------------------------------------
// #END Request Processors
// --------------------------------------------------------------------------

/**
 * An agent that uses a large language model to generate responses.
 */
export class LlmAgent extends BaseAgent {
  model?: string|BaseLlm;
  instruction: string|InstructionProvider;
  globalInstruction: string|InstructionProvider;
  tools: ToolUnion[];
  generateContentConfig?: GenerateContentConfig;
  disallowTransferToParent: boolean;
  disallowTransferToPeers: boolean;
  includeContents: 'default'|'none';
  inputSchema?: Schema;
  outputSchema?: Schema;
  outputKey?: string;
  beforeModelCallback?: BeforeModelCallback;
  afterModelCallback?: AfterModelCallback;
  beforeToolCallback?: BeforeToolCallback;
  afterToolCallback?: AfterToolCallback;
  requestProcessors: BaseLlmRequestProcessor[];
  responseProcessors: BaseLlmResponseProcessor[];

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
    this.inputSchema = config.inputSchema;
    this.outputSchema = config.outputSchema;
    this.outputKey = config.outputKey;
    this.beforeModelCallback = config.beforeModelCallback;
    this.afterModelCallback = config.afterModelCallback;
    this.beforeToolCallback = config.beforeToolCallback;
    this.afterToolCallback = config.afterToolCallback;

    // TODO - b/425992518: Define these processor arrays.
    // Orders matter, don't change. Append new processors to the end
    this.requestProcessors = config.requestProcessors ?? [
      BASIC_LLM_REQUEST_PROCESSOR,
      IDENTITY_LLM_REQUEST_PROCESSOR,
      INSTRUCTIONS_LLM_REQUEST_PROCESSOR,
      CONTENT_REQUEST_PROCESSOR,
    ];
    this.responseProcessors = config.responseProcessors ?? [];

    // Preserve the agent transfer behavior.
    const agentTransferDisabled = this.disallowTransferToParent &&
        this.disallowTransferToPeers && !this.subAgents?.length;
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
            'Response schema must be set via LlmAgent.output_schema.');
      }
    } else {
      this.generateContentConfig = {}
    }

    // Validate output schema related configurations.
    if (this.outputSchema) {
      if (!this.disallowTransferToParent || !this.disallowTransferToPeers) {
        console.warn(
            `Invalid config for agent ${
                this.name}: outputSchema cannot co-exist with agent transfer configurations. Setting disallowTransferToParent=true, disallowTransferToPeers=true`,
        );
        this.disallowTransferToParent = true;
        this.disallowTransferToPeers = true;
      }

      if (this.subAgents && this.subAgents.length > 0) {
        throw new Error(
            `Invalid config for agent ${
                this.name}: if outputSchema is set, subAgents must be empty to disable agent transfer.`,
        );
      }

      if (this.tools && this.tools.length > 0) {
        throw new Error(
            `Invalid config for agent ${
                this.name}: if outputSchema is set, tools must be empty`,
        );
      }
    }
  }

  /**
   * The resolved BaseLlm instance.
   *
   * When not set, the agent will inherit the model from its ancestor.
   */
  get canonicalModel(): BaseLlm {
    if (this.model instanceof BaseLlm) {
      return this.model;
    }
    if (typeof this.model === 'string' && this.model) {
      return LLMRegistry.newLlm(this.model);
    }

    let ancestorAgent = this.parentAgent;
    while (ancestorAgent) {
      if (ancestorAgent instanceof LlmAgent) {
        return ancestorAgent.canonicalModel;
      }
      ancestorAgent = ancestorAgent.parentAgent;
    }
    throw new Error(`No model found for ${this.name}.`);
  }

  /**
   * The resolved self.instruction field to construct instruction for this
   * agent.
   *
   * This method is only for use by Agent Development Kit.
   * @param context The context to retrieve the session state.
   * @returns The resolved self.instruction field.
   */
  async canonicalInstruction(context: ReadonlyContext):
      Promise<{instruction: string, requireStateInjection: boolean}> {
    if (typeof this.instruction === 'string') {
      return {instruction: this.instruction, requireStateInjection: true};
    }
    return {
      instruction: await this.instruction(context),
      requireStateInjection: false
    };
  }

  /**
   * The resolved self.instruction field to construct global instruction.
   *
   * This method is only for use by Agent Development Kit.
   * @param context The context to retrieve the session state.
   * @returns The resolved self.global_instruction field.
   */
  async canonicalGlobalInstruction(context: ReadonlyContext):
      Promise<{instruction: string, requireStateInjection: boolean}> {
    if (typeof this.globalInstruction === 'string') {
      return {instruction: this.globalInstruction, requireStateInjection: true};
    }
    return {
      instruction: await this.globalInstruction(context),
      requireStateInjection: false
    };
  }

  /**
   * The resolved self.tools field as a list of BaseTool based on the context.
   *
   * This method is only for use by Agent Development Kit.
   */
  async canonicalTools(context: ReadonlyContext): Promise<BaseTool[]> {
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
  private static normalizeCallbackArray<T>(callback?: T|T[]): T[] {
    if (!callback) {
      return [];
    }
    if (Array.isArray(callback)) {
      return callback;
    }
    return [callback];
  }

  /**
   * The resolved self.before_model_callback field as a list of
   * SingleBeforeModelCallback.
   *
   * This method is only for use by Agent Development Kit.
   */
  get canonicalBeforeModelCallbacks(): SingleBeforeModelCallback[] {
    return LlmAgent.normalizeCallbackArray(this.beforeModelCallback);
  }

  /**
   * The resolved self.after_model_callback field as a list of
   * SingleAfterModelCallback.
   *
   * This method is only for use by Agent Development Kit.
   */
  get canonicalAfterModelCallbacks(): SingleAfterModelCallback[] {
    return LlmAgent.normalizeCallbackArray(this.afterModelCallback);
  }

  /**
   * The resolved self.before_tool_callback field as a list of
   * BeforeToolCallback.
   *
   * This method is only for use by Agent Development Kit.
   */
  get canonicalBeforeToolCallbacks(): SingleBeforeToolCallback[] {
    return LlmAgent.normalizeCallbackArray(this.beforeToolCallback);
  }

  /**
   * The resolved self.after_tool_callback field as a list of AfterToolCallback.
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
      console.debug(
          `Skipping output save for agent ${this.name}: event authored by ${
              event.author}`,
      );
      return;
    }
    if (!this.outputKey) {
      console.debug(
          `Skipping output save for agent ${this.name}: outputKey is not set`,
      );
      return;
    }
    if (!event.isFinalResponse()) {
      console.debug(
          `Skipping output save for agent ${
              this.name}: event is not a final response`,
      );
      return;
    }
    if (!event.content?.parts?.length) {
      console.debug(
          `Skipping output save for agent ${this.name}: event content is empty`,
      );
      return;
    }

    const resultStr: string =
        event.content.parts.map((part) => (part.text ? part.text : ''))
            .join('');
    let result: unknown;
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
        console.error(`Error parsing output for agent ${this.name}`, e);
      }
    }
    event.actions.stateDelta[this.outputKey] = result;
  }

  protected async *
      runAsyncImpl(
          context: InvocationContext,
          ): AsyncGenerator<Event, void, void> {
    while (true) {
      let lastEvent: Event|undefined = undefined;
      for await (const event of this.runOneStepAsync(context)) {
        lastEvent = event;
        this.maybeSaveOutputToState(event);
        yield event;
      }

      if (!lastEvent || lastEvent.isFinalResponse()) {
        break;
      }
      if (lastEvent.partial) {
        console.warn('The last event is partial, which is not expected.');
        break;
      }
    }
  }

  protected async *
      runLiveImpl(
          context: InvocationContext,
          ): AsyncGenerator<Event, void, void> {
    for await (const event of this.runLiveFlow(context)) {
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
  private async *
      runLiveFlow(
          invocationContext: InvocationContext,
          ): AsyncGenerator<Event, void, void> {
    // TODO - b/425992518: remove dummy logic, implement this.
    await Promise.resolve();
    throw new Error('LlmAgent.runLiveFlow not implemented');
  }

  private async *
      runOneStepAsync(
          invocationContext: InvocationContext,
          ): AsyncGenerator<Event, void, void> {
    const llmRequest = new LlmRequest();

    // =========================================================================
    // Preprocess before calling the LLM
    // =========================================================================
    // Runs request processors.
    for (const processor of this.requestProcessors) {
      for await (
          const event of processor.runAsync(invocationContext, llmRequest)) {
        yield event;
      }
    }
    // TODO - b/425992518: check if tool preprocessors can be simplified.
    // Run pre-processors for tools.
    for (const toolUnion of this.tools) {
      const toolContext = new ToolContext({invocationContext});

      // process all tools from this tool union
      const tools = await convertToolUnionToTools(
          toolUnion, new ReadonlyContext(invocationContext));
      for (const tool of tools) {
        await tool.processLlmRequest({toolContext, llmRequest});
      }
    }
    // =========================================================================
    // Global runtime interruption
    // =========================================================================
    // TODO - b/425992518: global runtime interruption, hacky, fix.
    if (invocationContext.endInvocation) {
      return;
    }

    // =========================================================================
    // Calls the LLM
    // =========================================================================
    // TODO - b/425992518: misleading, this is passing metadata.
    const modelResponseEvent = new Event({
      invocationId: invocationContext.invocationId,
      author: this.name,
      branch: invocationContext.branch,
    });
    for await (const llmResponse of this.callLlmAsync(
        invocationContext, llmRequest, modelResponseEvent)) {
      // ======================================================================
      // Postprocess after calling the LLM
      // ======================================================================
      for await (const event of this.postprocessAsync(
          invocationContext, llmRequest, llmResponse, modelResponseEvent)) {
        // Update the mutable event id to avoid conflict
        modelResponseEvent.id = createNewEventId();
        modelResponseEvent.timestamp = new Date().getTime();
        yield event;
      }
    }
  }

  private async *
      postprocessAsync(
          invocationContext: InvocationContext,
          llmRequest: LlmRequest,
          llmResponse: LlmResponse,
          modelResponseEvent: Event,
          ): AsyncGenerator<Event, void, void> {
    // =========================================================================
    // Runs response processors
    // =========================================================================
    for (const processor of this.responseProcessors) {
      for await (
          const event of processor.runAsync(invocationContext, llmResponse)) {
        yield event;
      }
    }

    // =========================================================================
    // Builds the merged model response event
    // =========================================================================
    // If no model response, skip.
    if (!llmResponse.content && !llmResponse.errorCode &&
        !llmResponse.interrupted) {
      return;
    }

    // Merge llm response with model response event.
    const mergedEvent = new Event({
      ...modelResponseEvent,
      ...llmResponse,
    });

    if (mergedEvent.content) {
      const functionCalls = mergedEvent.getFunctionCalls();
      if (functionCalls?.length) {
        // TODO - b/425992518: rename topopulate if missing.
        populateClientFunctionCallId(mergedEvent);
        // TODO - b/425992518: hacky, transaction log, simplify.
        // Long running is a property of tool in registry.
        mergedEvent.longRunningToolIds = Array.from(
            getLongRunningFunctionCalls(functionCalls, llmRequest.toolsDict));
      }
    }
    yield mergedEvent;

    // =========================================================================
    // Process function calls if any, which inlcudes agent transfer.
    // =========================================================================
    if (!mergedEvent.getFunctionCalls()?.length) {
      return;
    }

    // Call functions
    // TODO - b/425992518: bloated funciton input, fix.
    // Tool callback passed to get rid of cyclic dependency.
    const functionResponseEvent = await handleFunctionCallsAsync(
        invocationContext, mergedEvent, llmRequest.toolsDict,
        this.canonicalBeforeToolCallbacks, this.canonicalAfterToolCallbacks);

    if (!functionResponseEvent) {
      return;
    }

    // Yiels an authentication event if any.
    // TODO - b/425992518: transaction log session, simplify.
    const authEvent =
        generateAuthEvent(invocationContext, functionResponseEvent);
    if (authEvent) {
      yield authEvent;
    }

    // Yields the function response event.
    yield functionResponseEvent;

    // If model instruct to transfer to an agent, run the transferred agent.
    const nextAgentName = functionResponseEvent.actions.transferToAgent;
    if (nextAgentName) {
      const nextAgent = this.getAgentByName(invocationContext, nextAgentName);
      for await (const event of nextAgent.runAsync(invocationContext)) {
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

  private async *
      callLlmAsync(
          invocationContext: InvocationContext,
          llmRequest: LlmRequest,
          modelResponseEvent: Event,
          ): AsyncGenerator<LlmResponse, void, void> {
    // Runs before_model_callback if it exists.
    const beforeModelResponse = await this.handleBeforeModelCallback(
        invocationContext, llmRequest, modelResponseEvent);
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
    // TODO - b/425992518: Add tracer.start_as_current_span('call_llm')
    if (invocationContext.runConfig?.supportCfc) {
      // TODO - b/425992518: Implement CFC call path
      // This is a hack, underneath it calls runLive. Which makes
      // runLive/runAsync mixed.
      throw new Error('CFC is not yet supported in callLlmAsync');
    } else {
      invocationContext.incrementLlmCallCount();
      const responsesGenerator = llm.generateContentAsync(llmRequest);

      for await (const llmResponse of this.runAndHandleError(
          responsesGenerator, invocationContext, llmRequest,
          modelResponseEvent)) {
        // TODO - b/425992518: Add trace_call_llm

        // Runs after_model_callback if it exists.
        const alteredLlmResponse = await this.handleAfterModelCallback(
            invocationContext, llmResponse, modelResponseEvent);
        yield alteredLlmResponse ?? llmResponse;
      }
    }
  }

  private async handleBeforeModelCallback(
      invocationContext: InvocationContext,
      llmRequest: LlmRequest,
      modelResponseEvent: Event,
      ): Promise<LlmResponse|undefined> {
    // TODO - b/425992518: Clean up eventActions from CallbackContext here as
    // modelResponseEvent.actions is always empty.
    const callbackContext = new CallbackContext(
        {invocationContext, eventActions: modelResponseEvent.actions});

    // TODO - b/425992518: Implement PluginManager - runBeforeModelCallback

    for (const callback of this.canonicalBeforeModelCallbacks) {
      const callbackResponse =
          await callback({context: callbackContext, request: llmRequest});
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
      ): Promise<LlmResponse|undefined> {
    const callbackContext = new CallbackContext(
        {invocationContext, eventActions: modelResponseEvent.actions});

    // TODO - b/425992518: Implement PluginManager - runAfterModelCallback

    for (const callback of this.canonicalAfterModelCallbacks) {
      const callbackResponse =
          await callback({context: callbackContext, response: llmResponse});
      if (callbackResponse) {
        return callbackResponse;
      }
    }
    return undefined;
  }

  private async *
      runAndHandleError(
          responseGenerator: AsyncGenerator<LlmResponse, void, void>,
          invocationContext: InvocationContext,
          llmRequest: LlmRequest,
          modelResponseEvent: Event,
          ): AsyncGenerator<LlmResponse, void, void> {
    try {
      for await (const response of responseGenerator) {
        yield response;
      }
    } catch (modelError: unknown) {
      const callbackContext = new CallbackContext(
          {invocationContext, eventActions: modelResponseEvent.actions});
      // TODO - b/425992518: replace with PluginManager.runOnModelErrorCallback
      // Return an LlmResponse with error details.
      // Note: this will cause agent to work better if there's a loop.
      yield new LlmResponse({
        errorMessage: modelError instanceof Error ? modelError.message :
                                                    String(modelError),
      });
    }
  }

  // --------------------------------------------------------------------------
  // #END LlmFlow Logic
  // --------------------------------------------------------------------------

  // TODO - b/425992518: omitted Py LlmAgent features.
  // - code_executor
  // - configurable agents by yaml config
}
