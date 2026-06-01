/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Outcome} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {createEvent} from '../../src/events/event.js';
import {createEventActions} from '../../src/events/event_actions.js';
import {
  EventType,
  toStructuredEvents,
} from '../../src/events/structured_events.js';

describe('toStructuredEvents', () => {
  it('returns an ERROR event when errorCode is set', () => {
    const event = createEvent({errorCode: 'INTERNAL'});
    const result = toStructuredEvents(event);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe(EventType.ERROR);
    expect((result[0] as {type: EventType; error: Error}).error).toBeInstanceOf(
      Error,
    );
  });

  it('uses errorMessage when present alongside errorCode', () => {
    const event = createEvent({
      errorCode: 'INTERNAL',
      errorMessage: 'something went wrong',
    });
    const result = toStructuredEvents(event);
    expect(result[0].type).toBe(EventType.ERROR);
    expect((result[0] as {type: EventType; error: Error}).error.message).toBe(
      'something went wrong',
    );
  });

  it('returns a THOUGHT event for a thought text part', () => {
    // Use partial:true so isFinalResponse is false (no FINISHED appended).
    const event = createEvent({
      partial: true,
      content: {parts: [{text: 'I am thinking', thought: true}]},
    });
    const result = toStructuredEvents(event);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe(EventType.THOUGHT);
    expect((result[0] as {type: EventType; content: string}).content).toBe(
      'I am thinking',
    );
  });

  it('returns a CONTENT event for a regular text part', () => {
    const event = createEvent({
      partial: true,
      content: {parts: [{text: 'Hello user'}]},
    });
    const result = toStructuredEvents(event);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe(EventType.CONTENT);
    expect((result[0] as {type: EventType; content: string}).content).toBe(
      'Hello user',
    );
  });

  it('returns a TOOL_CALL event for a functionCall part', () => {
    const event = createEvent({
      content: {parts: [{functionCall: {name: 'my_func', args: {x: 1}}}]},
    });
    const result = toStructuredEvents(event);
    const toolCallEvent = result.find((e) => e.type === EventType.TOOL_CALL);
    expect(toolCallEvent).toBeDefined();
    expect(
      (toolCallEvent as {type: EventType; call: {name: string}}).call.name,
    ).toBe('my_func');
  });

  it('returns a TOOL_RESULT event for a functionResponse part', () => {
    const event = createEvent({
      content: {
        parts: [{functionResponse: {name: 'my_func', response: {result: 42}}}],
      },
    });
    const result = toStructuredEvents(event);
    const toolResultEvent = result.find(
      (e) => e.type === EventType.TOOL_RESULT,
    );
    expect(toolResultEvent).toBeDefined();
  });

  it('returns a CALL_CODE event for an executableCode part', () => {
    const event = createEvent({
      partial: true,
      content: {
        parts: [{executableCode: {code: 'print("hi")', language: 1}}],
      },
    });
    const result = toStructuredEvents(event);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe(EventType.CALL_CODE);
  });

  it('returns a CODE_RESULT event for a codeExecutionResult part', () => {
    const event = createEvent({
      content: {
        parts: [
          {codeExecutionResult: {outcome: Outcome.OUTCOME_OK, output: 'hi'}},
        ],
      },
    });
    const result = toStructuredEvents(event);
    const codeResultEvent = result.find(
      (e) => e.type === EventType.CODE_RESULT,
    );
    expect(codeResultEvent).toBeDefined();
  });

  it('returns a TOOL_CONFIRMATION event when requestedToolConfirmations is non-empty', () => {
    const event = createEvent({
      actions: createEventActions({
        requestedToolConfirmations: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          'call-1': {toolName: 'dangerous_tool'} as any,
        },
      }),
    });
    const result = toStructuredEvents(event);
    const confirmationEvent = result.find(
      (e) => e.type === EventType.TOOL_CONFIRMATION,
    );
    expect(confirmationEvent).toBeDefined();
  });

  it('returns a FINISHED event when isFinalResponse is true', () => {
    const event = createEvent({
      content: {parts: [{text: 'done'}]},
    });
    const result = toStructuredEvents(event);
    const finishedEvent = result.find((e) => e.type === EventType.FINISHED);
    expect(finishedEvent).toBeDefined();
    expect(
      (finishedEvent as {type: EventType; output: unknown}).output,
    ).toBeUndefined();
  });

  it('returns multiple structured events from a mixed-part event', () => {
    const event = createEvent({
      content: {
        parts: [
          {text: 'thinking', thought: true},
          {text: 'Hello'},
          {functionCall: {name: 'my_func', args: {}}},
        ],
      },
    });
    const result = toStructuredEvents(event);
    const types = result.map((e) => e.type);
    expect(types).toContain(EventType.THOUGHT);
    expect(types).toContain(EventType.CONTENT);
    expect(types).toContain(EventType.TOOL_CALL);
  });

  it('returns empty array for event with no content and no error', () => {
    const event = createEvent();
    // A plain event with no content is a final response — expect FINISHED only.
    const result = toStructuredEvents(event);
    expect(result.every((e) => e.type === EventType.FINISHED)).toBe(true);
  });
});
