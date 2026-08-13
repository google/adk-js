/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEventActions,
  functionsExportedForTestingOnly,
  InvocationContext,
  LlmAgent,
  PluginManager,
  Session,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  getPendingUserInputRequests,
  getUserInputRequests,
  requiresUserInput,
} from '../../src/agents/user_input_request.js';
import {AuthConfig} from '../../src/auth/auth_tool.js';
import {createEvent, Event} from '../../src/events/event.js';

/** An `adk_request_input` interrupt, as raised by a workflow `RequestInput`. */
function requestInputEvent(
  interruptId: string,
  args: Record<string, unknown> = {},
): Event {
  return createEvent({
    author: 'step1',
    content: {
      role: 'model',
      parts: [
        {
          functionCall: {
            name: 'adk_request_input',
            id: interruptId,
            args: {interruptId, message: 'Enter a number:', ...args},
          },
        },
      ],
    },
    longRunningToolIds: [interruptId],
  });
}

/** The user's reply to an interrupt, as recorded on resume. */
function responseEvent(interruptId: string, name: string): Event {
  return createEvent({
    author: 'user',
    content: {
      role: 'user',
      parts: [
        {functionResponse: {id: interruptId, name, response: {result: 21}}},
      ],
    },
  });
}

describe('getUserInputRequests', () => {
  it('summarizes a request for input', () => {
    const [request] = getUserInputRequests(
      requestInputEvent('i1', {
        payload: {draft: 'hello'},
        response_schema: {type: 'object'},
      }),
    );

    expect(request).toEqual({
      kind: 'input',
      interruptId: 'i1',
      functionCallName: 'adk_request_input',
      author: 'step1',
      message: 'Enter a number:',
      payload: {draft: 'hello'},
      responseSchema: {type: 'object'},
    });
  });

  it('summarizes a request for a credential', () => {
    const authConfig = {
      authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'},
      credentialKey: 'weather_api_key',
    };
    const event = createEvent({
      author: 'fetch_weather',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'adk_request_credential',
              id: 'weather_api_key',
              args: {
                functionCallId: 'weather_api_key',
                authConfig,
                message: 'Please provide your API key.',
              },
            },
          },
        ],
      },
    });

    const [request] = getUserInputRequests(event);

    expect(request.kind).toBe('credential');
    expect(request.interruptId).toBe('weather_api_key');
    expect(request.message).toBe('Please provide your API key.');
    expect(request.authConfig).toEqual(authConfig);
  });

  it('summarizes a credential request raised by the agent auth flow', () => {
    // The agent/tool flow writes snake_case args and no message, unlike the
    // workflow flow above; build it with the real producer so the two
    // encodings cannot drift apart from this test.
    const authConfig = {
      authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'},
      credentialKey: 'weather_api_key',
    } as unknown as AuthConfig;
    const functionResponseEvent = createEvent({
      actions: createEventActions({
        requestedAuthConfigs: {'call_1': authConfig},
      }),
      content: {role: 'model', parts: []},
    });
    const event = functionsExportedForTestingOnly.generateAuthEvent(
      new InvocationContext({
        invocationId: 'inv_123',
        session: {} as Session,
        agent: new LlmAgent({name: 'fetch_weather', model: 'test_model'}),
        pluginManager: new PluginManager(),
      }),
      functionResponseEvent,
    )!;

    const [request] = getUserInputRequests(event);

    expect(request.kind).toBe('credential');
    expect(request.author).toBe('fetch_weather');
    expect(request.interruptId).toBe(
      event.content!.parts![0].functionCall!.id!,
    );
    expect(request.authConfig).toEqual(authConfig);
  });

  it('summarizes a tool-confirmation request, exposing the hint as the message', () => {
    const event = createEvent({
      author: 'generate_instruction',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'adk_request_confirmation',
              id: 'confirm-1',
              args: {
                originalFunctionCall: {name: 'find_orders', args: {}},
                toolConfirmation: {
                  hint: 'This reads patient records.',
                  confirmed: false,
                },
              },
            },
          },
        ],
      },
    });

    const [request] = getUserInputRequests(event);

    expect(request.kind).toBe('confirmation');
    expect(request.toolName).toBe('find_orders');
    expect(request.message).toBe('This reads patient records.');
  });

  it('falls back to the args id when the function call has none', () => {
    const event = createEvent({
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'adk_request_input',
              args: {interruptId: 'from-args'},
            },
          },
        ],
      },
    });

    expect(getUserInputRequests(event)[0].interruptId).toBe('from-args');
  });

  it('reports every request when one event raises several', () => {
    const event = createEvent({
      content: {
        role: 'model',
        parts: [
          {functionCall: {name: 'adk_request_input', id: 'a', args: {}}},
          {functionCall: {name: 'adk_request_input', id: 'b', args: {}}},
        ],
      },
    });

    expect(getUserInputRequests(event).map((r) => r.interruptId)).toEqual([
      'a',
      'b',
    ]);
  });

  it('ignores ordinary tool calls and plain text', () => {
    const event = createEvent({
      author: 'agent',
      content: {
        role: 'model',
        parts: [
          {text: 'Looking that up.'},
          {functionCall: {name: 'get_weather', id: 'c1', args: {city: 'SF'}}},
        ],
      },
    });

    expect(getUserInputRequests(event)).toEqual([]);
    expect(requiresUserInput(event)).toBe(false);
  });

  it('ignores an interrupt-shaped call with no id to answer', () => {
    const event = createEvent({
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'adk_request_input', args: {}}}],
      },
    });

    expect(getUserInputRequests(event)).toEqual([]);
  });

  it('tolerates an event with no content', () => {
    expect(getUserInputRequests(createEvent({author: 'a'}))).toEqual([]);
    expect(requiresUserInput(createEvent({author: 'a'}))).toBe(false);
  });
});

