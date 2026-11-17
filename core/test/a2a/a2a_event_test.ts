/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Message,
  Role,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {
  a2aEventToJson,
  createMessage,
  createTask,
  createTaskArtifactUpdateEvent,
  createTaskAuthRequiredEvent,
  createTaskCompletedEvent,
  createTaskFailedEvent,
  createTaskInputRequiredEvent,
  createTaskSnapshot,
  createTaskSubmittedEvent,
  createTaskWorkingEvent,
  createTextPart,
  getEventMetadata,
  getFailedTaskStatusUpdateEventError,
  isAuthRequiredTaskStatusUpdateEvent,
  isFailedTaskStatusUpdateEvent,
  isFinalTaskStatusUpdateEvent,
  isInputRequiredTaskStatusUpdateEvent,
  isMessage,
  isTask,
  isTaskArtifactUpdateEvent,
  isTaskStatusUpdateEvent,
  isTerminalTaskStatusUpdateEvent,
  isTurnEndingTaskState,
} from '../../src/a2a/a2a_event.js';

vi.mock('../../src/utils/env_aware_utils.js', () => ({
  randomUUID: () => 'mock-uuid',
}));

const TIMESTAMP = '2024-01-01T00:00:00.000Z';

function makeStatusUpdate(
  state: TaskState,
  message?: Message,
): TaskStatusUpdateEvent {
  return {
    taskId: 't1',
    contextId: 'c1',
    status: {state, message, timestamp: TIMESTAMP},
    metadata: undefined,
  };
}

function makeTask(state: TaskState, message?: Message): Task {
  return {
    id: 't1',
    contextId: 'c1',
    status: {state, message, timestamp: TIMESTAMP},
    artifacts: [],
    history: [],
    metadata: undefined,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    messageId: 'm1',
    contextId: 'c1',
    taskId: 't1',
    role: Role.ROLE_USER,
    parts: [],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
    ...overrides,
  };
}

function makeArtifactUpdate(
  metadata?: Record<string, unknown>,
): TaskArtifactUpdateEvent {
  return {
    taskId: 't1',
    contextId: 'c1',
    artifact: {
      artifactId: 'a1',
      name: '',
      description: '',
      parts: [],
      metadata,
      extensions: [],
    },
    append: false,
    lastChunk: false,
    metadata: undefined,
  };
}

