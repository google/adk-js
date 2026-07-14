/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  createEvent,
  createEventActions,
  getFunctionCalls,
  getFunctionResponses,
  hasThoughts,
  hasTrailingCodeExecutionResult,
  isFinalResponse,
  pruneThoughts,
  stringifyContent,
} from '@google/adk';
import {Outcome} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  createNewEventId,
  generateClientFunctionCallId,
  populateClientFunctionCallId,
  transformToCamelCaseEvent,
  transformToSnakeCaseEvent,
} from '../../src/events/event.js';

describe('Event Utils', () => {
  describe('createEvent', () => {
    it('creates an event with default values', () => {
      const event = createEvent();
      expect(event.id).toBeDefined();
      expect(event.id.length).toBe(8);
      expect(event.invocationId).toBe('');
      expect(event.author).toBeUndefined();
      expect(event.actions).toBeDefined();
      expect(event.longRunningToolIds).toEqual([]);
      expect(event.branch).toBeUndefined();
      expect(event.timestamp).toBeDefined();
    });

    it('creates an event with provided values', () => {
      const timestamp = Date.now();
      const event = createEvent({
        id: 'test-id',
        invocationId: 'inv-id',
        author: 'user',
        branch: 'branch',
        timestamp,
      });

      expect(event.id).toBe('test-id');
      expect(event.invocationId).toBe('inv-id');
      expect(event.author).toBe('user');
      expect(event.branch).toBe('branch');
      expect(event.timestamp).toBe(timestamp);
    });
  });

  describe('isFinalResponse', () => {
    it('returns true if skipSummarization is set', () => {
      const event = createEvent({
        actions: createEventActions({skipSummarization: true}),
      });
      expect(isFinalResponse(event)).toBe(true);
    });

    it('returns true if longRunningToolIds is present and not empty', () => {
      const event = createEvent({
        longRunningToolIds: ['tool-id'],
      });
      expect(isFinalResponse(event)).toBe(true);
    });

    it('returns true if requestedAuthConfigs is present and not empty', () => {
      const event = createEvent({
        actions: createEventActions({
          requestedAuthConfigs: {
            'tool-id': {
              credentialKey: 'testKey',
            } as unknown as AuthConfig,
          },
        }),
      });
      expect(isFinalResponse(event)).toBe(true);
    });

    it('returns false if there are function calls', () => {
      const event = createEvent({
        content: {
          parts: [{functionCall: {name: 'func', args: {}}}],
        },
      });
      expect(isFinalResponse(event)).toBe(false);
    });

    it('returns false if there are function responses', () => {
      const event = createEvent({
        content: {
          parts: [{functionResponse: {name: 'func', response: {}}}],
        },
      });
      expect(isFinalResponse(event)).toBe(false);
    });

    it('returns false if event is partial', () => {
      const event = createEvent();
      event.partial = true;
      expect(isFinalResponse(event)).toBe(false);
    });

    it('returns false if there is a trailing code execution result', () => {
      const event = createEvent({
        content: {
          parts: [{codeExecutionResult: {outcome: Outcome.OUTCOME_OK}}],
        },
      });
      expect(isFinalResponse(event)).toBe(false);
    });

    it('returns true if none of the above conditions are met', () => {
      const event = createEvent();
      expect(isFinalResponse(event)).toBe(true);
    });
  });

  describe('getFunctionCalls', () => {
    it('returns empty array if no content or parts', () => {
      const event = createEvent();
      expect(getFunctionCalls(event)).toEqual([]);
    });

    it('returns function calls from parts', () => {
      const event = createEvent({
        content: {
          parts: [
            {text: 'text'},
            {functionCall: {name: 'func1', args: {}}},
            {functionCall: {name: 'func2', args: {}}},
          ],
        },
      });
      expect(getFunctionCalls(event)).toHaveLength(2);
      expect(getFunctionCalls(event)[0].name).toBe('func1');
      expect(getFunctionCalls(event)[1].name).toBe('func2');
    });
  });

  describe('getFunctionResponses', () => {
    it('returns empty array if no content or parts', () => {
      const event = createEvent();
      expect(getFunctionResponses(event)).toEqual([]);
    });

    it('returns function responses from parts', () => {
      const event = createEvent({
        content: {
          parts: [
            {text: 'text'},
            {functionResponse: {name: 'func1', response: {}}},
            {functionResponse: {name: 'func2', response: {}}},
          ],
        },
      });
      expect(getFunctionResponses(event)).toHaveLength(2);
      expect(getFunctionResponses(event)[0].name).toBe('func1');
      expect(getFunctionResponses(event)[1].name).toBe('func2');
    });
  });

  describe('hasTrailingCodeExecutionResult', () => {
    it('returns false if no content or parts', () => {
      const event = createEvent();
      expect(hasTrailingCodeExecutionResult(event)).toBe(false);
    });

    it('returns true if last part has codeExecutionResult', () => {
      const event = createEvent({
        content: {
          parts: [
            {text: 'text'},
            {codeExecutionResult: {outcome: Outcome.OUTCOME_OK}},
          ],
        },
      });
      expect(hasTrailingCodeExecutionResult(event)).toBe(true);
    });

    it('returns false if last part does not have codeExecutionResult', () => {
      const event = createEvent({
        content: {
          parts: [
            {codeExecutionResult: {outcome: Outcome.OUTCOME_OK}},
            {text: 'text'},
          ],
        },
      });
      expect(hasTrailingCodeExecutionResult(event)).toBe(false);
    });
  });

  describe('stringifyContent', () => {
    it('returns empty string if no content or parts', () => {
      const event = createEvent();
      expect(stringifyContent(event)).toBe('');
    });

    it('concatenates text from all parts', () => {
      const event = createEvent({
        content: {
          parts: [{text: 'Hello'}, {text: ' '}, {text: 'World'}],
        },
      });
      expect(stringifyContent(event)).toBe('Hello World');
    });

    it('ignores parts without text', () => {
      const event = createEvent({
        content: {
          parts: [
            {text: 'Hello'},
            {functionCall: {name: 'foo', args: {}}},
            {text: 'World'},
          ],
        },
      });
      expect(stringifyContent(event)).toBe('HelloWorld');
    });

    it('ignores parts marked as thought', () => {
      const event = createEvent({
        content: {
          parts: [
            {text: 'reasoning about the user request', thought: true},
            {text: 'Hello'},
            {text: 'World'},
          ],
        },
      });
      expect(stringifyContent(event)).toBe('HelloWorld');
    });

    it('returns empty string when all parts are thoughts', () => {
      const event = createEvent({
        content: {
          parts: [
            {text: 'first thought', thought: true},
            {text: 'second thought', thought: true},
          ],
        },
      });
      expect(stringifyContent(event)).toBe('');
    });
  });

  describe('hasThoughts', () => {
    it('returns false if no content or parts', () => {
      const event = createEvent();
      expect(hasThoughts(event)).toBe(false);
    });

    it('returns true if any part has thought === true', () => {
      const event = createEvent({
        content: {
          parts: [{text: 'hello'}, {text: 'thinking...', thought: true}],
        },
      });
      expect(hasThoughts(event)).toBe(true);
    });

    it('returns false if no part has thought === true', () => {
      const event = createEvent({
        content: {
          parts: [{text: 'hello'}, {text: 'world'}],
        },
      });
      expect(hasThoughts(event)).toBe(false);
    });
  });

  describe('pruneThoughts', () => {
    it('returns event unchanged if no content or parts', () => {
      const event = createEvent();
      expect(pruneThoughts(event)).toEqual(event);
    });

    it('removes parts with thought === true', () => {
      const event = createEvent({
        content: {
          parts: [
            {text: 'thinking...', thought: true},
            {text: 'hello'},
            {text: 'more thoughts', thought: true},
            {text: 'world'},
          ],
        },
      });
      const pruned = pruneThoughts(event);
      expect(pruned.content!.parts).toEqual([{text: 'hello'}, {text: 'world'}]);
    });
  });

  describe('createNewEventId', () => {
    it('generates an 8-character string', () => {
      const id = createNewEventId();
      expect(id).toHaveLength(8);
      expect(typeof id).toBe('string');
    });
  });

  describe('transformToCamelCaseEvent', () => {
    it('transforms snake_case event to camelCase', () => {
      const snakeEvent = {
        id: '123',
        invocation_id: 'inv1',
        actions: {
          state_delta: {some_key: 'value'},
        },
      };
      const camelEvent = transformToCamelCaseEvent(snakeEvent);
      expect(camelEvent.id).toBe('123');
      expect(camelEvent.invocationId).toBe('inv1');
      expect(camelEvent.actions?.stateDelta).toEqual({some_key: 'value'});
    });

    it('preserves customMetadata keys during conversion to camelCase', () => {
      const snakeEvent = {
        id: '123',
        invocation_id: 'inv1',
        custom_metadata: {
          'preserve-my-key': 'value',
          NestedKey: 'value2',
        },
      };
      const camelEvent = transformToCamelCaseEvent(snakeEvent);
      expect(camelEvent.customMetadata).toEqual({
        'preserve-my-key': 'value',
        NestedKey: 'value2',
      });
    });
  });

  describe('transformToSnakeCaseEvent', () => {
    it('transforms camelCase event to snake_case', () => {
      const camelEvent = createEvent({
        id: '123',
        invocationId: 'inv1',
        actions: createEventActions({
          stateDelta: {someKey: 'value'},
        }),
      });
      const snakeEvent = transformToSnakeCaseEvent(camelEvent);
      expect(snakeEvent.id).toBe('123');
      expect(snakeEvent.invocation_id).toBe('inv1');
      expect(
        (snakeEvent.actions as Record<string, unknown>).state_delta,
      ).toEqual({someKey: 'value'});
    });

    it('preserves customMetadata keys during conversion to snake_case', () => {
      const camelEvent = createEvent({
        id: '123',
        invocationId: 'inv1',
        customMetadata: {
          'preserve-my-key': 'value',
          NestedKey: 'value2',
        },
      });
      const snakeEvent = transformToSnakeCaseEvent(camelEvent);
      expect(snakeEvent.custom_metadata).toEqual({
        'preserve-my-key': 'value',
        NestedKey: 'value2',
      });
    });
  });

  describe('generateClientFunctionCallId', () => {
    it('should generate a valid ID with prefix', () => {
      const id = generateClientFunctionCallId();
      expect(id).toMatch(/^adk-/);
    });
  });

  describe('populateClientFunctionCallId', () => {
    it('should populate ID if missing', () => {
      const event = createEvent({
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'testTool', args: {}}}],
        },
      });
      populateClientFunctionCallId(event);
      expect(event.content!.parts![0].functionCall!.id).toBeDefined();
      expect(event.content!.parts![0].functionCall!.id).toMatch(/^adk-/);
    });

    it('should not overwrite existing ID', () => {
      const event = createEvent({
        content: {
          role: 'model',
          parts: [
            {functionCall: {name: 'testTool', args: {}, id: 'existing-id'}},
          ],
        },
      });
      populateClientFunctionCallId(event);
      expect(event.content!.parts![0].functionCall!.id).toBe('existing-id');
    });

    it('should handle event with no function calls', () => {
      const event = createEvent({
        content: {
          role: 'model',
          parts: [{text: 'hello'}],
        },
      });
      populateClientFunctionCallId(event);
      expect(event.content!.parts![0].text).toBe('hello');
    });
  });
});