describe('requiresUserInput', () => {
  it('is true for an event that asks for something', () => {
    expect(requiresUserInput(requestInputEvent('i1'))).toBe(true);
  });
});

describe('getPendingUserInputRequests', () => {
  it('returns a request that has not been answered', () => {
    const pending = getPendingUserInputRequests([requestInputEvent('i1')]);

    expect(pending.map((r) => r.interruptId)).toEqual(['i1']);
  });

  it('drops a request once a matching function response arrives', () => {
    const pending = getPendingUserInputRequests([
      requestInputEvent('i1'),
      responseEvent('i1', 'adk_request_input'),
    ]);

    expect(pending).toEqual([]);
  });

  it('keeps unanswered requests when only one of several is answered', () => {
    const pending = getPendingUserInputRequests([
      requestInputEvent('i1'),
      requestInputEvent('i2'),
      responseEvent('i1', 'adk_request_input'),
    ]);

    expect(pending.map((r) => r.interruptId)).toEqual(['i2']);
  });

  it('reports a re-raised interrupt id only once', () => {
    // A `rerunOnResume` node re-raises the same id on every attempt, but the
    // user still owes exactly one answer.
    const pending = getPendingUserInputRequests([
      requestInputEvent('i1'),
      requestInputEvent('i1'),
    ]);

    expect(pending.map((r) => r.interruptId)).toEqual(['i1']);
  });

  it('preserves the order requests were raised in', () => {
    const pending = getPendingUserInputRequests([
      requestInputEvent('first'),
      requestInputEvent('second'),
    ]);

    expect(pending.map((r) => r.interruptId)).toEqual(['first', 'second']);
  });

  it('returns nothing for a session with no interrupts', () => {
    const event = createEvent({
      author: 'agent',
      content: {role: 'model', parts: [{text: 'all done'}]},
    });

    expect(getPendingUserInputRequests([event])).toEqual([]);
  });
});
