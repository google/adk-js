/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, createUserContent, FunctionCall, Part} from '@google/genai';
import {isEmpty} from 'lodash-es';

import {InvocationContext} from '../agents/invocation_context.js';
import {createEvent, Event, getFunctionCalls} from '../events/event.js';
import {mergeEventActions} from '../events/event_actions.js';
import {BaseTool} from '../tools/base_tool.js';
import {ToolConfirmation} from '../tools/tool_confirmation.js';
import {ToolContext} from '../tools/tool_context.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';

import {
  traceMergedToolCalls,
  tracer,
  traceToolCall,
} from '../telemetry/tracing.js';
import {
  SingleAfterToolCallback,
  SingleBeforeToolCallback,
} from './llm_agent.js';

const AF_FUNCTION_CALL_ID_PREFIX = 'adk-';
export const REQUEST_EUC_FUNCTION_CALL_NAME = 'adk_request_credential';
export const REQUEST_CONFIRMATION_FUNCTION_CALL_NAME =
  'adk_request_confirmation';

// Export these items for testing purposes only
export const functionsExportedForTestingOnly = {
  handleFunctionCallList,
  executeSingleFunctionCall,
  generateAuthEvent,
  generateRequestConfirmationEvent,
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
export function populateClientFunctionCallId(modelResponseEvent: Event): void {
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
      if (
        part.functionCall &&
        part.functionCall.id &&
        part.functionCall.id.startsWith(AF_FUNCTION_CALL_ID_PREFIX)
      ) {
        part.functionCall.id = undefined;
      }
      if (
        part.functionResponse &&
        part.functionResponse.id &&
        part.functionResponse.id.startsWith(AF_FUNCTION_CALL_ID_PREFIX)
      ) {
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
  args: Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  toolContext: ToolContext,
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
  toolContext: ToolContext,
  invocationContext: InvocationContext,
): Event {
  let responseResult: Record<string, unknown>;
  if (typeof functionResult !== 'object' || functionResult == null) {
    responseResult = {result: functionResult};
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
 * Executes a single function call through the full callback pipeline.
 *
 * Extracted from the former sequential loop to enable parallel execution
 * via Promise.allSettled. Mirrors adk-python's _execute_single_function_call_async.
 *
 * Pipeline: plugin before → canonical before → tool exec → plugin after → canonical after → build event.
 */
async function executeSingleFunctionCall({
  invocationContext,
  functionCall,
  toolsDict,
  beforeToolCallbacks,
  afterToolCallbacks,
  toolConfirmation,
}: {
  invocationContext: InvocationContext;
  functionCall: FunctionCall;
  toolsDict: Record<string, BaseTool>;
  beforeToolCallbacks: SingleBeforeToolCallback[];
  afterToolCallbacks: SingleAfterToolCallback[];
  toolConfirmation?: ToolConfirmation;
}): Promise<Event | null> {
  const {tool, toolContext} = getToolAndContext({
    invocationContext,
    functionCall,
    toolsDict,
    toolConfirmation,
  });

  logger.debug(`execute_tool ${tool.name}`);
  const functionArgs = functionCall.args ?? {};

  let functionResponse = null;
  let functionResponseError: string | unknown | undefined;

  // Step 1: plugin before_tool_callback
  functionResponse =
    await invocationContext.pluginManager.runBeforeToolCallback({
      tool: tool,
      toolArgs: functionArgs,
      toolContext: toolContext,
    });

  // Step 2: canonical beforeToolCallbacks
  // TODO - b/425992518: validate the callback response type matches.
  if (functionResponse == null) {
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

  // Step 3: call the tool
  if (functionResponse == null) {
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

        if (onToolErrorResponse) {
          functionResponse = onToolErrorResponse;
        } else {
          functionResponseError = e.message;
        }
      } else {
        functionResponseError = e;
      }
    }
  }

  // Step 4: plugin after_tool_callback
  let alteredFunctionResponse =
    await invocationContext.pluginManager.runAfterToolCallback({
      tool: tool,
      toolArgs: functionArgs,
      toolContext: toolContext,
      result: functionResponse,
    });

  // Step 5: canonical afterToolCallbacks
  if (alteredFunctionResponse == null) {
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

  // Step 6: apply altered response
  if (alteredFunctionResponse != null) {
    functionResponse = alteredFunctionResponse;
  }

  // TODO - b/425992518: state event polluting runtime, consider fix.
  if (tool.isLongRunning && !functionResponse) {
    return null;
  }

  if (functionResponseError) {
    functionResponse = {error: functionResponseError};
  } else if (
    typeof functionResponse !== 'object' ||
    functionResponse == null
  ) {
    functionResponse = {result: functionResponse};
  }

  const functionResponseEvent = createEvent({
    invocationId: invocationContext.invocationId,
    author: invocationContext.agent.name,
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

  return functionResponseEvent;
}

/**
 * The underlying implementation of handleFunctionCalls, but takes a list of
 * function calls instead of an event.
 * This is also used by llm_agent execution flow in preprocessing.
 *
 * Execution mode is controlled by `RunConfig.parallelToolExecution`:
 * - true (default): tool calls run concurrently via Promise.allSettled,
 *   matching adk-python's asyncio.gather pattern. Individual failures
 *   do not affect other calls — failed tools produce error response events.
 * - false: tool calls execute sequentially in order, preserving original
 *   behavior for tools with interdependencies or ordering requirements.
 *
 * When parallel, `RunConfig.maxConcurrentToolCalls` controls back-pressure:
 * - undefined/0: all tool calls dispatch at once (no limit).
 * - positive int: tool calls dispatch in batches of this size.
 *
 * In parallel mode, overlapping `stateDelta` keys across tools are detected
 * and logged as a warning (last-write-wins applies).
 *
 * NOTE: In parallel mode, beforeToolCallback / afterToolCallback may fire
 * concurrently. Callbacks must not depend on execution order across calls.
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
  // Note: only function ids INCLUDED in the filters will be executed.
  const filteredFunctionCalls = functionCalls.filter((functionCall) => {
    return !filters || (functionCall.id && filters.has(functionCall.id));
  });

  if (!filteredFunctionCalls.length) {
    return null;
  }

  const parallel =
    invocationContext.runConfig?.parallelToolExecution ?? true;

  const functionResponseEvents: Event[] = [];

  if (parallel) {
    // Concurrent execution — mirrors Python ADK's asyncio.gather.
    const makeTask = (functionCall: FunctionCall) => {
      const toolConfirmation =
        toolConfirmationDict && functionCall.id
          ? toolConfirmationDict[functionCall.id]
          : undefined;

      return () =>
        executeSingleFunctionCall({
          invocationContext,
          functionCall,
          toolsDict,
          beforeToolCallbacks,
          afterToolCallbacks,
          toolConfirmation,
        });
    };

    const maxConcurrency =
      invocationContext.runConfig?.maxConcurrentToolCalls;
    const useBatching =
      maxConcurrency &&
      maxConcurrency > 0 &&
      filteredFunctionCalls.length > maxConcurrency;

    let results: PromiseSettledResult<Event | null>[];

    if (useBatching) {
      results = [];
      for (
        let i = 0;
        i < filteredFunctionCalls.length;
        i += maxConcurrency
      ) {
        const batch = filteredFunctionCalls.slice(i, i + maxConcurrency);
        const batchResults = await Promise.allSettled(
          batch.map((fc) => makeTask(fc)()),
        );
        results.push(...batchResults);
      }
    } else {
      results = await Promise.allSettled(
        filteredFunctionCalls.map((fc) => makeTask(fc)()),
      );
    }

    for (const [i, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        if (result.value) {
          functionResponseEvents.push(result.value);
        }
      } else {
        const fc = filteredFunctionCalls[i];
        logger.warn(`Parallel tool call failed: ${fc.name}`, {
          error: result.reason,
        });
        const errorMessage =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        functionResponseEvents.push(
          createEvent({
            invocationId: invocationContext.invocationId,
            author: invocationContext.agent.name,
            content: createUserContent({
              functionResponse: {
                id: fc.id || undefined,
                name: fc.name!,
                response: {error: errorMessage},
              },
            }),
            branch: invocationContext.branch,
          }),
        );
      }
    }

    // Warn on stateDelta key conflicts from concurrent tool calls
    if (functionResponseEvents.length > 1) {
      const seenKeys = new Set<string>();
      const conflictKeys: string[] = [];
      for (const event of functionResponseEvents) {
        if (event.actions?.stateDelta) {
          for (const key of Object.keys(event.actions.stateDelta)) {
            if (seenKeys.has(key)) {
              conflictKeys.push(key);
            }
            seenKeys.add(key);
          }
        }
      }
      if (conflictKeys.length > 0) {
        logger.warn(
          `Parallel tool calls wrote to the same stateDelta key(s): [${conflictKeys.join(', ')}]. Last-write-wins applies — consider sequential mode if ordering matters.`,
        );
      }
    }
  } else {
    // Sequential execution — preserves original ordering guarantees.
    for (const functionCall of filteredFunctionCalls) {
      const toolConfirmation =
        toolConfirmationDict && functionCall.id
          ? toolConfirmationDict[functionCall.id]
          : undefined;

      const event = await executeSingleFunctionCall({
        invocationContext,
        functionCall,
        toolsDict,
        beforeToolCallbacks,
        afterToolCallbacks,
        toolConfirmation,
      });

      if (event) {
        functionResponseEvents.push(event);
      }
    }
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
}): {tool: BaseTool; toolContext: ToolContext} {
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

  const actionsList = functionResponseEvents.map(
    (event) => event.actions || {},
  );
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
