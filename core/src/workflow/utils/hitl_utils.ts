/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Utilities for Human-in-the-Loop (HITL) workflows.
 *
 * Ported (subset) from `google/adk-python`
 * `workflow/utils/_workflow_hitl_utils.py`.
 */

import {Part} from '@google/genai';
import {
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from '../../agents/functions.js';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../auth/auth_credential.js';
import {AuthHandler} from '../../auth/auth_handler.js';
import {AuthConfig} from '../../auth/auth_tool.js';
import {createEvent, Event} from '../../events/event.js';
import {State} from '../../sessions/state.js';
import {compileJsonSchema, toJsonSchema} from '../../utils/schema.js';
import {RequestInput} from '../request_input.js';

export {
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from '../../agents/functions.js';

/**
 * Creates an interrupt {@link Event} from a {@link RequestInput}. The event
 * carries an `adk_request_input` function call and marks the interrupt id as a
 * long-running tool id.
 */
export function createRequestInputEvent(requestInput: RequestInput): Event {
  const args: Record<string, unknown> = {
    interruptId: requestInput.interruptId,
    payload: requestInput.payload ?? null,
    message: requestInput.message ?? null,
    responseSchema: requestInput.responseSchema
      ? toJsonSchema(requestInput.responseSchema)
      : null,
  };

  return createEvent({
    content: {
      role: 'model',
      parts: [
        {
          functionCall: {
            name: REQUEST_INPUT_FUNCTION_CALL_NAME,
            args,
            id: requestInput.interruptId,
          },
        },
      ],
    },
    longRunningToolIds: [requestInput.interruptId],
  });
}

/**
 * Collects the `responseSchema` each pending interrupt declared, keyed by
 * interrupt id, as the JSON Schema recorded on its `adk_request_input` call.
 *
 * The original {@link RequestInput} is long gone by the time a reply arrives —
 * a node with `rerunOnResume: false` never runs its body again — so the
 * serialized copy on the event is the only surviving record of the contract.
 */
export function responseSchemasByInterruptId(
  events: Event[],
): Map<string, unknown> {
  const schemas = new Map<string, unknown>();
  for (const event of events) {
    for (const part of event.content?.parts ?? []) {
      const fc = part.functionCall;
      if (fc?.name !== REQUEST_INPUT_FUNCTION_CALL_NAME || !fc.id) {
        continue;
      }
      const schema = (fc.args as Record<string, unknown> | undefined)?.[
        'responseSchema'
      ];
      if (schema) {
        schemas.set(fc.id, schema);
      }
    }
  }
  return schemas;
}

/**
 * Checks a *structured* reply against the `responseSchema` its interrupt
 * declared, and throws when it does not match.
 *
 * Only structured replies are checked. A plain-text reply is routed to every
 * pending interrupt as-is (the interactive CLI and the dev UI both rely on
 * that), and holding free text to an object schema would break it.
 *
 * Without this, a reply in the wrong shape is simply handed to the next node:
 * a client that wraps its answer as `{response: x}` instead of `{result: x}`
 * gets the whole envelope delivered as the node's input, which typically
 * surfaces far downstream as a stringified `[object Object]`.
 */
export function validateInterruptResponse(
  interruptId: string,
  value: unknown,
  jsonSchema: unknown,
): void {
  const validator = compileJsonSchema(jsonSchema);
  if (!validator) {
    return;
  }
  const result = validator.safeParse(value);
  if (result.success) {
    return;
  }
  const issues = result.error.issues
    .map((issue) => {
      const at = issue.path.length ? ` at '${issue.path.join('.')}'` : '';
      return `${issue.message}${at}`;
    })
    .join('; ');
  throw new Error(
    `The reply to interrupt '${interruptId}' does not match the ` +
      `responseSchema it declared: ${issues}. A structured reply must either ` +
      `match that schema, or wrap a bare value as {result: <value>}; a ` +
      `plain-text reply is accepted as-is and is not checked.`,
  );
}

/** Returns whether an event contains a `request_input` function call. */
export function hasRequestInputFunctionCall(event: Event): boolean {
  return (event.content?.parts ?? []).some(
    (p) => p.functionCall?.name === REQUEST_INPUT_FUNCTION_CALL_NAME,
  );
}

/** Returns whether an event contains an `adk_request_credential` function call. */
export function hasAuthRequestFunctionCall(event: Event): boolean {
  return (event.content?.parts ?? []).some(
    (p) => p.functionCall?.name === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  );
}

/** Extracts interrupt ids from `request_input` function calls in an event. */
export function getRequestInputInterruptIds(event: Event): string[] {
  const ids: string[] = [];
  for (const part of event.content?.parts ?? []) {
    const fc = part.functionCall;
    if (fc && fc.name === REQUEST_INPUT_FUNCTION_CALL_NAME && fc.id) {
      ids.push(fc.id);
    }
  }
  return ids;
}

/**
 * Creates a `FunctionResponse` part answering a `request_input` interrupt,
 * suitable for appending to a session as the user's resume response.
 */
export function createRequestInputResponse(
  interruptId: string,
  response: Record<string, unknown>,
): Part {
  return {
    functionResponse: {
      id: interruptId,
      name: REQUEST_INPUT_FUNCTION_CALL_NAME,
      response,
    },
  };
}

// ---------------------------------------------------------------------------
// Auth-credential utilities (auth gate)
// ---------------------------------------------------------------------------

/** Whether a credential for the given auth config already exists in state. */
export function hasAuthCredential(
  authConfig: AuthConfig,
  state: State,
): boolean {
  return new AuthHandler(authConfig).getAuthResponse(state) !== undefined;
}

/**
 * Creates an event requesting user authentication credentials
 * (`adk_request_credential`), marking the interrupt id as a long-running tool.
 *
 * Ported from `google/adk-python` `create_auth_request_event`.
 */
export function createAuthRequestEvent(
  authConfig: AuthConfig,
  interruptId: string,
): Event {
  const authRequest = new AuthHandler(authConfig).generateAuthRequest();
  const args: Record<string, unknown> = {
    functionCallId: interruptId,
    authConfig: authRequest,
    message: buildAuthMessage(authConfig),
  };
  return createEvent({
    content: {
      role: 'model',
      parts: [
        {
          functionCall: {
            name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
            id: interruptId,
            args,
          },
        },
      ],
    },
    longRunningToolIds: [interruptId],
  });
}

/** Parameters for {@link processAuthResume}. */
export interface ProcessAuthResumeParams {
  /** The resume response: a full {@link AuthConfig} or a plain value. */
  responseData: unknown;
  /** The auth config the credential is being stored for. */
  authConfig: AuthConfig;
  /** The session state to store the credential in. */
  state: State;
}

/**
 * Stores credentials from an auth resume response into session state. Accepts a
 * full {@link AuthConfig} (web UI flow) or a plain value (e.g. an API key
 * string), mirroring `google/adk-python` `process_auth_resume`.
 */
export async function processAuthResume({
  responseData,
  authConfig,
  state,
}: ProcessAuthResumeParams): Promise<void> {
  let responseConfig: AuthConfig;
  if (isAuthConfigLike(responseData)) {
    responseConfig = {
      ...(responseData as AuthConfig),
      credentialKey: authConfig.credentialKey,
    };
  } else {
    responseConfig = {
      ...authConfig,
      exchangedAuthCredential: buildCredentialFromValue(
        authConfig,
        responseData,
      ),
    };
  }
  await new AuthHandler(responseConfig).parseAndStoreAuthResponse(state);
}

function isAuthConfigLike(value: unknown): value is AuthConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    'authScheme' in value &&
    'credentialKey' in value
  );
}

function buildCredentialFromValue(
  authConfig: AuthConfig,
  value: unknown,
): AuthCredential {
  if (authConfig.rawAuthCredential?.authType === AuthCredentialTypes.API_KEY) {
    return {authType: AuthCredentialTypes.API_KEY, apiKey: String(value)};
  }
  return value as AuthCredential;
}

function buildAuthMessage(authConfig: AuthConfig): string {
  const authType = authConfig.rawAuthCredential?.authType;
  if (authType === AuthCredentialTypes.API_KEY) {
    return 'Please provide your API key.';
  }
  if (
    authType === AuthCredentialTypes.OAUTH2 ||
    authType === AuthCredentialTypes.OPEN_ID_CONNECT
  ) {
    return 'Please complete the authentication flow.';
  }
  return 'Please provide your authentication credentials.';
}
