/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
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
import {camelCaseKeys} from '../utils/case_utils.js';
import {logger} from '../utils/logger.js';
import {AuthHandler} from './auth_handler.js';
import {AuthConfig} from './auth_tool.js';
import {bindCredentialResponse} from './credential_response_binding.js';

const TOOLSET_AUTH_CREDENTIAL_ID_PREFIX = '_adk_toolset_auth_';

interface RequestCredentialArgs {
  authConfig?: AuthConfig;
  functionCallId?: string;
}

/**
 * The credential requests this agent raised, by function call id.
 *
 * Author-checked, because the request is what makes the response meaningful:
 * it says which tool is waiting and under which key the credential belongs. A
 * request in a client-authored event is the client describing its own errand —
 * a credential to store wherever it likes, and a tool of its choosing to
 * resume. Only requests the agent itself raised are honoured.
 */
function requestedAuthConfigs(
  events: Event[],
  authFcIds: Set<string>,
  agentName: string,
): Map<string, {config: AuthConfig; args: RequestCredentialArgs}> {
  const requests = new Map<
    string,
    {config: AuthConfig; args: RequestCredentialArgs}
  >();
  for (const event of events) {
    if (event.author !== agentName) {
      continue;
    }
    for (const functionCall of getFunctionCalls(event)) {
      if (
        !functionCall.id ||
        !authFcIds.has(functionCall.id) ||
        functionCall.name !== REQUEST_CREDENTIAL_FUNCTION_CALL_NAME
      ) {
        continue;
      }
      const args = camelCaseKeys(functionCall.args) as RequestCredentialArgs;
      if (args?.authConfig) {
        requests.set(functionCall.id, {config: args.authConfig, args});
      }
    }
  }
  return requests;
}

async function storeAuthAndCollectResumeTargets(
  events: Event[],
  authFcIds: Set<string>,
  authResponses: Record<string, unknown>,
  state: State,
  agentName: string,
): Promise<Set<string>> {
  const requests = requestedAuthConfigs(events, authFcIds, agentName);

  const toolsToResume: Set<string> = new Set();
  for (const fcId of authFcIds) {
    const request = requests.get(fcId);
    if (!request) {
      // A credential nobody asked for. Storing it would let a caller seed the
      // session's credential store under a key of its own choosing.
      logger.warn(
        `Ignoring credential response '${fcId}': no matching request from this agent.`,
      );
      continue;
    }

    // The response answers the request; it does not get to restate it. The
    // scheme, the client identity and the key all come from the request, and
    // only the credential material comes from the response.
    const authConfig = bindCredentialResponse(
      request.config,
      authResponses[fcId],
    );
    if (!authConfig) {
      logger.warn(
        `Ignoring credential response '${fcId}': it carries no credential for the request this agent raised.`,
      );
      continue;
    }
    await new AuthHandler(authConfig).parseAndStoreAuthResponse(state);

    const functionCallId = request.args?.functionCallId;
    if (
      functionCallId &&
      !functionCallId.startsWith(TOOLSET_AUTH_CREDENTIAL_ID_PREFIX)
    ) {
      toolsToResume.add(functionCallId);
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
      if (functionCallResponse.name !== REQUEST_CREDENTIAL_FUNCTION_CALL_NAME) {
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
      agent.name,
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