describe('a2a_event', () => {
  describe('type guards', () => {
    it('isTaskStatusUpdateEvent', () => {
      expect(
        isTaskStatusUpdateEvent(makeStatusUpdate(TaskState.TASK_STATE_WORKING)),
      ).toBe(true);
      expect(isTaskStatusUpdateEvent(makeArtifactUpdate())).toBe(false);
      expect(
        isTaskStatusUpdateEvent(makeTask(TaskState.TASK_STATE_WORKING)),
      ).toBe(false);
      expect(isTaskStatusUpdateEvent(makeMessage())).toBe(false);
      expect(isTaskStatusUpdateEvent({other: 'x'})).toBe(false);
      expect(isTaskStatusUpdateEvent(null)).toBe(false);
    });

    it('isTaskArtifactUpdateEvent', () => {
      expect(isTaskArtifactUpdateEvent(makeArtifactUpdate())).toBe(true);
      expect(
        isTaskArtifactUpdateEvent(
          makeStatusUpdate(TaskState.TASK_STATE_WORKING),
        ),
      ).toBe(false);
      expect(isTaskArtifactUpdateEvent({other: 'x'})).toBe(false);
      expect(isTaskArtifactUpdateEvent(null)).toBe(false);
    });

    it('isMessage', () => {
      expect(isMessage(makeMessage())).toBe(true);
      expect(isMessage(makeTask(TaskState.TASK_STATE_WORKING))).toBe(false);
      expect(isMessage(makeStatusUpdate(TaskState.TASK_STATE_WORKING))).toBe(
        false,
      );
      expect(isMessage({other: 'x'})).toBe(false);
      expect(isMessage(null)).toBe(false);
    });

    it('isTask', () => {
      expect(isTask(makeTask(TaskState.TASK_STATE_WORKING))).toBe(true);
      expect(isTask(makeMessage())).toBe(false);
      expect(isTask(makeStatusUpdate(TaskState.TASK_STATE_WORKING))).toBe(
        false,
      );
      expect(isTask({other: 'x'})).toBe(false);
      expect(isTask(null)).toBe(false);
    });

    it('does not treat a non-object value as an event', () => {
      for (const value of ['text', 42, undefined, [makeMessage()]]) {
        expect(isTask(value)).toBe(false);
        expect(isMessage(value)).toBe(false);
        expect(isTaskStatusUpdateEvent(value)).toBe(false);
        expect(isTaskArtifactUpdateEvent(value)).toBe(false);
      }
    });

    it('isFailedTaskStatusUpdateEvent', () => {
      expect(
        isFailedTaskStatusUpdateEvent(
          makeStatusUpdate(TaskState.TASK_STATE_FAILED),
        ),
      ).toBe(true);
      expect(
        isFailedTaskStatusUpdateEvent(makeTask(TaskState.TASK_STATE_FAILED)),
      ).toBe(true);
      expect(
        isFailedTaskStatusUpdateEvent(
          makeStatusUpdate(TaskState.TASK_STATE_COMPLETED),
        ),
      ).toBe(false);
      expect(isFailedTaskStatusUpdateEvent({other: 'x'})).toBe(false);
    });

    it('isTerminalTaskStatusUpdateEvent', () => {
      expect(
        isTerminalTaskStatusUpdateEvent(
          makeStatusUpdate(TaskState.TASK_STATE_COMPLETED),
        ),
      ).toBe(true);
      expect(
        isTerminalTaskStatusUpdateEvent(
          makeTask(TaskState.TASK_STATE_COMPLETED),
        ),
      ).toBe(true);
      expect(
        isTerminalTaskStatusUpdateEvent(
          makeStatusUpdate(TaskState.TASK_STATE_FAILED),
        ),
      ).toBe(true);
      expect(
        isTerminalTaskStatusUpdateEvent(
          makeStatusUpdate(TaskState.TASK_STATE_CANCELED),
        ),
      ).toBe(true);
      expect(
        isTerminalTaskStatusUpdateEvent(
          makeStatusUpdate(TaskState.TASK_STATE_REJECTED),
        ),
      ).toBe(true);
      expect(
        isTerminalTaskStatusUpdateEvent(
          makeStatusUpdate(TaskState.TASK_STATE_WORKING),
        ),
      ).toBe(false);
      expect(
        isTerminalTaskStatusUpdateEvent(
          makeStatusUpdate(TaskState.TASK_STATE_INPUT_REQUIRED),
        ),
      ).toBe(false);
    });

    it('isInputRequiredTaskStatusUpdateEvent', () => {
      expect(
        isInputRequiredTaskStatusUpdateEvent(
          makeStatusUpdate(TaskState.TASK_STATE_INPUT_REQUIRED),
        ),
      ).toBe(true);
      expect(
        isInputRequiredTaskStatusUpdateEvent(
          makeTask(TaskState.TASK_STATE_INPUT_REQUIRED),
        ),
      ).toBe(true);
      expect(
        isInputRequiredTaskStatusUpdateEvent(
          makeStatusUpdate(TaskState.TASK_STATE_WORKING),
        ),
      ).toBe(false);
    });

    it('isAuthRequiredTaskStatusUpdateEvent', () => {
      expect(
        isAuthRequiredTaskStatusUpdateEvent(
          makeStatusUpdate(TaskState.TASK_STATE_AUTH_REQUIRED),
        ),
      ).toBe(true);
      expect(
        isAuthRequiredTaskStatusUpdateEvent(
          makeTask(TaskState.TASK_STATE_AUTH_REQUIRED),
        ),
      ).toBe(true);
      expect(
        isAuthRequiredTaskStatusUpdateEvent(
          makeStatusUpdate(TaskState.TASK_STATE_INPUT_REQUIRED),
        ),
      ).toBe(false);
    });
  });

  describe('turn-ending states', () => {
    const endingStates = [
      {name: 'completed', state: TaskState.TASK_STATE_COMPLETED},
      {name: 'failed', state: TaskState.TASK_STATE_FAILED},
      {name: 'canceled', state: TaskState.TASK_STATE_CANCELED},
      {name: 'rejected', state: TaskState.TASK_STATE_REJECTED},
      {name: 'input-required', state: TaskState.TASK_STATE_INPUT_REQUIRED},
      {name: 'auth-required', state: TaskState.TASK_STATE_AUTH_REQUIRED},
    ];
    const continuingStates = [
      {name: 'submitted', state: TaskState.TASK_STATE_SUBMITTED},
      {name: 'working', state: TaskState.TASK_STATE_WORKING},
    ];

    describe('isFinalTaskStatusUpdateEvent', () => {
      it.each(endingStates)('is true for a $name status update', ({state}) => {
        expect(isFinalTaskStatusUpdateEvent(makeStatusUpdate(state))).toBe(
          true,
        );
      });

      it.each(continuingStates)(
        'is false for a $name status update',
        ({state}) => {
          expect(isFinalTaskStatusUpdateEvent(makeStatusUpdate(state))).toBe(
            false,
          );
        },
      );

      it('is false for a Task even in a turn-ending state', () => {
        expect(
          isFinalTaskStatusUpdateEvent(
            makeTask(TaskState.TASK_STATE_COMPLETED),
          ),
        ).toBe(false);
      });

      it('is false for a message, an artifact update, and non-events', () => {
        expect(isFinalTaskStatusUpdateEvent(makeMessage())).toBe(false);
        expect(isFinalTaskStatusUpdateEvent(makeArtifactUpdate())).toBe(false);
        expect(isFinalTaskStatusUpdateEvent(null)).toBe(false);
        expect(isFinalTaskStatusUpdateEvent(undefined)).toBe(false);
      });

      it('is true for the events that the creators mark as ending a turn', () => {
        expect(
          isFinalTaskStatusUpdateEvent(
            createTaskCompletedEvent({taskId: 't1', contextId: 'c1'}),
          ),
        ).toBe(true);
        expect(
          isFinalTaskStatusUpdateEvent(
            createTaskFailedEvent({
              taskId: 't1',
              contextId: 'c1',
              error: new Error('boom'),
            }),
          ),
        ).toBe(true);
        expect(
          isFinalTaskStatusUpdateEvent(
            createTaskInputRequiredEvent({
              taskId: 't1',
              contextId: 'c1',
              parts: [],
            }),
          ),
        ).toBe(true);
        expect(
          isFinalTaskStatusUpdateEvent(
            createTaskAuthRequiredEvent({
              taskId: 't1',
              contextId: 'c1',
              parts: [],
            }),
          ),
        ).toBe(true);
      });

      it('is false for the events that the creators mark as in progress', () => {
        expect(
          isFinalTaskStatusUpdateEvent(
            createTaskWorkingEvent({taskId: 't1', contextId: 'c1'}),
          ),
        ).toBe(false);
        expect(
          isFinalTaskStatusUpdateEvent(
            createTaskSubmittedEvent({
              taskId: 't1',
              contextId: 'c1',
              message: makeMessage(),
            }),
          ),
        ).toBe(false);
      });
    });

    describe('isTurnEndingTaskState', () => {
      it.each(endingStates)(
        'is true for a $name status update and a $name task',
        ({state}) => {
          expect(isTurnEndingTaskState(makeStatusUpdate(state))).toBe(true);
          expect(isTurnEndingTaskState(makeTask(state))).toBe(true);
        },
      );

      it.each(continuingStates)(
        'is false for a $name status update and a $name task',
        ({state}) => {
          expect(isTurnEndingTaskState(makeStatusUpdate(state))).toBe(false);
          expect(isTurnEndingTaskState(makeTask(state))).toBe(false);
        },
      );

      it('is false for events that carry no task state', () => {
        expect(isTurnEndingTaskState(makeMessage())).toBe(false);
        expect(isTurnEndingTaskState(makeArtifactUpdate())).toBe(false);
        expect(isTurnEndingTaskState({status: {state: 3}})).toBe(false);
        expect(isTurnEndingTaskState(null)).toBe(false);
      });
    });
  });

  describe('getEventMetadata', () => {
    it('returns metadata for artifact-update', () => {
      const event = makeArtifactUpdate({foo: 'bar'});
      expect(getEventMetadata(event)).toEqual({foo: 'bar'});
    });

    it('returns empty object if artifact metadata is missing', () => {
      const event = makeArtifactUpdate(undefined);
      expect(getEventMetadata(event)).toEqual({});
    });

    it('returns the artifact metadata, not the event metadata, for artifact-update', () => {
      const event = {...makeArtifactUpdate({a: 1}), metadata: {e: 2}};
      expect(getEventMetadata(event)).toEqual({a: 1});
    });

    it('returns metadata for status-update', () => {
      const event: TaskStatusUpdateEvent = {
        ...makeStatusUpdate(TaskState.TASK_STATE_WORKING),
        metadata: {bar: 'baz'},
      };
      expect(getEventMetadata(event)).toEqual({bar: 'baz'});
    });

    it('returns metadata for task', () => {
      const event: Task = {
        ...makeTask(TaskState.TASK_STATE_WORKING),
        metadata: {bar: 'baz'},
      };
      expect(getEventMetadata(event)).toEqual({bar: 'baz'});
    });

    it('returns metadata for message', () => {
      const event: Message = makeMessage({metadata: {bar: 'baz'}});
      expect(getEventMetadata(event)).toEqual({bar: 'baz'});
    });

    it('returns empty object if metadata is missing', () => {
      const event = makeStatusUpdate(TaskState.TASK_STATE_WORKING);
      expect(getEventMetadata(event)).toEqual({});
    });

    it('returns empty object for unknown event type', () => {
      const event = {unknown: true} as unknown as TaskStatusUpdateEvent;
      expect(getEventMetadata(event)).toEqual({});
    });
  });

  describe('getFailedTaskStatusUpdateEventError', () => {
    it('returns undefined if not failed task status update', () => {
      expect(
        getFailedTaskStatusUpdateEventError(
          makeStatusUpdate(TaskState.TASK_STATE_WORKING),
        ),
      ).toBeUndefined();
    });

    it('returns undefined if no message', () => {
      expect(
        getFailedTaskStatusUpdateEventError(
          makeStatusUpdate(TaskState.TASK_STATE_FAILED),
        ),
      ).toBeUndefined();
    });

    it('returns undefined if no parts', () => {
      expect(
        getFailedTaskStatusUpdateEventError(
          makeStatusUpdate(
            TaskState.TASK_STATE_FAILED,
            makeMessage({parts: []}),
          ),
        ),
      ).toBeUndefined();
    });

    it('returns undefined if first part is not text', () => {
      expect(
        getFailedTaskStatusUpdateEventError(
          makeStatusUpdate(
            TaskState.TASK_STATE_FAILED,
            makeMessage({
              parts: [
                {
                  content: {$case: 'data', value: {code: 1}},
                  metadata: undefined,
                  filename: '',
                  mediaType: '',
                },
              ],
            }),
          ),
        ),
      ).toBeUndefined();
    });

    it('returns text of first part', () => {
      expect(
        getFailedTaskStatusUpdateEventError(
          makeStatusUpdate(
            TaskState.TASK_STATE_FAILED,
            makeMessage({parts: [createTextPart('error msg')]}),
          ),
        ),
      ).toEqual('error msg');
    });

    it('returns text of first part for Task', () => {
      expect(
        getFailedTaskStatusUpdateEventError(
          makeTask(
            TaskState.TASK_STATE_FAILED,
            makeMessage({parts: [createTextPart('error msg')]}),
          ),
        ),
      ).toEqual('error msg');
    });
  });

  describe('createTextPart', () => {
    it('creates a text part with empty filename and mediaType by default', () => {
      expect(createTextPart('hello')).toEqual({
        content: {$case: 'text', value: 'hello'},
        metadata: undefined,
        filename: '',
        mediaType: '',
      });
    });

    it('attaches metadata when given', () => {
      expect(createTextPart('hello', {adk_thought: true})).toEqual({
        content: {$case: 'text', value: 'hello'},
        metadata: {adk_thought: true},
        filename: '',
        mediaType: '',
      });
    });

    it('keeps empty text as a text part', () => {
      expect(createTextPart('').content).toEqual({$case: 'text', value: ''});
    });
  });

  describe('createMessage', () => {
    it('fills absent fields with defaults', () => {
      const parts = [createTextPart('hi')];
      expect(createMessage({role: Role.ROLE_USER, parts})).toEqual({
        messageId: 'mock-uuid',
        contextId: '',
        taskId: '',
        role: Role.ROLE_USER,
        parts,
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      });
    });

    it('keeps the fields it is given', () => {
      const parts = [createTextPart('hi')];
      expect(
        createMessage({
          role: Role.ROLE_AGENT,
          parts,
          messageId: 'm9',
          taskId: 't9',
          contextId: 'c9',
          metadata: {k: 'v'},
        }),
      ).toEqual({
        messageId: 'm9',
        contextId: 'c9',
        taskId: 't9',
        role: Role.ROLE_AGENT,
        parts,
        metadata: {k: 'v'},
        extensions: [],
        referenceTaskIds: [],
      });
    });

    it('generates a message id when it is empty', () => {
      expect(
        createMessage({role: Role.ROLE_USER, parts: [], messageId: ''})
          .messageId,
      ).toBe('mock-uuid');
    });

    it('produces a value that isMessage accepts', () => {
      expect(isMessage(createMessage({role: Role.ROLE_USER, parts: []}))).toBe(
        true,
      );
    });
  });

  describe('a2aEventToJson', () => {
    it('converts a Task to its v1 JSON form', () => {
      const task = makeTask(
        TaskState.TASK_STATE_COMPLETED,
        makeMessage({
          role: Role.ROLE_AGENT,
          parts: [createTextPart('done')],
        }),
      );
      expect(a2aEventToJson(task)).toEqual({
        id: 't1',
        contextId: 'c1',
        status: {
          state: 'TASK_STATE_COMPLETED',
          message: {
            messageId: 'm1',
            contextId: 'c1',
            taskId: 't1',
            role: 'ROLE_AGENT',
            parts: [{text: 'done'}],
          },
          timestamp: TIMESTAMP,
        },
      });
    });

    it('converts a Message to its v1 JSON form', () => {
      expect(
        a2aEventToJson(
          makeMessage({
            role: Role.ROLE_USER,
            parts: [createTextPart('hi')],
            metadata: {k: 'v'},
          }),
        ),
      ).toEqual({
        messageId: 'm1',
        contextId: 'c1',
        taskId: 't1',
        role: 'ROLE_USER',
        parts: [{text: 'hi'}],
        metadata: {k: 'v'},
      });
    });

    it('converts a TaskStatusUpdateEvent to its v1 JSON form', () => {
      expect(
        a2aEventToJson(makeStatusUpdate(TaskState.TASK_STATE_WORKING)),
      ).toEqual({
        taskId: 't1',
        contextId: 'c1',
        status: {state: 'TASK_STATE_WORKING', timestamp: TIMESTAMP},
      });
    });

    it('converts a TaskArtifactUpdateEvent to its v1 JSON form', () => {
      const event = makeArtifactUpdate();
      event.artifact!.parts = [createTextPart('chunk')];
      event.append = true;
      expect(a2aEventToJson(event)).toEqual({
        taskId: 't1',
        contextId: 'c1',
        artifact: {artifactId: 'a1', parts: [{text: 'chunk'}]},
        append: true,
      });
    });

    it('omits empty strings and arrays', () => {
      const json = a2aEventToJson(
        createMessage({role: Role.ROLE_USER, parts: [], messageId: 'm1'}),
      ) as Record<string, unknown>;
      expect(json).toEqual({messageId: 'm1', role: 'ROLE_USER'});
    });

    it('returns a JSON-serializable value', () => {
      const json = a2aEventToJson(makeTask(TaskState.TASK_STATE_WORKING));
      expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    });

    it('returns an unrecognized value unchanged', () => {
      const value = {other: 'shape'} as unknown as Task;
      expect(a2aEventToJson(value)).toBe(value);
    });
  });

  describe('event creators', () => {
    beforeAll(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(TIMESTAMP));
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    const message: Message = makeMessage();

    it('createTaskSubmittedEvent', () => {
      expect(
        createTaskSubmittedEvent({taskId: 't1', contextId: 'c1', message}),
      ).toEqual({
        taskId: 't1',
        contextId: 'c1',
        status: {
          state: TaskState.TASK_STATE_SUBMITTED,
          message,
          timestamp: TIMESTAMP,
        },
      });
    });

    it('createTaskWorkingEvent', () => {
      expect(
        createTaskWorkingEvent({taskId: 't1', contextId: 'c1', message}),
      ).toEqual({
        taskId: 't1',
        contextId: 'c1',
        status: {
          state: TaskState.TASK_STATE_WORKING,
          message,
          timestamp: TIMESTAMP,
        },
      });
    });

    it('createTaskWorkingEvent without message', () => {
      expect(createTaskWorkingEvent({taskId: 't1', contextId: 'c1'})).toEqual({
        taskId: 't1',
        contextId: 'c1',
        status: {
          state: TaskState.TASK_STATE_WORKING,
          message: undefined,
          timestamp: TIMESTAMP,
        },
      });
    });

    it('createTask', () => {
      expect(createTask({taskId: 't1', contextId: 'c1', message})).toEqual({
        id: 't1',
        contextId: 'c1',
        history: [message],
        artifacts: [],
        status: {
          state: TaskState.TASK_STATE_SUBMITTED,
          timestamp: TIMESTAMP,
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
        id: 'mock-uuid',
        contextId: 'c1',
        history: [message],
        artifacts: [],
        status: {
          state: TaskState.TASK_STATE_SUBMITTED,
          timestamp: TIMESTAMP,
        },
        metadata: {foo: 'bar'},
      });
    });

    describe('createTaskSnapshot', () => {
      it('carries only the id, context and state', () => {
        expect(
          createTaskSnapshot({
            taskId: 't1',
            contextId: 'c1',
            state: TaskState.TASK_STATE_WORKING,
          }),
        ).toEqual({
          id: 't1',
          contextId: 'c1',
          history: [],
          artifacts: [],
          status: {
            state: TaskState.TASK_STATE_WORKING,
            message: undefined,
            timestamp: TIMESTAMP,
          },
          metadata: undefined,
        });
      });

      it('takes the state it is given', () => {
        expect(
          createTaskSnapshot({
            taskId: 't1',
            contextId: 'c1',
            state: TaskState.TASK_STATE_INPUT_REQUIRED,
          }).status?.state,
        ).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
      });

      it('attaches metadata when given', () => {
        expect(
          createTaskSnapshot({
            taskId: 't1',
            contextId: 'c1',
            state: TaskState.TASK_STATE_WORKING,
            metadata: {k: 'v'},
          }).metadata,
        ).toEqual({k: 'v'});
      });

      it('produces a value that isTask accepts and that is not a status update', () => {
        const snapshot = createTaskSnapshot({
          taskId: 't1',
          contextId: 'c1',
          state: TaskState.TASK_STATE_WORKING,
        });
        expect(isTask(snapshot)).toBe(true);
        expect(isTaskStatusUpdateEvent(snapshot)).toBe(false);
      });

      it('has no history, artifacts or status message', () => {
        const snapshot = createTaskSnapshot({
          taskId: 't1',
          contextId: 'c1',
          state: TaskState.TASK_STATE_COMPLETED,
        });
        expect(snapshot.history).toEqual([]);
        expect(snapshot.artifacts).toEqual([]);
        expect(snapshot.status?.message).toBeUndefined();
      });
    });

    it('createTaskCompletedEvent', () => {
      expect(createTaskCompletedEvent({taskId: 't1', contextId: 'c1'})).toEqual(
        {
          taskId: 't1',
          contextId: 'c1',
          status: {
            state: TaskState.TASK_STATE_COMPLETED,
            timestamp: TIMESTAMP,
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
          parts: [createTextPart('part')],
          metadata: {m: 1},
          append: true,
          lastChunk: false,
        }),
      ).toEqual({
        taskId: 't1',
        contextId: 'c1',
        append: true,
        lastChunk: false,
        artifact: {
          artifactId: 'mock-uuid',
          name: '',
          description: '',
          parts: [createTextPart('part')],
          extensions: [],
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
        taskId: 't1',
        contextId: 'c1',
        append: false,
        lastChunk: false,
        artifact: {
          artifactId: 'custom-id',
          name: '',
          description: '',
          parts: [],
          extensions: [],
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
        taskId: 't1',
        contextId: 'c1',
        status: {
          state: TaskState.TASK_STATE_FAILED,
          message: {
            messageId: 'mock-uuid',
            role: Role.ROLE_AGENT,
            taskId: 't1',
            contextId: 'c1',
            parts: [createTextPart('test error')],
            extensions: [],
            referenceTaskIds: [],
          },
          timestamp: TIMESTAMP,
        },
      });
    });

    it('createTaskInputRequiredEvent', () => {
      expect(
        createTaskInputRequiredEvent({
          taskId: 't1',
          contextId: 'c1',
          parts: [createTextPart('input required')],
          metadata: {m: 1},
        }),
      ).toEqual({
        taskId: 't1',
        contextId: 'c1',
        status: {
          state: TaskState.TASK_STATE_INPUT_REQUIRED,
          message: {
            messageId: 'mock-uuid',
            role: Role.ROLE_AGENT,
            taskId: 't1',
            contextId: 'c1',
            parts: [createTextPart('input required')],
            extensions: [],
            referenceTaskIds: [],
          },
          timestamp: TIMESTAMP,
        },
        metadata: {m: 1},
      });
    });

    it('createTaskInputRequiredEvent carries validation-error parts through', () => {
      expect(
        createTaskInputRequiredEvent({
          parts: [
            createTextPart('valid input'),
            createTextPart('no input provided for function call ID f1', {
              validation_error: true,
            }),
          ],
          taskId: 't1',
          contextId: 'c1',
        }),
      ).toEqual({
        taskId: 't1',
        contextId: 'c1',
        status: {
          state: TaskState.TASK_STATE_INPUT_REQUIRED,
          message: {
            messageId: 'mock-uuid',
            role: Role.ROLE_AGENT,
            taskId: 't1',
            contextId: 'c1',
            parts: [
              createTextPart('valid input'),
              createTextPart('no input provided for function call ID f1', {
                validation_error: true,
              }),
            ],
            extensions: [],
            referenceTaskIds: [],
          },
          timestamp: TIMESTAMP,
        },
      });
    });

    it('createTaskAuthRequiredEvent', () => {
      const event = createTaskAuthRequiredEvent({
        taskId: 't1',
        contextId: 'c1',
        parts: [createTextPart('sign in first')],
        metadata: {key: 'value'},
      });

      expect(event).toEqual({
        taskId: 't1',
        contextId: 'c1',
        metadata: {key: 'value'},
        status: {
          state: TaskState.TASK_STATE_AUTH_REQUIRED,
          message: {
            messageId: 'mock-uuid',
            role: Role.ROLE_AGENT,
            taskId: 't1',
            contextId: 'c1',
            parts: [createTextPart('sign in first')],
            extensions: [],
            referenceTaskIds: [],
          },
          timestamp: TIMESTAMP,
        },
      });
    });
  });
});
