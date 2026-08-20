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
import {AuthCredential} from './auth_credential.js';
import {AuthHandler} from './auth_handler.js';
import {AuthConfig} from './auth_tool.js';

const TOOLSET_AUTH_CREDENTIAL_ID_PREFIX = '_adk_toolset_auth_';

interface RequestCredentialArgs {
  authConfig?: AuthConfig;
  functionCallId?: string;
}

/**
 * Merges OAuth2 fields from `source` into `target` for fields where `target`
 * is unset. Mirrors adk-python's `_merge_credential_oauth2_fields`.
 */
function mergeCredentialOAuth2Fields(
  target: AuthCredential | undefined,
  source: AuthCredential | undefined,
): AuthCredential | undefined {
  if (!source) {
    return target;
  }
  if (!target) {
    return source;
  }
  if (!target.oauth2 && source.oauth2) {
    target.oauth2 = {...source.oauth2};
  } else if (target.oauth2 && source.oauth2) {
    const targetOauth2 = target.oauth2;
    const sourceOauth2 = source.oauth2;
    for (const key of Object.keys(sourceOauth2) as Array<
      keyof typeof sourceOauth2
    >) {
      if (targetOauth2[key] === undefined && sourceOauth2[key] !== undefined) {
        (targetOauth2 as Record<string, unknown>)[key] = sourceOauth2[key];
      }
    }
  }
  return target;
}

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
        functionCall.name === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME
      ) {
        const args = camelCaseKeys(functionCall.args) as RequestCredentialArgs;
        const authConfig = args?.authConfig;
        if (authConfig) {
          requestedAuthConfigById[functionCall.id] = authConfig;
        }
      }
    }
  }

  // Step 2: Store credentials. The client's response supplies the result of
  // the user's browser round trip; the auth scheme and the credential key
  // come from the request this server issued.
  for (const fcId of authFcIds) {
    const requestedAuthConfig = requestedAuthConfigById[fcId];
    if (!requestedAuthConfig) {
      // Nothing to pin against, so the response would get to choose both
      // the credential it is exchanged with and the endpoint that goes to.
      continue;
    }

    const authConfig = authResponses[fcId] as AuthConfig;
    // The scheme names the token endpoint the developer's secret is posted
    // to -- it must come from the request this server issued, never from
    // the client's response.
    authConfig.authScheme = requestedAuthConfig.authScheme;
    if (requestedAuthConfig.credentialKey) {
      authConfig.credentialKey = requestedAuthConfig.credentialKey;
    }
    authConfig.rawAuthCredential = mergeCredentialOAuth2Fields(
      authConfig.rawAuthCredential,
      requestedAuthConfig.rawAuthCredential,
    );
    authConfig.exchangedAuthCredential = mergeCredentialOAuth2Fields(
      authConfig.exchangedAuthCredential,
      requestedAuthConfig.exchangedAuthCredential,
    );
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
          functionCall.name === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME
        ) {
          const args = camelCaseKeys(
            functionCall.args,
          ) as RequestCredentialArgs;
          const functionCallId = args?.functionCallId;
          if (functionCallId) {
            if (functionCallId.startsWith(TOOLSET_AUTH_CREDENTIAL_ID_PREFIX)) {
              continue;
            }
            toolsToResume.add(functionCallId);
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
