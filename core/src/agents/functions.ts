/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// TODO - b/425992518: implement traceMergedToolCalls, traceToolCall, tracer.
import {Content, FunctionCall, Part} from '@google/genai';

import {InvocationContext} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';
import {EventActions, mergeEventActions} from '../events/event_actions.js';
import {BaseTool} from '../tools/base_tool.js';
import {ToolContext} from '../tools/tool_context.js';
import {randomUUID} from '../utils/env_aware_utils.js';

import {SingleAfterToolCallback, SingleBeforeToolCallback} from './llm_agent.js';

const AF_FUNCTION_CALL_ID_PREFIX = 'adk-';
export const REQUEST_EUC_FUNCTION_CALL_NAME = 'adk_request_credential';

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
  const functionCalls = modelResponseEvent.getFunctionCalls();
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

  return new Event({
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

async function callToolAsync(
    tool: BaseTool,
    args: Record<string, any>,
    toolContext: ToolContext,
    ): Promise<any> {
  // TODO - b/425992518: implement [tracer.start_as_current_span]
  console.debug(`callToolAsync ${tool.name}`);
    return await tool.runAsync({args, toolContext});
}

function buildResponseEvent(
    tool: BaseTool,
    functionResult: any,
    toolContext: ToolContext,
    invocationContext: InvocationContext,
    ): Event {
  let responseResult = functionResult;
  if (typeof functionResult !== 'object' || functionResult === null) {
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

  return new Event({
    invocationId: invocationContext.invocationId,
    author: invocationContext.agent.name,
    content: content,
    actions: toolContext.actions || new EventActions({}),
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
export async function handleFunctionCallsAsync(
    invocationContext: InvocationContext,
    functionCallEvent: Event,
    toolsDict: Record<string, BaseTool>,
    beforeToolCallbacks: SingleBeforeToolCallback[],
    afterToolCallbacks: SingleAfterToolCallback[],
    filters?: Set<string>,
    ): Promise<Event|null> {
  const functionCalls = functionCallEvent.getFunctionCalls();
  const functionResponseEvents: Event[] = [];

  for (const functionCall of functionCalls) {
    if (functionCall.id && filters?.has(functionCall.id)) {
      continue;
    }
    const {tool, toolContext} = getToolAndContext(
        invocationContext,
        functionCall,
        toolsDict,
    );

    // TODO - b/425992518: implement [tracer.start_as_current_span]
    console.debug(`execute_tool ${tool.name}`);
    const functionArgs = functionCall.args ?? {};

    // Step 1: Check if plugin before_tool_callback overrides the function
    // response.
    // TODO - b/425992518: implement PluginManager - runBeforeToolCallback
    let functionResponse = null;

    // Step 2: If no overrides are provided from the plugins, further run the
    // canonical callback.
    // TODO - b/425992518: validate the callback response type matches.
    if (functionResponse === null) {
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
    if (functionResponse === null) {
      functionResponse = await callToolAsync(
          tool,
          functionArgs,
          toolContext,
      );
      // TODO - b/425992518: implement PluginManager - runOnToolErrorCallback
    }

    // Step 4: Check if plugin after_tool_callback overrides the function
    // response.
    // TODO - b/425992518: implement PluginManager - runAfterToolCallback
    let alteredFunctionResponse = null;

    // Step 5: If no overrides are provided from the plugins, further run the
    // canonical after_tool_callbacks.
    if (alteredFunctionResponse === null) {
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
    if (alteredFunctionResponse !== null) {
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
    // TODO - b/425992518: implement [traceToolCall]
    console.debug('traceToolCall', {
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
    // TODO - b/425992518: implement [tracer.start_as_current_span]
    console.debug('execute_tool (merged)');
    // TODO - b/425992518: implement [traceMergedToolCalls]
    console.debug('traceMergedToolCalls', {
      responseEventId: mergedEvent.id,
      functionResponseEvent: mergedEvent.id,
    });
  }
  return mergedEvent;
}

// TODO - b/425992518: consider inline, which is much cleaner.
function getToolAndContext(
    invocationContext: InvocationContext,
    functionCall: FunctionCall,
    toolsDict: Record<string, BaseTool>,
    ): {tool: BaseTool; toolContext: ToolContext} {
  if (!functionCall.name || !(functionCall.name in toolsDict)) {
    throw new Error(
        `Function ${functionCall.name} is not found in the toolsDict.`,
    );
  }

  const toolContext = new ToolContext({
    invocationContext: invocationContext,
    functionCallId: functionCall.id || undefined,
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

  const mergedEvent = new Event({
    author: baseEvent.author,
    branch: baseEvent.branch,
    content: {role: 'user', parts: mergedParts},
    actions: mergedActions,
    timestamp: baseEvent.timestamp!,
  });
  return mergedEvent;
}

// TODO - b/425992518: support function call in live connection.
