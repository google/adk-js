/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// TODO - b/436079721: implement traceMergedToolCalls, traceToolCall, tracer.
import {Content, FunctionCall, Part} from '@google/genai';

import {InvocationContext} from '../agents/invocation_context.js';
import {createEvent, Event, getFunctionCalls} from '../events/event.js';
import {mergeEventActions} from '../events/event_actions.js';
import {BaseTool} from '../tools/base_tool.js';
import {ToolConfirmation} from '../tools/tool_confirmation.js';
import {ToolContext} from '../tools/tool_context.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {getLogger} from '../utils/logger.js';

import {SingleAfterToolCallback, SingleBeforeToolCallback} from './llm_agent.js';

const logger = getLogger();
const AF_FUNCTION_CALL_ID_PREFIX = 'adk-';
export const REQUEST_EUC_FUNCTION_CALL_NAME = 'adk_request_credential';
export const REQUEST_CONFIRMATION_FUNCTION_CALL_NAME =
    'adk_request_confirmation';

// Export these items for testing purposes only
export const functionsExportedForTestingOnly = {
  handleFunctionCallList,
};

export function generateClientFunctionCallId(): string {
  return `${AF_FUNCTION_CALL_ID_PREFIX}${randomUUID()}`;
}

/**
 * Populates client-side function call IDs.
 *
 * It iterates through all function calls in the event and assigns a
 * unique client-side ID to each one that doesn't already have an ID.
 */
// TODO - b/425992518: consider move into event.ts
export function populateClientFunctionCallId(
    modelResponseEvent: Event,
    ): void {
  const functionCalls = getFunctionCalls(modelResponseEvent);
  if (!functionCalls) {
    return;
  }
  for (const functionCall of functionCalls) {
    if (!functionCall.id) {
      functionCall.id = generateClientFunctionCallId();
    }
  }
}
// TODO - b/425992518: consider internalize in content_[processor].ts
/**
 * Removes the client-generated function call IDs from a given content object.
 *
 * When sending content back to the server, these IDs are
 * specific to the client-side and should not be included in requests to the
 * model.
 */
export function removeClientFunctionCallId(content: Content): void {
  if (content && content.parts) {
    for (const part of content.parts) {
      if (part.functionCall && part.functionCall.id &&
          part.functionCall.id.startsWith(AF_FUNCTION_CALL_ID_PREFIX)) {
        part.functionCall.id = undefined;
      }
      if (part.functionResponse && part.functionResponse.id &&
          part.functionResponse.id.startsWith(AF_FUNCTION_CALL_ID_PREFIX)) {
        part.functionResponse.id = undefined;
      }
    }
  }
}
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
    if (functionCall.name && functionCall.name in toolsDict &&
        toolsDict[functionCall.name].isLongRunning && functionCall.id) {
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
    ): Event|undefined {
  if (!functionResponseEvent.actions?.requestedAuthConfigs) {
    return undefined;
  }
  const parts: Part[] = [];
  const longRunningToolIds = new Set<string>();
  for (const [functionCallId, authConfig] of Object.entries(
           functionResponseEvent.actions.requestedAuthConfigs,
           )) {
    const requestEucFunctionCall: FunctionCall = {
      name: REQUEST_EUC_FUNCTION_CALL_NAME,
      args: {
        'function_call_id': functionCallId,
        'auth_config': authConfig,
      },
      id: generateClientFunctionCallId(),
    };
    longRunningToolIds.add(requestEucFunctionCall.id!);
    parts.push({functionCall: requestEucFunctionCall});
  }

  return createEvent({
    invocationId: invocationContext.invocationId,
    author: invocationContext.agent.name,
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
  invocationContext: InvocationContext,
  functionCallEvent: Event,
  functionResponseEvent: Event
}): Event|undefined {
  if (!functionResponseEvent.actions?.requestedToolConfirmations) {
    return;
  }
  const parts: Part[] = [];
  const longRunningToolIds = new Set<string>();
  const functionCalls = getFunctionCalls(functionCallEvent);

  for (const [functionCallId, toolConfirmation] of Object.entries(
           functionResponseEvent.actions.requestedToolConfirmations,
           )) {
    const originalFunctionCall =
        functionCalls.find(call => call.id === functionCallId) ?? undefined;
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
    author: invocationContext.agent.name,
    branch: invocationContext.branch,
    content: {
      parts: parts,
      role: functionResponseEvent.content!.role,
    },
    longRunningToolIds: Array.from(longRunningToolIds),
  });
}

async function callTool(
    tool: BaseTool,
    args: Record<string, any>,
    toolContext: ToolContext,
    ): Promise<any> {
  // TODO - b/436079721: implement [tracer.start_as_current_span]
  logger.debug(`callTool ${tool.name}`);
  return await tool.run({args, toolContext});
}

