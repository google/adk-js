/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  createUserContent,
  FunctionCall,
  FunctionResponse,
  Part,
} from '@google/genai';
import {isEmpty} from 'lodash-es';

import {InvocationContext} from '../agents/invocation_context.js';
import {
  createEvent,
  Event,
  generateClientFunctionCallId,
  getFunctionCalls,
  getFunctionResponses,
} from '../events/event.js';
import {
  isDefaultEventActions,
  mergeEventActions,
} from '../events/event_actions.js';
import {
  carryDeltaStamp,
  carryMergedDeltaStamp,
  getDeltaWriteStamp,
  getStateWriteStamp,
} from '../sessions/state_write_order.js';
import {BaseTool} from '../tools/base_tool.js';
import {isComputerUseTool} from '../tools/computer_use/computer_use_tool.js';
import {CallLiveToolRequest, isFunctionTool} from '../tools/function_tool.js';
import {ResumeInputs} from '../tools/resume_inputs.js';
import {ToolConfirmation} from '../tools/tool_confirmation.js';
import {Aclosing} from '../utils/context_utils.js';
import {logger} from '../utils/logger.js';
import {Task} from '../utils/task.js';
import {ActiveStreamingTool} from './active_streaming_tool.js';
import {Context} from './context.js';
import {
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
} from './framework_function_calls.js';

import {
  recordMergedToolCalls,
  recordToolExecution,
} from '../telemetry/api/instrumentation.js';

import {
  SingleAfterToolCallback,
  SingleBeforeToolCallback,
} from './llm_agent.js';

/**
 * Author for an event this module creates.
 *
 * Normally the agent whose turn produced the tool call. A `ToolNode` in a
 * workflow has no agent above it when the workflow is the runner's root, and
 * the node runner stamps the node's own name onto any event that leaves without
 * an author — so returning an empty string here defers to that rather than
 * asserting an agent that legitimately is not there.
 */
function toolEventAuthor(invocationContext: InvocationContext): string {
  return invocationContext.agent?.name ?? '';
}

export {
  AF_FUNCTION_CALL_ID_PREFIX,
  generateClientFunctionCallId,
  populateClientFunctionCallId,
} from '../events/event.js';
export {
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  reservedFunctionCallName,
} from './framework_function_calls.js';

// Export these items for testing purposes only
export const functionsExportedForTestingOnly = {
  handleFunctionCallList,
  handleFunctionCallsLive,
  processFunctionLiveHelper,
  generateAuthEvent,
  generateRequestConfirmationEvent,
};
// TODO - b/425992518: consider internalize as part of llm_agent's runtime.
/**
 * Returns a set of function call ids of the long running tools.
 */
export function getLongRunningFunctionCalls(
  functionCalls: FunctionCall[],
  toolsDict: Record<string, BaseTool>,
): Set<string> {
  const longRunningToolIds = new Set<string>();
  for (const functionCall of functionCalls) {
    if (
      functionCall.name &&
      Object.hasOwn(toolsDict, functionCall.name) &&
      toolsDict[functionCall.name].isLongRunning &&
      functionCall.id
    ) {
      longRunningToolIds.add(functionCall.id);
    }
  }
  return longRunningToolIds;
}

// TODO - b/425992518: consider internalize as part of llm_agent's runtime.
// The auth part of function calling is a bit hacky, need to to clarify.
/**
 * Generates an authentication event.
 *
 * It iterates through requested auth configurations in a function response
 * event and creates a new function call for each.
 */
export function generateAuthEvent(
  invocationContext: InvocationContext,
  functionResponseEvent: Event,
): Event | undefined {
  if (
    !functionResponseEvent.actions?.requestedAuthConfigs ||
    isEmpty(functionResponseEvent.actions.requestedAuthConfigs)
  ) {
    return undefined;
  }
  const parts: Part[] = [];
  const longRunningToolIds = new Set<string>();
  for (const [functionCallId, authConfig] of Object.entries(
    functionResponseEvent.actions.requestedAuthConfigs,
  )) {
    const requestCredentialFunctionCall: FunctionCall = {
      name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
      args: {
        'function_call_id': functionCallId,
        'auth_config': authConfig,
      },
      id: generateClientFunctionCallId(),
    };
    longRunningToolIds.add(requestCredentialFunctionCall.id!);
    parts.push({functionCall: requestCredentialFunctionCall});
  }

  return createEvent({
    invocationId: invocationContext.invocationId,
    author: toolEventAuthor(invocationContext),
    branch: invocationContext.branch,
    content: {
      parts: parts,
      role: functionResponseEvent.content?.role ?? 'user',
    },
    longRunningToolIds: Array.from(longRunningToolIds),
  });
}

/**
 * Generates a request confirmation event from a function response event.
 */
