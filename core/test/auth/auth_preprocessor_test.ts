/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event, createEvent} from '@google/adk';
import {Mock, describe, expect, it, vi} from 'vitest';
import {REQUEST_EUC_FUNCTION_CALL_NAME} from '../../src/agents/functions.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {AUTH_PREPROCESSOR} from '../../src/auth/auth_preprocessor.js';

vi.mock('../../src/agents/functions.js', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    handleFunctionCallsAsync: Mock;
  };
  return {
    ...actual,
    handleFunctionCallsAsync: vi.fn().mockResolvedValue({
      id: 'mockResponseEvent',
      author: 'system',
    } as Event),
  };
});

vi.mock('../../src/auth/auth_handler.js', () => ({
  AuthHandler: class {
    parseAndStoreAuthResponse = vi.fn().mockResolvedValue(undefined);
  },
}));

describe('AuthPreprocessor', () => {
  const LLM_AGENT_SYMBOL = Symbol.for('google.adk.llmAgent');

  it('skips if agent is not LlmAgent', async () => {
    const invocationContext = {
      agent: {}, // Not an LlmAgent
      session: {events: []},
    } as unknown as InvocationContext;

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });

  it('skips if no events are present', async () => {
    const invocationContext = {
      agent: {[LLM_AGENT_SYMBOL]: true},
      session: {events: []},
    } as unknown as InvocationContext;

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });

  it('skips if last event is not from user', async () => {
    const invocationContext = {
      agent: {[LLM_AGENT_SYMBOL]: true},
      session: {
        events: [
          {author: 'system', content: {parts: [{text: 'hello'}]}} as Event,
        ],
      },
    } as unknown as InvocationContext;

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });

  it('skips if no function responses for request_credential are found', async () => {
    const invocationContext = {
      agent: {[LLM_AGENT_SYMBOL]: true},
      session: {
        events: [
          {
            author: 'user',
            content: {
              parts: [{text: 'hello'}],
            },
          } as Event,
        ],
      },
    } as unknown as InvocationContext;

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(true);
  });

  it('processes adk_request_credential responses and resumes tools', async () => {
    const invocationContext = {
      agent: {
        [LLM_AGENT_SYMBOL]: true,
        canonicalTools: vi.fn().mockResolvedValue([]),
        canonicalBeforeToolCallbacks: [],
        canonicalAfterToolCallbacks: [],
      },
      session: {
        state: {},
        events: [
          createEvent({
            author: 'agent',
            content: {
              parts: [
                {
                  functionCall: {
                    id: 'toolFc1',
                    name: 'someTool',
                    args: {},
                  },
                },
              ],
            },
          }),
          createEvent({
            author: 'agent',
            id: 'originalEvent',
            content: {
              parts: [
                {
                  functionCall: {
                    id: 'fc1',
                    name: REQUEST_EUC_FUNCTION_CALL_NAME,
                    args: {
                      authConfig: {credentialKey: 'testKey'},
                      functionCallId: 'toolFc1',
                    },
                  },
                },
              ],
            },
          }),
          createEvent({
            author: 'user',
            content: {
              parts: [
                {
                  functionResponse: {
                    id: 'fc1',
                    name: REQUEST_EUC_FUNCTION_CALL_NAME,
                    response: {authType: 'apiKey', apiKey: 'test'},
                  },
                },
              ],
            },
          }),
        ],
      },
    } as unknown as InvocationContext;

    const generator = AUTH_PREPROCESSOR.runAsync(invocationContext);
    const result = await generator.next();

    expect(result.done).toBe(false);
    expect(result.value).toEqual({
      id: 'mockResponseEvent',
      author: 'system',
    });
  });
});
