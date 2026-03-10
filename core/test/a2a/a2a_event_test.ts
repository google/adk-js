/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {
  createInputMissingErrorEvent,
  createTask,
  createTaskArtifactUpdateEvent,
  createTaskCompletedEvent,
  createTaskFailedEvent,
  createTaskInputRequiredEvent,
  createTaskSubmittedEvent,
  createTaskWorkingEvent,
  getEventMetadata,
  getFailedTaskStatusUpdateEventError,
  isFailedTaskStatusUpdateEvent,
  isInputRequiredTaskStatusUpdateEvent,
  isMessage,
  isTask,
  isTaskArtifactUpdateEvent,
  isTaskStatusUpdateEvent,
  isTerminalTaskStatusUpdateEvent,
} from '../../src/a2a/a2a_event.js';

vi.mock('../../src/utils/env_aware_utils.js', () => ({
  randomUUID: () => 'mock-uuid',
}));

describe('a2a_event', () => {
  describe('type guards', () => {
    it('isTaskStatusUpdateEvent', () => {
      expect(isTaskStatusUpdateEvent({kind: 'status-update'})).toBe(true);
      expect(isTaskStatusUpdateEvent({kind: 'other'})).toBe(false);
      expect(isTaskStatusUpdateEvent(null)).toBe(false);
    });

    it('isTaskArtifactUpdateEvent', () => {
      expect(isTaskArtifactUpdateEvent({kind: 'artifact-update'})).toBe(true);
      expect(isTaskArtifactUpdateEvent({kind: 'other'})).toBe(false);
      expect(isTaskArtifactUpdateEvent(null)).toBe(false);
    });

    it('isMessage', () => {
      expect(isMessage({kind: 'message'})).toBe(true);
      expect(isMessage({kind: 'other'})).toBe(false);
      expect(isMessage(null)).toBe(false);
    });

    it('isTask', () => {
      expect(isTask({kind: 'task'})).toBe(true);
      expect(isTask({kind: 'other'})).toBe(false);
      expect(isTask(null)).toBe(false);
    });

    it('isFailedTaskStatusUpdateEvent', () => {
      expect(
        isFailedTaskStatusUpdateEvent({
          kind: 'status-update',
          status: {state: 'failed'},
        }),
      ).toBe(true);
      expect(
        isFailedTaskStatusUpdateEvent({
          kind: 'task',
          status: {state: 'failed'},
        }),
      ).toBe(true);
      expect(
        isFailedTaskStatusUpdateEvent({
          kind: 'status-update',
          status: {state: 'completed'},
        }),
      ).toBe(false);
      expect(isFailedTaskStatusUpdateEvent({kind: 'other'})).toBe(false);
    });

    it('isTerminalTaskStatusUpdateEvent', () => {
      expect(
        isTerminalTaskStatusUpdateEvent({
          kind: 'status-update',
          status: {state: 'completed'},
        }),
      ).toBe(true);
      expect(
        isTerminalTaskStatusUpdateEvent({
          kind: 'task',
          status: {state: 'completed'},
        }),
      ).toBe(true);
      expect(
        isTerminalTaskStatusUpdateEvent({
          kind: 'status-update',
          status: {state: 'failed'},
        }),
      ).toBe(true);
      expect(
        isTerminalTaskStatusUpdateEvent({
          kind: 'status-update',
          status: {state: 'canceled'},
        }),
      ).toBe(true);
      expect(
        isTerminalTaskStatusUpdateEvent({
          kind: 'status-update',
          status: {state: 'rejected'},
        }),
      ).toBe(true);
      expect(
        isTerminalTaskStatusUpdateEvent({
          kind: 'status-update',
          status: {state: 'working'},
        }),
      ).toBe(false);
    });

    it('isInputRequiredTaskStatusUpdateEvent', () => {
      expect(
        isInputRequiredTaskStatusUpdateEvent({
          kind: 'status-update',
          status: {state: 'input-required'},
        }),
      ).toBe(true);
      expect(
        isInputRequiredTaskStatusUpdateEvent({
          kind: 'task',
          status: {state: 'input-required'},
        }),
      ).toBe(true);
      expect(
        isInputRequiredTaskStatusUpdateEvent({
          kind: 'status-update',
          status: {state: 'working'},
        }),
      ).toBe(false);
    });
  });

  describe('getEventMetadata', () => {
    it('returns metadata for artifact-update', () => {
      const event: TaskArtifactUpdateEvent = {
        kind: 'artifact-update',
        taskId: 't1',
        contextId: 'c1',
        artifact: {
          artifactId: 'a1',
          parts: [],
          metadata: {foo: 'bar'},
        },
      };
      expect(getEventMetadata(event)).toEqual({foo: 'bar'});
    });

    it('returns empty object if artifact metadata is missing', () => {
      const event = {
        kind: 'artifact-update',
        artifact: {},
      } as unknown as TaskArtifactUpdateEvent;
      expect(getEventMetadata(event)).toEqual({});
    });

    it('returns metadata for status-update', () => {
      const event: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId: 't1',
        contextId: 'c1',
        status: {state: 'working'},
        metadata: {bar: 'baz'},
        final: false,
      };
      expect(getEventMetadata(event)).toEqual({bar: 'baz'});
    });

    it('returns metadata for task', () => {
      const event = {
        kind: 'task',
        taskId: 't1',
        contextId: 'c1',
        status: {state: 'working'},
        metadata: {bar: 'baz'},
      } as unknown as Task;
      expect(getEventMetadata(event)).toEqual({bar: 'baz'});
    });

    it('returns metadata for message', () => {
      const event: Message = {
        kind: 'message',
        messageId: 'm1',
        role: 'user',
        parts: [],
        taskId: 't1',
        contextId: 'c1',
        metadata: {bar: 'baz'},
      };
      expect(getEventMetadata(event)).toEqual({bar: 'baz'});
    });

    it('returns empty object if metadata is missing', () => {
      const event = {
        kind: 'status-update',
        status: {state: 'working'},
      } as unknown as TaskStatusUpdateEvent;
      expect(getEventMetadata(event)).toEqual({});
    });

    it('returns empty object for unknown event type', () => {
      const event = {kind: 'unknown'} as unknown as TaskStatusUpdateEvent;
      expect(getEventMetadata(event)).toEqual({});
    });
  });

  describe('getFailedTaskStatusUpdateEventError', () => {
    it('returns undefined if not failed task status update', () => {
      expect(
        getFailedTaskStatusUpdateEventError({
          kind: 'status-update',
          status: {state: 'working'},
        } as unknown as TaskStatusUpdateEvent),
      ).toBeUndefined();
    });

    it('returns undefined if no parts', () => {
      expect(
        getFailedTaskStatusUpdateEventError({
          kind: 'status-update',
          status: {state: 'failed', message: {parts: []}},
        } as unknown as TaskStatusUpdateEvent),
      ).toBeUndefined();
    });

    it('returns undefined if first part is not text', () => {
      expect(
        getFailedTaskStatusUpdateEventError({
          kind: 'status-update',
          status: {state: 'failed', message: {parts: [{kind: 'code'}]}},
        } as unknown as TaskStatusUpdateEvent),
      ).toBeUndefined();
    });

    it('returns text of first part', () => {
      expect(
        getFailedTaskStatusUpdateEventError({
          kind: 'status-update',
          status: {
            state: 'failed',
            message: {parts: [{kind: 'text', text: 'error msg'}]},
          },
        } as unknown as TaskStatusUpdateEvent),
      ).toEqual('error msg');
    });

    it('returns text of first part for Task', () => {
      expect(
        getFailedTaskStatusUpdateEventError({
          kind: 'task',
          status: {
            state: 'failed',
            message: {parts: [{kind: 'text', text: 'error msg'}]},
          },
        } as unknown as Task),
      ).toEqual('error msg');
    });
  });

  describe('event creators', () => {
    beforeAll(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    const message: Message = {
      kind: 'message',
      messageId: 'm1',
      role: 'user',
      parts: [],
      taskId: 't1',
      contextId: 'c1',
    };

    it('createTaskSubmittedEvent', () => {
      expect(
        createTaskSubmittedEvent({taskId: 't1', contextId: 'c1', message}),
      ).toEqual({
        kind: 'status-update',
        taskId: 't1',
        contextId: 'c1',
        final: false,
        status: {
          state: 'submitted',
          message,
          timestamp: '2024-01-01T00:00:00.000Z',
        },
      });
    });

    it('createTaskWorkingEvent', () => {
      expect(
        createTaskWorkingEvent({taskId: 't1', contextId: 'c1', message}),
      ).toEqual({
        kind: 'status-update',
        taskId: 't1',
        contextId: 'c1',
        final: false,
        status: {
          state: 'working',
          message,
          timestamp: '2024-01-01T00:00:00.000Z',
        },
      });
    });

    it('createTaskWorkingEvent without message', () => {
      expect(createTaskWorkingEvent({taskId: 't1', contextId: 'c1'})).toEqual({
        kind: 'status-update',
        taskId: 't1',
        contextId: 'c1',
        final: false,
        status: {
          state: 'working',
          message: undefined,
          timestamp: '2024-01-01T00:00:00.000Z',
        },
      });
    });

    it('createTask', () => {
      expect(createTask({taskId: 't1', contextId: 'c1', message})).toEqual({
        kind: 'task',
        id: 't1',
        contextId: 'c1',
        history: [message],
        status: {
          state: 'submitted',
          timestamp: '2024-01-01T00:00:00.000Z',
        },
      });
    });

    it('createTask with random UUID if taskId not provided', () => {
      expect(
        createTask({
          taskId: '',
          contextId: 'c1',
          message,
          metadata: {foo: 'bar'},
        }),
      ).toEqual({
        kind: 'task',
        id: 'mock-uuid',
        contextId: 'c1',
        history: [message],
        status: {
          state: 'submitted',
          timestamp: '2024-01-01T00:00:00.000Z',
        },
        metadata: {foo: 'bar'},
      });
    });

    it('createTaskCompletedEvent', () => {
      expect(createTaskCompletedEvent({taskId: 't1', contextId: 'c1'})).toEqual(
        {
          kind: 'status-update',
          taskId: 't1',
          contextId: 'c1',
          final: true,
          status: {
            state: 'completed',
            timestamp: '2024-01-01T00:00:00.000Z',
          },
          metadata: undefined,
        },
      );
    });

    it('createTaskArtifactUpdateEvent', () => {
      expect(
        createTaskArtifactUpdateEvent({
          taskId: 't1',
          contextId: 'c1',
          parts: [{kind: 'text', text: 'part'}],
          metadata: {m: 1},
          append: true,
          lastChunk: false,
        }),
      ).toEqual({
        kind: 'artifact-update',
        taskId: 't1',
        contextId: 'c1',
        append: true,
        lastChunk: false,
        artifact: {
          artifactId: 'mock-uuid',
          parts: [{kind: 'text', text: 'part'}],
        },
        metadata: {m: 1},
      });
    });

    it('createTaskArtifactUpdateEvent with explicit artifactId', () => {
      expect(
        createTaskArtifactUpdateEvent({
          taskId: 't1',
          contextId: 'c1',
          artifactId: 'custom-id',
        }),
      ).toEqual({
        kind: 'artifact-update',
        taskId: 't1',
        contextId: 'c1',
        append: undefined,
        lastChunk: undefined,
        artifact: {
          artifactId: 'custom-id',
          parts: [],
          metadata: undefined,
        },
      });
    });

    it('createTaskFailedEvent', () => {
      expect(
        createTaskFailedEvent({
          taskId: 't1',
          contextId: 'c1',
          error: new Error('test error'),
        }),
      ).toEqual({
        kind: 'status-update',
        taskId: 't1',
        contextId: 'c1',
        final: true,
        status: {
          state: 'failed',
          message: {
            kind: 'message',
            messageId: 'mock-uuid',
            role: 'agent',
            taskId: 't1',
            contextId: 'c1',
            parts: [{kind: 'text', text: 'test error'}],
          },
          timestamp: '2024-01-01T00:00:00.000Z',
        },
      });
    });

    it('createTaskInputRequiredEvent', () => {
      expect(
        createTaskInputRequiredEvent({
          taskId: 't1',
          contextId: 'c1',
          parts: [{kind: 'text', text: 'input required'}],
          metadata: {m: 1},
        }),
      ).toEqual({
        kind: 'status-update',
        taskId: 't1',
        contextId: 'c1',
        final: true,
        status: {
          state: 'input-required',
          message: {
            kind: 'message',
            messageId: 'mock-uuid',
            role: 'agent',
            taskId: 't1',
            contextId: 'c1',
            parts: [{kind: 'text', text: 'input required'}],
          },
          timestamp: '2024-01-01T00:00:00.000Z',
        },
        metadata: {m: 1},
      });
    });

    it('createInputMissingErrorEvent', () => {
      expect(
        createInputMissingErrorEvent({
          parts: [
            {kind: 'text', text: 'valid input'},
            {
              kind: 'text',
              text: 'no input provided for function call ID f1',
              metadata: {validation_error: true},
            },
          ],
          taskId: 't1',
          contextId: 'c1',
        }),
      ).toEqual({
        kind: 'status-update',
        taskId: 't1',
        contextId: 'c1',
        final: true,
        status: {
          state: 'input-required',
          message: {
            kind: 'message',
            messageId: 'mock-uuid',
            role: 'agent',
            taskId: 't1',
            contextId: 'c1',
            parts: [
              {kind: 'text', text: 'valid input'},
              {
                kind: 'text',
                text: 'no input provided for function call ID f1',
                metadata: {validation_error: true},
              },
            ],
          },
          timestamp: '2024-01-01T00:00:00.000Z',
        },
      });
    });
  });
});