export function generateRequestConfirmationEvent({
  invocationContext,
  functionCallEvent,
  functionResponseEvent,
}: {
  invocationContext: InvocationContext;
  functionCallEvent: Event;
  functionResponseEvent: Event;
}): Event | undefined {
  if (
    !functionResponseEvent.actions?.requestedToolConfirmations ||
    isEmpty(functionResponseEvent.actions.requestedToolConfirmations)
  ) {
    return;
  }
  const parts: Part[] = [];
  const longRunningToolIds = new Set<string>();
  const functionCalls = getFunctionCalls(functionCallEvent);

  for (const [functionCallId, toolConfirmation] of Object.entries(
    functionResponseEvent.actions.requestedToolConfirmations,
  )) {
    const originalFunctionCall =
      functionCalls.find((call) => call.id === functionCallId) ?? undefined;
    if (!originalFunctionCall) {
      continue;
    }
    const requestConfirmationFunctionCall: FunctionCall = {
      name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
      args: {
        'originalFunctionCall': originalFunctionCall,
        'toolConfirmation': toolConfirmation,
      },
      id: generateClientFunctionCallId(),
    };
    longRunningToolIds.add(requestConfirmationFunctionCall.id!);
    parts.push({functionCall: requestConfirmationFunctionCall});
  }
  return createEvent({
    invocationId: invocationContext.invocationId,
    author: toolEventAuthor(invocationContext),
    branch: invocationContext.branch,
    content: {
      parts: parts,
      role: functionResponseEvent.content?.role ?? 'user',
    },
    actions: functionResponseEvent.actions,
    longRunningToolIds: Array.from(longRunningToolIds),
  });
}

async function callToolAsync(
  tool: BaseTool,
  args: Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  toolContext: Context,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  return recordToolExecution(
    {tool, args, invocationContext: toolContext.invocationContext},
    async (scope) => {
      logger.debug(`callToolAsync ${tool.name}`);
      const result = await tool.runAsync({args, toolContext});
      scope.recordSuccess({
        functionResponseEvent: buildResponseEvent(
          tool,
          result,
          toolContext,
          toolContext.invocationContext,
        ),
        rawResult: result,
      });
      return result;
    },
  );
}

/** A base64 string, as a computer use tool encodes its screenshot. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Builds the function response for a tool's result.
 *
 * A computer use tool returns its screenshot as `{image: {data, mimetype}}`.
 * The image moves out of the response into the function response's `parts`,
 * so the model receives it as an image rather than as text.
 */
function buildFunctionResponse({
  tool,
  id,
  response,
}: {
  tool: BaseTool;
  id: string | undefined;
  response: Record<string, unknown> | undefined;
}): FunctionResponse {
  const image = isComputerUseTool(tool) ? response?.['image'] : undefined;
  if (
    typeof image !== 'object' ||
    image === null ||
    !('data' in image) ||
    !('mimetype' in image) ||
    typeof image.data !== 'string' ||
    typeof image.mimetype !== 'string' ||
    !BASE64.test(image.data)
  ) {
    return {id, name: tool.name, response};
  }
  const rest = {...response};
  delete rest['image'];
  return {
    id,
    name: tool.name,
    response: rest,
    parts: [{inlineData: {data: image.data, mimeType: image.mimetype}}],
  };
}

function buildResponseEvent(
  tool: BaseTool,
  functionResult: unknown,
  toolContext: Context,
  invocationContext: InvocationContext,
): Event {
  let responseResult: Record<string, unknown>;
  if (typeof functionResult !== 'object' || functionResult == null) {
    responseResult = {result: functionResult};
  } else if (Array.isArray(functionResult)) {
    responseResult = {results: functionResult};
  } else {
    responseResult = functionResult as Record<string, unknown>;
  }

  const partFunctionResponse: Part = {
    functionResponse: buildFunctionResponse({
      tool,
      id: toolContext.functionCallId,
      response: responseResult,
    }),
  };

  const content: Content = {
    role: 'user',
    parts: [partFunctionResponse],
  };

  return createEvent({
    invocationId: invocationContext.invocationId,
    author: toolEventAuthor(invocationContext),
    content: content,
    actions: toolContext.actions,
    branch: invocationContext.branch,
  });
}
/**
 * Executes filtered function calls concurrently and merges their response
 * events into a single event in the original `functionCall` order.
 *
 * Runtime behavior for each call:
 * - Resolve the named tool. If the name cannot be resolved, run the plugin
 *   `onToolErrorCallback` hooks and answer the call with their response or the
 *   resolution error, skipping the before/after tool callbacks below.
 * - Run plugin and canonical `beforeToolCallbacks`; if a callback provides a
 *   response, skip calling the tool.
 * - Execute the tool, routing unhandled errors through plugin
 *   `onToolErrorCallback` hooks or returning an `{error}` response.
 * - Run plugin and canonical `afterToolCallbacks`; if a callback provides a
 *   response, replace the tool response.
 * - Defer long-running tools whose final response is nullish while preserving
 *   any recorded `EventActions`.
 * - Wait for all started calls in the batch to settle before rethrowing any
 *   callback error, then merge non-null function response events in original
 *   call order while retaining the latest `Context.state` writes.
 */