function buildResponseEvent(
    tool: BaseTool,
    functionResult: any,
    toolContext: ToolContext,
    invocationContext: InvocationContext,
    ): Event {
  let responseResult = functionResult;
  if (typeof functionResult !== 'object' || functionResult == null) {
    responseResult = {result: functionResult};
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
    author: invocationContext.agent.name,
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
export async function handleFunctionCalls({
  invocationContext,
  functionCallEvent,
  toolsDict,
  beforeToolCallbacks,
  afterToolCallbacks,
  filters,
  toolConfirmationDict,
}: {
  invocationContext: InvocationContext,
  functionCallEvent: Event,
  toolsDict: Record<string, BaseTool>,
  beforeToolCallbacks: SingleBeforeToolCallback[],
  afterToolCallbacks: SingleAfterToolCallback[],
  filters?: Set<string>,
  toolConfirmationDict?: Record<string, ToolConfirmation>,
}): Promise<Event|null> {
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
  invocationContext: InvocationContext,
  functionCalls: FunctionCall[],
  toolsDict: Record<string, BaseTool>,
  beforeToolCallbacks: SingleBeforeToolCallback[],
  afterToolCallbacks: SingleAfterToolCallback[],
  filters?: Set<string>,
  toolConfirmationDict?: Record<string, ToolConfirmation>,
}): Promise<Event|null> {
  const functionResponseEvents: Event[] = [];

  // Note: only function ids INCLUDED in the filters will be executed.
  const filteredFunctionCalls = functionCalls.filter(functionCall => {
    return !filters || (functionCall.id && filters.has(functionCall.id));
  });

  for (const functionCall of filteredFunctionCalls) {
    let toolConfirmation = undefined;
    if (toolConfirmationDict && functionCall.id) {
      toolConfirmation = toolConfirmationDict[functionCall.id];
    }

    const {tool, toolContext} = getToolAndContext(
        {
          invocationContext: invocationContext,
          functionCall: functionCall,
          toolsDict: toolsDict,
          toolConfirmation: toolConfirmation,
        },
    );

    // TODO - b/436079721: implement [tracer.start_as_current_span]
    logger.debug(`execute_tool ${tool.name}`);
    const functionArgs = functionCall.args ?? {};

    // Step 1: Check if plugin before_tool_callback overrides the function
    // response.
    let functionResponse = null;
    functionResponse =
        await invocationContext.pluginManager.runBeforeToolCallback({
          tool: tool,
          toolArgs: functionArgs,
          toolContext: toolContext,
        });

    // Step 2: If no overrides are provided from the plugins, further run the
    // canonical callback.
    // TODO - b/425992518: validate the callback response type matches.
    if (functionResponse == null) {  // Cover both null and undefined
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

    // Step 3: Otherwise, proceed calling the tool normally.
    if (functionResponse == null) {  // Cover both null and undefined
      try {
        functionResponse = await callTool(
            tool,
            functionArgs,
            toolContext,
        );
      } catch (e: unknown) {
        if (e instanceof Error) {
          const onToolErrorResponse =
              await invocationContext.pluginManager.runOnToolErrorCallback(
                  {
                    tool: tool,
                    toolArgs: functionArgs,
                    toolContext: toolContext,
                    error: e as Error,
                  },
              );

          // Set function response to the result of the error callback and
          // continue execution, do not shortcut
          if (onToolErrorResponse) {
            functionResponse = onToolErrorResponse;
          }
        } else {
          logger.error('Unknown error on tool execution type', e);
          throw e;
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
    if (alteredFunctionResponse == null) {  // Cover both null and undefined
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
      functionResponse = alteredFunctionResponse;
    }

    // TODO - b/425992518: state event polluting runtime, consider fix.
    // Allow long running function to return None as response.
    if (tool.isLongRunning && !functionResponse) {
      continue;
    }

    // Builds the function response event.
    const functionResponseEvent = buildResponseEvent(
        tool,
        functionResponse,
        toolContext,
        invocationContext,
    );
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
  const mergedEvent =
      mergeParallelFunctionResponseEvents(functionResponseEvents);

  if (functionResponseEvents.length > 1) {
    // TODO - b/436079721: implement [tracer.start_as_current_span]
    logger.debug('execute_tool (merged)');
    // TODO - b/436079721: implement [traceMergedToolCalls]
    logger.debug('traceMergedToolCalls', {
      responseEventId: mergedEvent.id,
      functionResponseEvent: mergedEvent.id,
    });
  }
  return mergedEvent;
}

// TODO - b/425992518: consider inline, which is much cleaner.
function getToolAndContext(
    {
      invocationContext,
      functionCall,
      toolsDict,
      toolConfirmation,
    }: {
      invocationContext: InvocationContext,
      functionCall: FunctionCall,
      toolsDict: Record<string, BaseTool>,
      toolConfirmation?: ToolConfirmation,
    },
    ): {tool: BaseTool; toolContext: ToolContext} {
  if (!functionCall.name || !(functionCall.name in toolsDict)) {
    throw new Error(
        `Function ${functionCall.name} is not found in the toolsDict.`,
    );
  }

  const toolContext = new ToolContext({
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

  const actionsList = functionResponseEvents.map(event => event.actions || {});
  const mergedActions = mergeEventActions(actionsList);

  return createEvent({
    author: baseEvent.author,
    branch: baseEvent.branch,
    content: {role: 'user', parts: mergedParts},
    actions: mergedActions,
    timestamp: baseEvent.timestamp!,
  });
}

// TODO - b/425992518: support function call in live connection.
