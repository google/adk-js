/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {DataPart, Task, TextPart} from '@a2a-js/sdk';
import {
  Event as AdkEvent,
  ExecutorContext,
  createEvent,
  createEventActions,
} from '@google/adk';
import {Content as GenAIContent} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {
  getFinalTaskStatusUpdate,
  getTaskInputRequiredEvent,
} from '../../src/a2a/event_processor_utils.js';

import {toA2AParts} from '../../src/a2a/part_converter_utils.js';

vi.mock('../../src/utils/env_aware_utils.js', () => ({
  randomUUID: () => 'mock-uuid',
}));

describe('event_processor_utils', () => {
  describe('getFinalTaskStatusUpdate', () => {
    const mockContext = {
      requestContext: {
        taskId: 'test-task-id',
        contextId: 'test-context-id',
      },
      appName: 'test-app',
      sessionId: 'test-session',
      userId: 'test-user',
    } as ExecutorContext;

    it('returns TaskCompletedEvent for empty adkEvents', () => {
      const result = getFinalTaskStatusUpdate([], mockContext);

      expect(result.kind).toBe('status-update');
      expect(result.status?.state).toBe('completed');
      expect(result.taskId).toBe('test-task-id');
      expect(result.contextId).toBe('test-context-id');
      expect(result.metadata).toEqual(
        expect.objectContaining({
          adk_session_id: 'test-session',
          adk_app_name: 'test-app',
          adk_user_id: 'test-user',
        }),
      );
    });

    it('returns TaskFailedEvent if any adkEvent has an errorCode', () => {
      const events: AdkEvent[] = [
        createEvent({
          errorCode: 'ERROR_1',
          errorMessage: 'Something went wrong',
        }),
      ];
      const result = getFinalTaskStatusUpdate(events, mockContext);

      expect(result.kind).toBe('status-update');
      expect(result.status?.state).toBe('failed');
      const parts = result.status?.message?.parts;
      expect((parts?.[0] as TextPart)?.text).toContain('Something went wrong');
    });

    it('returns TaskFailedEvent if any adkEvent has an errorMessage', () => {
      const events: AdkEvent[] = [
        createEvent({
          errorMessage: 'Just a message',
        }),
      ];
      const result = getFinalTaskStatusUpdate(events, mockContext);

      expect(result.kind).toBe('status-update');
      expect(result.status?.state).toBe('failed');
      const parts = result.status?.message?.parts;
      expect((parts?.[0] as TextPart)?.text).toContain('Just a message');
    });

    it('merges escalate and transferToAgent from actions and returns TaskCompletedEvent', () => {
      const events: AdkEvent[] = [
        createEvent({
          actions: createEventActions({escalate: true}),
        }),
        createEvent({
          actions: createEventActions({transferToAgent: 'agent-x'}),
        }),
      ];
      const result = getFinalTaskStatusUpdate(events, mockContext);

      expect(result.kind).toBe('status-update');
      expect(result.status?.state).toBe('completed');
      expect(result.metadata).toEqual(
        expect.objectContaining({
          adk_session_id: 'test-session',
          adk_app_name: 'test-app',
          adk_user_id: 'test-user',
          'adk_escalate': true,
          'adk_transfer_to_agent': 'agent-x',
        }),
      );
    });

    it('returns TaskInputRequiredEvent if there are longRunningToolIds that match functionCall', () => {
      const events: AdkEvent[] = [
        createEvent({
          longRunningToolIds: ['call_1'],
          content: {
            parts: [{functionCall: {id: 'call_1', name: 'myFunc', args: {}}}],
          },
        }),
      ];
      const result = getFinalTaskStatusUpdate(events, mockContext);

      expect(result.kind).toBe('status-update');
      expect(result.status?.state).toBe('input-required');

      // Converted to A2AParts by toA2AParts
      const parts = result.status?.message?.parts;
      expect((parts?.[0] as DataPart)?.data?.id).toBe('call_1');
    });

    it('returns TaskInputRequiredEvent if there are longRunningToolIds that match functionResponse', () => {
      const events: AdkEvent[] = [
        createEvent({
          longRunningToolIds: ['call_2'],
          content: {
            parts: [
              {
                functionResponse: {
                  id: 'call_2',
                  name: 'myFunc',
                  response: {},
                },
              },
            ],
          },
        }),
      ];
      const result = getFinalTaskStatusUpdate(events, mockContext);

      expect(result.kind).toBe('status-update');
      expect(result.status?.state).toBe('input-required');

      const parts = result.status?.message?.parts;
      expect((parts?.[0] as DataPart)?.data?.id).toBe('call_2');
    });

    it('does not duplicate required inputs for the same functionCall id', () => {
      const events: AdkEvent[] = [
        createEvent({
          longRunningToolIds: ['call_1'],
          content: {
            parts: [{functionCall: {id: 'call_1', name: 'myFunc1'}}],
          },
        }),
        createEvent({
          content: {
            parts: [{functionCall: {id: 'call_1', name: 'myFunc1'}}],
          },
        }),
      ];
      const result = getFinalTaskStatusUpdate(events, mockContext);

      expect(result.kind).toBe('status-update');
      expect(result.status?.state).toBe('input-required');
      const parts = result.status?.message?.parts;
      expect(parts?.length).toBe(1);
      expect((parts?.[0] as DataPart)?.data?.id).toBe('call_1');
    });
  });

  describe('getTaskInputRequiredEvent', () => {
    it('returns undefined if task is falsy', () => {
      expect(
        getTaskInputRequiredEvent(null as unknown as Task, {} as GenAIContent),
      ).toBeUndefined();
    });

    it('returns undefined if task is not input required', () => {
      const task = {
        kind: 'task',
        status: {state: 'working'},
      } as Task;
      expect(
        getTaskInputRequiredEvent(task, {} as GenAIContent),
      ).toBeUndefined();
    });

    it('returns undefined if task does not have a status message', () => {
      const task = {
        kind: 'task',
        status: {state: 'input-required'},
      } as Task;
      expect(
        getTaskInputRequiredEvent(task, {} as GenAIContent),
      ).toBeUndefined();
    });

    it('returns undefined if matching response exists in genAIContent', () => {
      const taskParts = toA2AParts([
        {functionCall: {id: 'call_1', name: 'myFunc', args: {}}},
      ]);
      const task = {
        id: 't1',
        contextId: 'c1',
        kind: 'task',
        status: {
          state: 'input-required',
          message: {
            parts: taskParts,
          },
        },
      } as Task;
      const genAIContent = {
        parts: [
          {functionResponse: {id: 'call_1', name: 'myFunc', response: {}}},
        ],
      } as GenAIContent;

      expect(getTaskInputRequiredEvent(task, genAIContent)).toBeUndefined();
    });

    it('returns Error event if matching response does NOT exist in genAIContent', () => {
      const taskParts = toA2AParts([
        {functionCall: {id: 'call_1', name: 'myFunc', args: {}}},
      ]);
      const task = {
        id: 'taskId1',
        contextId: 'contextId1',
        kind: 'task',
        status: {
          state: 'input-required',
          message: {
            parts: taskParts,
          },
        },
      } as Task;
      const genAIContent = {
        parts: [{text: 'I can not do that.'}],
      } as GenAIContent;

      const result = getTaskInputRequiredEvent(task, genAIContent);
      expect(result).toBeDefined();
      expect(result!.kind).toBe('status-update');
      expect(result!.status?.state).toBe('input-required');

      const parts = result!.status?.message?.parts;
      expect(parts).toBeDefined();
      expect(parts!.length).toBe(2);
      expect((parts![0] as DataPart)?.data?.id).toBe('call_1');
      expect((parts![1] as TextPart)?.text).toContain(
        'No input provided for function call id call_1',
      );
      expect(parts![1].metadata?.validation_error).toBe(true);
    });

    it('returns undefined if status message has no functionCall parts', () => {
      const taskParts = toA2AParts([{text: 'Please answer'}]);
      const task = {
        id: 'taskId1',
        contextId: 'contextId1',
        kind: 'task',
        status: {
          state: 'input-required',
          message: {
            parts: taskParts,
          },
        },
      } as Task;
      const genAIContent = {
        parts: [{text: 'Sure!'}],
      } as GenAIContent;

      expect(getTaskInputRequiredEvent(task, genAIContent)).toBeUndefined();
    });
  });
});