export async function handleFunctionCallsAsync({
  invocationContext,
  functionCallEvent,
  toolsDict,
  beforeToolCallbacks,
  afterToolCallbacks,
  filters,
  toolConfirmationDict,
  resumeInputsDict,
}: {
  invocationContext: InvocationContext;
  functionCallEvent: Event;
  toolsDict: Record<string, BaseTool>;
  beforeToolCallbacks: SingleBeforeToolCallback[];
  afterToolCallbacks: SingleAfterToolCallback[];
  filters?: Set<string>;
  toolConfirmationDict?: Record<string, ToolConfirmation>;
  resumeInputsDict?: Record<string, ResumeInputs>;
}): Promise<Event | null> {
  const functionCalls = getFunctionCalls(functionCallEvent);
  return await handleFunctionCallList({
    invocationContext: invocationContext,
    functionCalls: functionCalls,
    toolsDict: toolsDict,
    beforeToolCallbacks: beforeToolCallbacks,
    afterToolCallbacks: afterToolCallbacks,
    filters: filters,
    toolConfirmationDict: toolConfirmationDict,
    resumeInputsDict: resumeInputsDict,
  });
}

/**
 * Executes filtered function calls concurrently in a live (bidirectional
 * streaming) session and merges their response events in the original
 * `functionCall` order.
 *
 * Supports regular sync/async tools, async-generator streaming tools that push
 * incremental results onto `invocationContext.liveRequestQueue`, and the
 * `stop_streaming` control call that cancels an active streaming tool task.
 */
export async function handleFunctionCallsLive({
  invocationContext,
  functionCallEvent,
  toolsDict,
  beforeToolCallbacks,
  afterToolCallbacks,
  filters,
  toolConfirmationDict,
  resumeInputsDict,
}: {
  invocationContext: InvocationContext;
  functionCallEvent: Event;
  toolsDict: Record<string, BaseTool>;
  beforeToolCallbacks: SingleBeforeToolCallback[];
  afterToolCallbacks: SingleAfterToolCallback[];
  filters?: Set<string>;
  toolConfirmationDict?: Record<string, ToolConfirmation>;
  resumeInputsDict?: Record<string, ResumeInputs>;
}): Promise<Event | null> {
  const functionCalls = getFunctionCalls(functionCallEvent);
  return handleFunctionCallList({
    invocationContext,
    functionCalls,
    toolsDict,
    beforeToolCallbacks,
    afterToolCallbacks,
    filters,
    toolConfirmationDict,
    resumeInputsDict,
    isLive: true,
  });
}

/**
 * Normalizes callback and tool responses into a Record<string, unknown> or undefined.
 */
function normalizeCallbackResponse(
  response: unknown,
): Record<string, unknown> | undefined {
  if (response == null) {
    return undefined;
  }
  if (typeof response !== 'object') {
    return {result: response};
  }
  if (Array.isArray(response)) {
    return {results: response};
  }
  return response as Record<string, unknown>;
}

/**
 * Why a name the model called may be missing from `toolsDict`. Operator-facing
 * only — the model gets the short form, since none of this is actionable to it.
 */
const RESOLUTION_FAILURE_CAUSES = `Possible causes:
  1. The model hallucinated the name.
  2. The tool is not registered on this agent, or a plugin filtered it out of this request.
  3. The name does not match the registered tool's name exactly.
  4. The tool is registered but never enters the toolsDict, because its \`_getDeclaration()\` returns undefined (as prompt-injecting tools like \`ExampleTool\` and \`PreloadMemoryTool\` do).`;

const TOOL_NOT_FOUND_SYMBOL = Symbol.for('google.adk.toolNotFound');

/**
 * Whether `tool` is the placeholder handed to the on-tool-error callbacks for a
 * function call naming a tool this agent cannot call.
 *
 * Lets a plugin tell an unresolvable name from a registered tool that threw
 * without matching on the error message.
 */
export function isToolNotFound(tool: unknown): boolean {
  return (
    typeof tool === 'object' &&
    tool !== null &&
    (tool as Record<symbol, unknown>)[TOOL_NOT_FOUND_SYMBOL] === true
  );
}

/**
 * Stands in for a tool the model named but that the agent cannot call, so the
 * on-tool-error callbacks get something to inspect. Mirrors the bare
 * `BaseTool` Python builds in the same spot.
 *
 * The framework never runs it, but a plugin receiving it as `tool` can, so
 * `runAsync` rethrows the resolution error rather than inventing a second
 * message that could drift from the first.
 */
class ToolNotFoundPlaceholder extends BaseTool {
  readonly [TOOL_NOT_FOUND_SYMBOL] = true;

  constructor(
    name: string,
    private readonly resolutionError: Error,
  ) {
    super({name, description: 'Tool not found'});
  }

  override async runAsync(): Promise<never> {
    throw this.resolutionError;
  }
}

/**
 * Answers a function call naming a tool this agent cannot call.
 *
 * Failing to resolve the tool is a tool error, not a model error, so it runs
 * through the same on-tool-error callbacks a registered tool that throws does.
 * With no plugin response the model is handed the error as the call's result:
 * leaving the call unanswered makes the next request identical to this one, and
 * the model re-issues it until `maxLlmCalls` trips.
 */
