/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, createUserContent, FunctionCall, Part} from '@google/genai';
import {isEmpty} from 'lodash-es';

import {InvocationContext} from '../agents/invocation_context.js';
import {
  createEvent,
  Event,
  generateClientFunctionCallId,
  getFunctionCalls,
  getFunctionResponses,
} from '../events/event.js';
import {mergeEventActions} from '../events/event_actions.js';
import {BaseTool} from '../tools/base_tool.js';
import {ToolConfirmation} from '../tools/tool_confirmation.js';
import {logger} from '../utils/logger.js';
import {Context} from './context.js';
import {
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
} from './framework_function_calls.js';

import {
  traceMergedToolCalls,
  tracer,
  traceToolCall,
} from '../telemetry/tracing.js';

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
      functionCall.name in toolsDict &&
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
      role: functionResponseEvent.content!.role,
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
      role: functionResponseEvent.content!.role,
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
  return tracer.startActiveSpan(`execute_tool ${tool.name}`, async (span) => {
    try {
      logger.debug(`callToolAsync ${tool.name}`);
      const result = await tool.runAsync({args, toolContext});
      traceToolCall({
        tool,
        args,
        functionResponseEvent: buildResponseEvent(
          tool,
          result,
          toolContext,
          toolContext.invocationContext,
        ),
      });
      return result;
    } finally {
      span.end();
    }
  });
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
    functionResponse: {
      name: tool.name,
      response: responseResult,
      id: toolContext.functionCallId,
    },
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
 * Handles function calls.
 * Runtime behavior to pay attention to:
 * - Iterate through each function call in the `functionCallEvent`:
 *   - Execute before tool callbacks !!if a callback provides a response, short
 *     circuit the rest.
 *   - Execute the tool.
 *   - Execute after tool callbacks !!if a callback provides a response, short
 *     circuit the rest.
 *   - If the tool is long-running and the response is null, continue. !!state
 * - Merge all function response events into a single event.
 */
