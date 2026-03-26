/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  REQUEST_EUC_FUNCTION_CALL_NAME,
  handleFunctionCallsAsync,
} from '../agents/functions.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {isLlmAgent} from '../agents/llm_agent.js';
import {BaseLlmRequestProcessor} from '../agents/processors/base_llm_processor.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {
  Event,
  getFunctionCalls,
  getFunctionResponses,
} from '../events/event.js';
import {State} from '../sessions/state.js';
import {BaseTool} from '../tools/base_tool.js';
import {AuthHandler} from './auth_handler.js';
import {AuthConfig, AuthToolArguments} from './auth_tool.js';

const TOOLSET_AUTH_CREDENTIAL_ID_PREFIX = '_adk_toolset_auth_';

async function storeAuthAndCollectResumeTargets(
  events: Event[],
  authFcIds: Set<string>,
  authResponses: Record<string, unknown>,
  state: State,
): Promise<Set<string>> {
  const requestedAuthConfigById: Record<string, AuthConfig> = {};
  for (const event of events) {
    const eventFunctionCalls = getFunctionCalls(event);
    for (const functionCall of eventFunctionCalls) {
      if (
        functionCall.id &&
        authFcIds.has(functionCall.id) &&
        functionCall.name === REQUEST_EUC_FUNCTION_CALL_NAME
      ) {
        const args = functionCall.args as unknown as AuthToolArguments;
        if (args && args.authConfig) {
          requestedAuthConfigById[functionCall.id] = args.authConfig;
        }
      }
    }
  }

  for (const fcId of authFcIds) {
    if (!(fcId in authResponses)) {
      continue;
    }
    const authConfig = authResponses[fcId] as AuthConfig;
    const requestedAuthConfig = requestedAuthConfigById[fcId];
    if (requestedAuthConfig && requestedAuthConfig.credentialKey) {
      authConfig.credentialKey = requestedAuthConfig.credentialKey;
    }
    await new AuthHandler(authConfig).parseAndStoreAuthResponse(state);
  }

  const toolsToResume: Set<string> = new Set();
  for (const fcId of authFcIds) {
    const requestedAuthConfig = requestedAuthConfigById[fcId];
    if (!requestedAuthConfig) {
      continue;
    }
    for (const event of events) {
      const eventFunctionCalls = getFunctionCalls(event);
      for (const functionCall of eventFunctionCalls) {
        if (
          functionCall.id === fcId &&
          functionCall.name === REQUEST_EUC_FUNCTION_CALL_NAME
        ) {
          const args = functionCall.args as unknown as AuthToolArguments;
          if (args && args.functionCallId) {
            if (
              args.functionCallId.startsWith(TOOLSET_AUTH_CREDENTIAL_ID_PREFIX)
            ) {
              continue;
            }
            toolsToResume.add(args.functionCallId);
          }
        }
      }
    }
  }

  return toolsToResume;
}

export class AuthPreprocessor extends BaseLlmRequestProcessor {
  override async *runAsync(
    invocationContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!isLlmAgent(agent)) {
      return;
    }

    const events = invocationContext.session.events;
    if (!events || events.length === 0) {
      return;
    }

    let lastEventWithContent = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.content !== undefined) {
        lastEventWithContent = event;
        break;
      }
    }

    if (!lastEventWithContent || lastEventWithContent.author !== 'user') {
      return;
    }

    const responses = getFunctionResponses(lastEventWithContent);
    if (!responses || responses.length === 0) {
      return;
    }

    const authFcIds: Set<string> = new Set();
    const authResponses: Record<string, unknown> = {};

    for (const functionCallResponse of responses) {
      if (functionCallResponse.name !== REQUEST_EUC_FUNCTION_CALL_NAME) {
        continue;
      }
      if (functionCallResponse.id) {
        authFcIds.add(functionCallResponse.id);
        authResponses[functionCallResponse.id] = functionCallResponse.response;
      }
    }

    if (authFcIds.size === 0) {
      return;
    }

    const state = new State(invocationContext.session.state);
    const toolsToResume = await storeAuthAndCollectResumeTargets(
      events,
      authFcIds,
      authResponses,
      state,
    );

    if (toolsToResume.size === 0) {
      return;
    }

    for (let i = events.length - 2; i >= 0; i--) {
      const event = events[i];
      const functionCalls = getFunctionCalls(event);
      if (!functionCalls || functionCalls.length === 0) {
        continue;
      }

      const hasMatchingCall = functionCalls.some((call) =>
        call.id ? toolsToResume.has(call.id) : false,
      );

      if (hasMatchingCall) {
        const canonicalTools = await agent.canonicalTools(
          new ReadonlyContext(invocationContext),
        );
        const toolsDict: Record<string, BaseTool> = {};
        for (const tool of canonicalTools) {
          toolsDict[tool.name] = tool;
        }

        const functionResponseEvent = await handleFunctionCallsAsync({
          invocationContext,
          functionCallEvent: event,
          toolsDict,
          beforeToolCallbacks: agent.canonicalBeforeToolCallbacks,
          afterToolCallbacks: agent.canonicalAfterToolCallbacks,
          filters: toolsToResume,
        });

        if (functionResponseEvent) {
          yield functionResponseEvent;
        }
        return;
      }
    }
  }
}

export const AUTH_PREPROCESSOR = new AuthPreprocessor();