async function answerUnresolvableCall({
  invocationContext,
  functionCall,
  toolsDict,
  toolContext,
}: {
  invocationContext: InvocationContext;
  functionCall: FunctionCall;
  toolsDict: Record<string, BaseTool>;
  toolContext: Context;
}): Promise<Event> {
  // The sibling path opens `execute_tool <name>` inside `callToolAsync`.
  // Without this an unresolvable call is the one tool interaction that
  // leaves no span, which is the worst case to be missing from a waterfall.
  const toolName = functionCall.name || '<unnamed>';
  const error = new Error(
    `Function ${toolName} is not found in the toolsDict.`,
  );
  const tool = new ToolNotFoundPlaceholder(toolName, error);
  const functionArgs = functionCall.args
    ? structuredClone(functionCall.args)
    : {};
  return recordToolExecution(
    {tool, args: functionArgs, invocationContext},
    async () => {
      const onToolErrorResponse =
        await invocationContext.pluginManager.runOnToolErrorCallback({
          tool,
          toolArgs: functionArgs,
          toolContext,
          error,
        });

      if (onToolErrorResponse == null) {
        // Only an unhandled failure is the operator's problem; a plugin that
        // answers these has made them an expected condition. The tool inventory
        // belongs here rather than in the model's payload — the model already has
        // its declarations, and a large toolset would cost kilobytes per
        // occurrence.
        const callableTools = Object.keys(toolsDict);
        logger.warn(
          `Could not resolve tool '${toolName}' for function call ` +
            `'${functionCall.id ?? ''}'. Callable tools: ` +
            `${callableTools.length ? callableTools.join(', ') : '(none)'}.\n` +
            RESOLUTION_FAILURE_CAUSES,
        );
      }

      return buildResponseEvent(
        tool,
        onToolErrorResponse ?? {error: error.message},
        toolContext,
        invocationContext,
      );
    },
  );
}

interface ExecuteSingleFunctionCallParams {
  invocationContext: InvocationContext;
  functionCall: FunctionCall;
  toolsDict: Record<string, BaseTool>;
  beforeToolCallbacks: SingleBeforeToolCallback[];
  afterToolCallbacks: SingleAfterToolCallback[];
  toolConfirmation?: ToolConfirmation;
  resumeInputs?: ResumeInputs;
  isLive?: boolean;
}

/**
 * Executes a single function call and returns its function response event, or
 * `null` when a long-running tool defers its response with default actions.
 */