export async function handleFunctionCallsAsync({
  invocationContext,
  functionCallEvent,
  toolsDict,
  beforeToolCallbacks,
  afterToolCallbacks,
  filters,
  toolConfirmationDict,
}: {
  invocationContext: InvocationContext;
  functionCallEvent: Event;
  toolsDict: Record<string, BaseTool>;
  beforeToolCallbacks: SingleBeforeToolCallback[];
  afterToolCallbacks: SingleAfterToolCallback[];
  filters?: Set<string>;
  toolConfirmationDict?: Record<string, ToolConfirmation>;
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
 * The underlying implementation of handleFunctionCalls, but takes a list of
 * function calls instead of an event.
 * This is also used by llm_agent execution flow in preprocessing.
 */
export async function handleFunctionCallList({
  invocationContext,
  functionCalls,
  toolsDict,
  beforeToolCallbacks,
  afterToolCallbacks,
  filters,
  toolConfirmationDict,
}: {
  invocationContext: InvocationContext;
  functionCalls: FunctionCall[];
  toolsDict: Record<string, BaseTool>;
  beforeToolCallbacks: SingleBeforeToolCallback[];
  afterToolCallbacks: SingleAfterToolCallback[];
  filters?: Set<string>;
  toolConfirmationDict?: Record<string, ToolConfirmation>;
}): Promise<Event | null> {
  const functionResponseEvents: Event[] = [];

  // Note: only function ids INCLUDED in the filters will be executed.
  const filteredFunctionCalls = functionCalls.filter((functionCall) => {
    return !filters || (functionCall.id && filters.has(functionCall.id));
  });

  for (const functionCall of filteredFunctionCalls) {
    let toolConfirmation = undefined;
    if (toolConfirmationDict && functionCall.id) {
      toolConfirmation = toolConfirmationDict[functionCall.id];
    }

    const {tool, toolContext} = getToolAndContext({
      invocationContext,
      functionCall,
      toolsDict,
      toolConfirmation,
    });

    // TODO - b/436079721: implement [tracer.start_as_current_span]
    logger.debug(`execute_tool ${tool.name}`);
    const functionArgs = functionCall.args ?? {};

    // Step 1: Check if plugin before_tool_callback overrides the function
    // response.
    let functionResponse = null;
    let functionResponseError: unknown;
    functionResponse =
      await invocationContext.pluginManager.runBeforeToolCallback({
        tool: tool,
        toolArgs: functionArgs,
        toolContext: toolContext,
      });

    // Step 2: If no overrides are provided from the plugins, further run the
    // canonical callback.
    if (functionResponse == null) {
      // Cover both null and undefined
      for (const callback of beforeToolCallbacks) {
        functionResponse = await callback({
          tool: tool,
          args: functionArgs,
          context: toolContext,
        });
        if (functionResponse) {
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
        functionResponse = await callToolAsync(tool, functionArgs, toolContext);
      } catch (e: unknown) {
        if (e instanceof Error) {
          const onToolErrorResponse =
            await invocationContext.pluginManager.runOnToolErrorCallback({
              tool: tool,
              toolArgs: functionArgs,
              toolContext: toolContext,
              error: e,
            });

          // Set function response to the result of the error callback and
          // continue execution, do not shortcut
          if (onToolErrorResponse != null) {
            functionResponse = normalizeCallbackResponse(onToolErrorResponse);
          } else {
            // If the error callback returns undefined, use the error message
            // as the function response error.
            functionResponseError = e.message;
          }
        } else {
          // If the error is not an Error, use the error object as the function
          // response error.
          functionResponseError = e;
        }
      }
    }

    // Step 4: Check if plugin after_tool_callback overrides the function
    // response.
    let alteredFunctionResponse =
      await invocationContext.pluginManager.runAfterToolCallback({
        tool: tool,
        toolArgs: functionArgs,
        toolContext: toolContext,
        result: functionResponse,
      });

    // Step 5: If no overrides are provided from the plugins, further run the
    // canonical after_tool_callbacks.
    if (alteredFunctionResponse == null) {
      // Cover both null and undefined
      for (const callback of afterToolCallbacks) {
        alteredFunctionResponse = await callback({
          tool: tool,
          args: functionArgs,
          context: toolContext,
          response: functionResponse,
        });
        if (alteredFunctionResponse) {
          break;
        }
      }
    }

    // Step 6: If alternative response exists from after_tool_callback, use it
    // instead of the original function response.
    if (alteredFunctionResponse != null) {
      functionResponse = normalizeCallbackResponse(alteredFunctionResponse);
    }

    // Allow long running function to return None as response.
    // Only a nullish response defers the event. A falsy-but-present response
    // ('', 0, false) is a real result and still emits one, so long-running
    // tools that return such a value now produce a response event where they
    // previously produced none.
    if (tool.isLongRunning && functionResponse == null) {
      continue;
    }

    if (functionResponseError) {
      functionResponse = {error: functionResponseError};
    } else if (functionResponse == null) {
      functionResponse = {result: functionResponse};
    } else {
      functionResponse = normalizeCallbackResponse(functionResponse);
    }

    const functionResponseEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author: toolEventAuthor(invocationContext),
      content: createUserContent({
        functionResponse: {
          id: toolContext.functionCallId,
          name: tool.name,
          response: functionResponse,
        },
      }),
      actions: toolContext.actions,
      branch: invocationContext.branch,
    });

    // TODO - b/436079721: implement [traceToolCall]
    logger.debug('traceToolCall', {
      tool: tool.name,
      args: functionArgs,
      functionResponseEvent: functionResponseEvent.id,
    });
    functionResponseEvents.push(functionResponseEvent);
  }

  if (!functionResponseEvents.length) {
    return null;
  }
  const mergedEvent = mergeParallelFunctionResponseEvents(
    functionResponseEvents,
  );

  if (functionResponseEvents.length > 1) {
    tracer.startActiveSpan('execute_tool (merged)', (span) => {
      try {
        logger.debug('execute_tool (merged)');
        // TODO - b/436079721: implement [traceMergedToolCalls]
        logger.debug('traceMergedToolCalls', {
          responseEventId: mergedEvent.id,
          functionResponseEvent: mergedEvent.id,
        });
        traceMergedToolCalls({
          responseEventId: mergedEvent.id,
          functionResponseEvent: mergedEvent,
        });
      } finally {
        span.end();
      }
    });
  }
  return mergedEvent;
}

// TODO - b/425992518: consider inline, which is much cleaner.
function getToolAndContext({
  invocationContext,
  functionCall,
  toolsDict,
  toolConfirmation,
}: {
  invocationContext: InvocationContext;
  functionCall: FunctionCall;
  toolsDict: Record<string, BaseTool>;
  toolConfirmation?: ToolConfirmation;
}): {tool: BaseTool; toolContext: Context} {
  if (!functionCall.name || !(functionCall.name in toolsDict)) {
    throw new Error(
      `Function ${functionCall.name} is not found in the toolsDict.`,
    );
  }

  const toolContext = new Context({
    invocationContext: invocationContext,
    functionCallId: functionCall.id || undefined,
    toolConfirmation,
  });

  const tool = toolsDict[functionCall.name];

  return {tool, toolContext};
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

// TODO - b/425992518: support function call in live connection.

/**
 * Finds the function call event that matches the function call ID.
 * Mirrors Python ADK's `find_event_by_function_call_id`.
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
 * Finds the function call event that matches the function response ID of the last event.
 * Mirrors Python ADK's `find_matching_function_call`.
 */
export function findMatchingFunctionCall(events: Event[]): Event | undefined {
  if (!events.length) {
    return undefined;
  }
  const lastEvent = events[events.length - 1];
  const functionResponses = getFunctionResponses(lastEvent);
  if (!functionResponses.length || !functionResponses[0].id) {
    return undefined;
  }
  return findEventByFunctionCallId(
    events,
    functionResponses[0].id,
    events.length - 1,
  );
}