async function executeSingleFunctionCall({
  invocationContext,
  functionCall,
  toolsDict,
  beforeToolCallbacks,
  afterToolCallbacks,
  toolConfirmation,
  resumeInputs,
  isLive = false,
}: ExecuteSingleFunctionCallParams): Promise<Event | null> {
  const toolContext = new Context({
    invocationContext,
    functionCallId: functionCall.id ? functionCall.id : undefined,
    toolConfirmation,
    resumeInputs,
  });
  // `functionCall.name` comes from the model, and `toolsDict` is a plain
  // object, so an unguarded lookup would resolve `toString` or `constructor`
  // to a function on `Object.prototype` and treat the call as found.
  const tool =
    functionCall.name && Object.hasOwn(toolsDict, functionCall.name)
      ? toolsDict[functionCall.name]
      : undefined;

  if (!tool) {
    return answerUnresolvableCall({
      invocationContext,
      functionCall,
      toolsDict,
      toolContext,
    });
  }

  logger.debug(`execute_tool ${tool.name}`);
  const functionArgs = functionCall.args
    ? structuredClone(functionCall.args)
    : {};

  // Step 1: Check if plugin beforeToolCallback overrides the function
  // response.
  let functionResponse =
    await invocationContext.pluginManager.runBeforeToolCallback({
      tool,
      toolArgs: functionArgs,
      toolContext,
    });

  // Step 2: If no overrides are provided from the plugins, further run the
  // canonical callback.
  if (functionResponse == null) {
    // Cover both null and undefined
    for (const callback of beforeToolCallbacks) {
      functionResponse = await callback({
        tool,
        args: functionArgs,
        context: toolContext,
      });
      if (functionResponse != null) {
        break;
      }
    }
  }

  // An override from step 1 or 2 bypasses the tool call and is handed to the
  // after-tool callbacks as-is, so normalize it before they see it.
  functionResponse = normalizeCallbackResponse(functionResponse);

  // Step 3: Otherwise, proceed calling the tool normally.
  if (functionResponse == null) {
    // Cover both null and undefined
    try {
      const rawFunctionResponse = isLive
        ? await processFunctionLiveHelper({
            tool,
            toolContext,
            functionCall,
            functionArgs,
            invocationContext,
          })
        : await callToolAsync(tool, functionArgs, toolContext);
      // Keep a long-running nullish return as undefined so the deferral below fires;
      // wrap a normal nullish return as {result: null}.
      if (rawFunctionResponse == null && !tool.isLongRunning) {
        functionResponse = {result: rawFunctionResponse};
      } else {
        functionResponse = normalizeCallbackResponse(rawFunctionResponse);
      }
    } catch (e: unknown) {
      if (e instanceof Error) {
        const onToolErrorResponse =
          await invocationContext.pluginManager.runOnToolErrorCallback({
            tool,
            toolArgs: functionArgs,
            toolContext,
            error: e,
          });

        // Set function response to the result of the error callback and
        // continue execution, do not shortcut
        if (onToolErrorResponse != null) {
          functionResponse = normalizeCallbackResponse(onToolErrorResponse);
        } else {
          // If the error callback returns undefined, use the error message
          // as the function response error.
          functionResponse = {error: e.message};
        }
      } else {
        // If the error is not an Error, use the error object as the function
        // response error.
        functionResponse = {error: e};
      }
    }
  }

  // Step 4: Check if plugin afterToolCallback overrides the function
  // response.
  const callbackResult = functionResponse ?? {};
  let alteredFunctionResponse =
    await invocationContext.pluginManager.runAfterToolCallback({
      tool,
      toolArgs: functionArgs,
      toolContext,
      result: callbackResult,
    });

  // Step 5: If no overrides are provided from the plugins, further run the
  // canonical afterToolCallbacks.
  if (alteredFunctionResponse == null) {
    // Cover both null and undefined
    for (const callback of afterToolCallbacks) {
      alteredFunctionResponse = await callback({
        tool,
        args: functionArgs,
        context: toolContext,
        response: callbackResult,
      });
      if (alteredFunctionResponse != null) {
        break;
      }
    }
  }

  // Step 6: If alternative response exists from afterToolCallback, use it
  // instead of the original function response.
  if (alteredFunctionResponse != null) {
    functionResponse = normalizeCallbackResponse(alteredFunctionResponse);
  }

  // Allow a long-running function to return no response.
  // Only a nullish response defers the event. A falsy-but-present response
  // ('', 0, false) is a real result and still emits one, so long-running
  // tools that return such a value now produce a response event where they
  // previously produced none.
  if (tool.isLongRunning && functionResponse == null) {
    // The tool's response will arrive later, but any actions it recorded on
    // the tool context (state/artifact deltas, auth or confirmation
    // requests, transfer, escalation, skipSummarization) must not be lost.
    if (!isDefaultEventActions(toolContext.actions)) {
      return createEvent({
        invocationId: invocationContext.invocationId,
        author: toolEventAuthor(invocationContext),
        actions: toolContext.actions,
        branch: invocationContext.branch,
      });
    }
    return null;
  }

  return createEvent({
    invocationId: invocationContext.invocationId,
    author: toolEventAuthor(invocationContext),
    content: createUserContent({
      functionResponse: buildFunctionResponse({
        tool,
        id: toolContext.functionCallId,
        response: functionResponse,
      }),
    }),
    actions: toolContext.actions,
    branch: invocationContext.branch,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Returns whether an unstamped direct `actions.stateDelta` write after
 * `lastMatchingIndex` survives call-order merging in `deepMergeRecords`.
 */
function hasSurvivingUnstampedWrite(
  eventsWithKey: Event[],
  key: string,
  lastMatchingIndex: number,
): boolean {
  let hasUnstamped = false;
  let prevIsPlain = isPlainObject(
    eventsWithKey[lastMatchingIndex].actions.stateDelta[key],
  );
  for (let i = lastMatchingIndex + 1; i < eventsWithKey.length; i++) {
    const stateDelta = eventsWithKey[i].actions.stateDelta;
    const currentIsPlain = isPlainObject(stateDelta[key]);
    if (getDeltaWriteStamp(stateDelta, key) === undefined) {
      hasUnstamped = true;
    } else if (!prevIsPlain || !currentIsPlain) {
      hasUnstamped = false;
    }
    prevIsPlain = currentIsPlain;
  }
  return hasUnstamped;
}

/**
 * Re-applies the latest `Context.state` value for keys written by multiple
 * parallel calls.
 *
 * Parallel calls share `session.state`, so a call that reads and updates a key
 * after a sibling call wrote it builds on that write; merging `EventActions`
 * strictly in call order would otherwise roll back out-of-order updates while
 * direct unstamped `actions.stateDelta` writes retain call-order precedence.
 */
function applyLatestStateWrites(
  mergedEvent: Event,
  functionResponseEvents: Event[],
  sessionState: Record<string, unknown>,
): void {
  const mergedDelta = mergedEvent.actions.stateDelta;
  const latestWrites: Record<string, unknown> = Object.create(null);
  let hasLatestWrites = false;

  for (const key of Object.keys(mergedDelta)) {
    if (!Object.hasOwn(sessionState, key)) {
      continue;
    }
    const eventsWithKey = functionResponseEvents.filter(
      (event) =>
        event.actions?.stateDelta &&
        Object.hasOwn(event.actions.stateDelta, key),
    );
    if (eventsWithKey.length <= 1) {
      continue;
    }

    const latest = sessionState[key];
    const stateStamp = getStateWriteStamp(sessionState, key);
    let matchingEvents: Event[];
    if (Array.isArray(latest) || isPlainObject(latest)) {
      matchingEvents = eventsWithKey.filter(
        (event) => event.actions.stateDelta[key] === latest,
      );
    } else if (stateStamp !== undefined) {
      matchingEvents = eventsWithKey.filter(
        (event) =>
          getDeltaWriteStamp(event.actions.stateDelta, key) === stateStamp &&
          Object.is(event.actions.stateDelta[key], latest),
      );
    } else {
      continue;
    }
    if (matchingEvents.length === 0) {
      continue;
    }

    const lastMatchingEvent = matchingEvents[matchingEvents.length - 1];
    const lastMatchingIndex = eventsWithKey.lastIndexOf(lastMatchingEvent);
    if (hasSurvivingUnstampedWrite(eventsWithKey, key, lastMatchingIndex)) {
      continue;
    }

    latestWrites[key] = latest;
    hasLatestWrites = true;
    carryDeltaStamp(matchingEvents[0].actions.stateDelta, latestWrites, key);
    for (const event of matchingEvents.slice(1)) {
      carryMergedDeltaStamp({
        base: latestWrites,
        incoming: event.actions.stateDelta,
        to: latestWrites,
        key,
      });
    }
  }

  if (hasLatestWrites) {
    mergedEvent.actions = mergeEventActions(
      [{stateDelta: latestWrites}],
      mergedEvent.actions,
    );
  }
}

/**
 * The underlying implementation of handleFunctionCalls, taking an array of
 * function calls instead of an event and executing filtered calls concurrently.
 */
export async function handleFunctionCallList({
  invocationContext,
  functionCalls,
  toolsDict,
  beforeToolCallbacks,
  afterToolCallbacks,
  filters,
  toolConfirmationDict,
  resumeInputsDict,
  isLive = false,
}: {
  invocationContext: InvocationContext;
  functionCalls: FunctionCall[];
  toolsDict: Record<string, BaseTool>;
  beforeToolCallbacks: SingleBeforeToolCallback[];
  afterToolCallbacks: SingleAfterToolCallback[];
  filters?: Set<string>;
  toolConfirmationDict?: Record<string, ToolConfirmation>;
  /**
   * Inputs to resume a paused tool call with, keyed by function call id. Each
   * value is itself keyed by interrupt id. Kept apart from
   * `toolConfirmationDict` so resume inputs can never be mistaken for a human
   * approval; see {@link ResumeInputs}.
   */
  resumeInputsDict?: Record<string, ResumeInputs>;
  isLive?: boolean;
}): Promise<Event | null> {
  // Note: only function ids INCLUDED in the filters will be executed.
  const filteredFunctionCalls = functionCalls.filter((functionCall) => {
    return !filters || (functionCall.id && filters.has(functionCall.id));
  });
  if (filteredFunctionCalls.length === 0) {
    return null;
  }

  const settledResults = await Promise.allSettled(
    filteredFunctionCalls.map((functionCall) =>
      executeSingleFunctionCall({
        invocationContext,
        functionCall,
        toolsDict,
        beforeToolCallbacks,
        afterToolCallbacks,
        toolConfirmation:
          toolConfirmationDict &&
          functionCall.id &&
          Object.hasOwn(toolConfirmationDict, functionCall.id)
            ? toolConfirmationDict[functionCall.id]
            : undefined,
        resumeInputs:
          resumeInputsDict &&
          functionCall.id &&
          Object.hasOwn(resumeInputsDict, functionCall.id)
            ? resumeInputsDict[functionCall.id]
            : undefined,
        isLive,
      }),
    ),
  );
  const firstRejection = settledResults.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (firstRejection) {
    throw firstRejection.reason;
  }
  const functionResponseEvents: Event[] = [];
  for (const result of settledResults) {
    if (result.status === 'fulfilled' && result.value !== null) {
      functionResponseEvents.push(result.value);
    }
  }

  if (functionResponseEvents.length === 0) {
    return null;
  }
  const mergedEvent = mergeParallelFunctionResponseEvents(
    functionResponseEvents,
  );
  if (functionResponseEvents.length > 1 && invocationContext.session?.state) {
    applyLatestStateWrites(
      mergedEvent,
      functionResponseEvents,
      invocationContext.session.state,
    );
  }

  if (functionResponseEvents.length > 1) {
    logger.debug('execute_tool (merged)');
    recordMergedToolCalls({responseEventId: mergedEvent.id});
  }
  return mergedEvent;
}

/**
 * Merges a list of function response events into a single event.
 */
// TODO - b/425992518: may not need export. Can be conslidated into Event.
export function mergeParallelFunctionResponseEvents(
  functionResponseEvents: Event[],
): Event {
  if (!functionResponseEvents.length) {
    throw new Error('No function response events provided.');
  }

  if (functionResponseEvents.length === 1) {
    return functionResponseEvents[0];
  }
  const mergedParts: Part[] = [];
  for (const event of functionResponseEvents) {
    if (event.content && event.content.parts) {
      mergedParts.push(...event.content.parts);
    }
  }

  const baseEvent = functionResponseEvents[0];

  const actionsList = functionResponseEvents.map(
    (event) => event.actions || {},
  );
  const mergedActions = mergeEventActions(actionsList);

  return createEvent({
    invocationId: baseEvent.invocationId,
    author: baseEvent.author,
    branch: baseEvent.branch,
    content: {role: 'user', parts: mergedParts},
    actions: mergedActions,
    timestamp: baseEvent.timestamp!,
  });
}

interface MaybeStreamingTool {
  execute?: unknown;
  func?: unknown;
  _callLive?: (
    request: CallLiveToolRequest,
  ) => AsyncGenerator<unknown, void, unknown>;
}

function isAsyncGeneratorFunction(
  fn: unknown,
): fn is (...args: never[]) => AsyncGenerator<unknown, void, unknown> {
  return (
    typeof fn === 'function' &&
    Object.prototype.toString.call(fn) === '[object AsyncGeneratorFunction]'
  );
}

function isStreamingTool(
  tool: BaseTool,
): tool is BaseTool & Required<Pick<MaybeStreamingTool, '_callLive'>> {
  const candidate = tool as BaseTool & MaybeStreamingTool;
  if (typeof candidate._callLive !== 'function') {
    return false;
  }
  if (isFunctionTool(tool)) {
    return isAsyncGeneratorFunction(candidate.execute);
  }
  return (
    isAsyncGeneratorFunction(candidate.execute) ||
    isAsyncGeneratorFunction(candidate.func) ||
    isAsyncGeneratorFunction(candidate._callLive)
  );
}

async function* callToolLive({
  tool,
  args,
  toolContext,
  invocationContext,
}: CallLiveToolRequest & {
  tool: BaseTool & Required<Pick<MaybeStreamingTool, '_callLive'>>;
}): AsyncGenerator<unknown, void, unknown> {
  const results = tool._callLive({
    args,
    toolContext,
    invocationContext,
  });
  for await (const result of new Aclosing(results)) {
    yield result;
  }
}

async function waitForTaskWithTimeout<T>(
  task: Task<T>,
  timeoutMs: number,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutId = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([
      task.promise.then(
        () => undefined,
        () => undefined,
      ),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

const STOP_STREAMING_FUNCTION_NAME = 'stop_streaming';
const STOP_STREAMING_TIMEOUT_MS = 1000;

/**
 * Executes a single tool call in live mode, supporting `stop_streaming`,
 * async-generator streaming tools, and standard sync/async tools.
 */
async function processFunctionLiveHelper({
  tool,
  toolContext,
  functionCall,
  functionArgs,
  invocationContext,
}: {
  tool: BaseTool;
  toolContext: Context;
  functionCall: FunctionCall;
  functionArgs: Record<string, unknown>;
  invocationContext: InvocationContext;
}): Promise<unknown> {
  let functionResponse: unknown = undefined;
  const targetFunctionName =
    typeof functionArgs['function_name'] === 'string'
      ? functionArgs['function_name']
      : typeof functionArgs['functionName'] === 'string'
        ? functionArgs['functionName']
        : undefined;

  // Case 1: stop_streaming function call.
  if (
    functionCall.name === STOP_STREAMING_FUNCTION_NAME &&
    targetFunctionName !== undefined
  ) {
    const activeTasks = invocationContext.activeStreamingTools;
    const activeTask =
      activeTasks && Object.hasOwn(activeTasks, targetFunctionName)
        ? activeTasks[targetFunctionName]?.task
        : undefined;
    if (activeTasks && activeTask && !activeTask.done()) {
      activeTask.cancel();
      await waitForTaskWithTimeout(activeTask, STOP_STREAMING_TIMEOUT_MS);
      if (!activeTask.done()) {
        logger.warn(`The task for ${targetFunctionName} is not cancelled yet.`);
        functionResponse = {
          status: `The task is not cancelled yet for ${targetFunctionName}.`,
        };
      } else {
        // Preserve any newer task started for the same tool while awaiting cancellation.
        const currentStreamingTools = invocationContext.activeStreamingTools;
        if (
          currentStreamingTools &&
          Object.hasOwn(currentStreamingTools, targetFunctionName) &&
          currentStreamingTools[targetFunctionName]?.task === activeTask
        ) {
          currentStreamingTools[targetFunctionName].task = undefined;
        }
        functionResponse = {
          status: `Successfully stopped streaming function ${targetFunctionName}`,
        };
      }
    } else {
      functionResponse = {
        status: `No active streaming function named ${targetFunctionName} found`,
      };
    }
  } else if (isStreamingTool(tool)) {
    // Case 2: the function is an async generator function (streaming tool).
    const task = new Task<void>(async (abortSignal) => {
      const generator = new Aclosing(
        callToolLive({
          tool,
          args: functionArgs,
          toolContext,
          invocationContext,
        }),
      );
      let abortCleanup: (() => void) | undefined;
      const abortPromise = new Promise<IteratorResult<unknown, void>>(
        (resolve) => {
          if (abortSignal.aborted) {
            resolve({value: undefined, done: true});
            return;
          }
          const onAbort = () => {
            resolve({value: undefined, done: true});
          };
          abortSignal.addEventListener('abort', onAbort, {once: true});
          abortCleanup = () =>
            abortSignal.removeEventListener('abort', onAbort);
        },
      );
      try {
        while (!abortSignal.aborted) {
          const nextResult = await Promise.race([
            generator.next(),
            abortPromise,
          ]);
          if (abortSignal.aborted || nextResult.done) {
            break;
          }
          const result = nextResult.value;
          const updatedContent: Content = createUserContent(
            `Function ${tool.name} returned: ${String(result)}`,
          );
          invocationContext.liveRequestQueue?.sendContent(updatedContent);
        }
      } finally {
        abortCleanup?.();
        if (abortSignal.aborted) {
          void generator.close().catch((err: unknown) => {
            logger.debug(
              'Error closing aborted streaming tool generator:',
              err,
            );
          });
        } else {
          await generator.close();
        }
      }
    });

    invocationContext.activeStreamingTools ??= {};
    if (Object.hasOwn(invocationContext.activeStreamingTools, tool.name)) {
      invocationContext.activeStreamingTools[tool.name].task = task;
    } else {
      invocationContext.activeStreamingTools[tool.name] =
        new ActiveStreamingTool({task});
    }
    functionResponse = {
      status:
        'The function is running asynchronously and the results are pending.',
    };
  } else {
    // Case 3: the function is a regular sync or async function tool.
    functionResponse = await callToolAsync(tool, functionArgs, toolContext);
  }
  return functionResponse;
}

// TODO - b/425992518: support function call in live connection.

/**
 * Finds the most recent event before `endIndex` that contains a function call
 * with the given ID.
 */
export function findEventByFunctionCallId(
  events: Event[],
  functionCallId: string,
  endIndex: number = events.length,
): Event | undefined {
  for (let i = endIndex - 1; i >= 0; i--) {
    const event = events[i];
    const functionCalls = getFunctionCalls(event);
    for (const functionCall of functionCalls) {
      if (functionCall.id === functionCallId) {
        return event;
      }
    }
  }
  return undefined;
}

/**
 * Walks the last event's function responses once, matching each to its
 * function call event. Returns the last-resolved match by iteration
 * order (the loop overwrites its result on every match) alongside the
 * first pair of distinct authors encountered, if any. Shared by {@link
 * findMatchingFunctionCall} and `getConflictingFunctionResponseAuthors`
 * so the walk and its matching rules live in exactly one place.
 */
function resolveFunctionResponseMatch(events: Event[]): {
  resolved: Event | undefined;
  conflictingAuthors: [string, string] | undefined;
} {
  if (!events.length) {
    return {resolved: undefined, conflictingAuthors: undefined};
  }
  const lastEvent = events[events.length - 1];
  const functionResponses = getFunctionResponses(lastEvent);
  if (!functionResponses.length) {
    return {resolved: undefined, conflictingAuthors: undefined};
  }

  let resolved: Event | undefined;
  let conflictingAuthors: [string, string] | undefined;
  for (const functionResponse of functionResponses) {
    if (!functionResponse.id) {
      continue;
    }
    const match = findEventByFunctionCallId(
      events,
      functionResponse.id,
      events.length - 1,
    );
    if (!match) {
      continue;
    }
    if (!conflictingAuthors && resolved && resolved.author !== match.author) {
      conflictingAuthors = [resolved.author ?? '', match.author ?? ''];
    }
    resolved = match;
  }
  return {resolved, conflictingAuthors};
}

/**
 * Returns the event containing the function call that the last event's
 * function response(s) answer, by matching functionCall.id to
 * functionResponse.id.
 *
 * Every function response in the last event is checked, not just the
 * first one. A single event can carry responses answering calls from
 * different agents at once -- for example two long-running operations
 * from sibling sub-agents completing together and being resumed in one
 * message. Resolving from only `functionResponses[0]` would silently
 * attribute the rest to whichever agent's call happened to come first,
 * which is the wrong agent for any response that isn't the first one:
 * that response would then be processed under a resumed agent's context
 * it was never meant for, and the agent it actually answers would never
 * be correctly resumed at all.
 *
 * This is a pure lookup: responses with no id, or whose id matches no
 * function call, are skipped rather than treated as an error. When several
 * responses resolve to calls from more than one distinct author, this does
 * not throw; it returns the match for the response checked last. Callers that
 * must reject that case use `getConflictingFunctionResponseAuthors`.
 */
export function findMatchingFunctionCall(events: Event[]): Event | undefined {
  return resolveFunctionResponseMatch(events).resolved;
}

/**
 * Returns the distinct pair of authors when the last event's function
 * responses resolve to function calls from more than one agent, or
 * `undefined` when they all resolve to a single agent (or there is
 * nothing to resolve).
 *
 * This performs the same walk as {@link findMatchingFunctionCall} but
 * reports a conflict instead of resolving to one match, so that a caller can
 * decide what a conflict means. {@link determineAgentForResumption} throws on
 * a conflict when resumability is enabled, and otherwise skips routing to the
 * calling agent.
 */
export function getConflictingFunctionResponseAuthors(
  events: Event[],
): [string, string] | undefined {
  return resolveFunctionResponseMatch(events).conflictingAuthors;
}
