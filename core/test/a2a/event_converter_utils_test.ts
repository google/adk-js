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
import {createEvent, createEventActions} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {A2AEvent} from '../../src/a2a/a2a_event.js';
import {toA2AMessage, toAdkEvent} from '../../src/a2a/event_converter_utils.js';
import * as envAwareUtils from '../../src/utils/env_aware_utils.js';

vi.mock('../../src/utils/env_aware_utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/utils/env_aware_utils.js')>();
  return {
    ...actual,
    randomUUID: vi.fn(),
  };
});

describe('event_converter_utils', () => {
  describe('toA2AMessage', () => {
    it('converts a simple user event to an A2A message', () => {
      vi.mocked(envAwareUtils.randomUUID).mockReturnValue('test-uuid-1');
      const event = createEvent({
        invocationId: 'inv1',
        author: 'user',
        content: {
          role: 'user',
          parts: [{text: 'hello'}],
        },
      });

      const message = toA2AMessage(event, {
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
      });
      expect(message).toBeDefined();
      expect(message).toMatchObject({
        kind: 'message',
        messageId: 'test-uuid-1',
        role: 'user',
        parts: [{kind: 'text', text: 'hello'}],
        metadata: {
          'adk_app_name': 'test-app',
          'adk_user_id': 'test-user',
          'adk_session_id': 'test-session',
        },
      });
    });

    it('converts agent event with actions and custom metadata', () => {
      vi.mocked(envAwareUtils.randomUUID).mockReturnValue('test-uuid-2');
      const actions = createEventActions();
      actions.escalate = true;
      actions.transferToAgent = 'human';

      const event = createEvent({
        invocationId: 'inv2',
        author: 'agent_1',
        content: {
          role: 'model',
          parts: [{text: 'response'}],
        },
        actions,
        customMetadata: {
          'custom_key': 'custom_value',
        },
      });

      const message = toA2AMessage(event, {
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
      });
      expect(message).toBeDefined();
      expect(message).toMatchObject({
        kind: 'message',
        messageId: 'test-uuid-2',
        role: 'agent',
        parts: [{kind: 'text', text: 'response'}],
        metadata: {
          'adk_escalate': true,
          'adk_transfer_to_agent': 'human',
          'adk_custom_metadata': {
            'custom_key': 'custom_value',
          },
        },
      });
    });
  });

  describe('toAdkEvent', () => {
    it('returns undefined for unknown event type', () => {
      expect(
        toAdkEvent({kind: 'unknown'} as unknown as A2AEvent, 'inv', 'agent'),
      ).toBe(undefined);
    });

    it('populates AdkEvent fields from metadata', () => {
      const message: Message = {
        kind: 'message',
        messageId: 'msg1',
        role: 'agent',
        parts: [{kind: 'text', text: 'hello'}],
        metadata: {
          'adk_branch': 'test-branch',
          'adk_error_code': '404',
          'adk_error_message': 'not found',
        },
      };

      const event = toAdkEvent(message, 'inv1', 'agent1');
      expect(event).toBeDefined();
      expect(event!.branch).toBe('test-branch');
      expect(event!.errorCode).toBe('404');
      expect(event!.errorMessage).toBe('not found');
    });

    describe('Message', () => {
      it('converts user message to AdkEvent', () => {
        const message: Message = {
          kind: 'message',
          messageId: 'msg1',
          role: 'user',
          parts: [{kind: 'text', text: 'hello from user'}],
        };

        const event = toAdkEvent(message, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.author).toBe('user');
        expect(event!.content?.role).toBe('user');
        expect(event!.content?.parts).toEqual([
          {text: 'hello from user', thought: false},
        ]);
        expect(event!.turnComplete).toBe(true);
      });

      it('converts agent message to AdkEvent', () => {
        const message: Message = {
          kind: 'message',
          messageId: 'msg2',
          role: 'agent',
          parts: [{kind: 'text', text: 'hello from agent'}],
          metadata: {
            'adk_escalate': true,
            'adk_transfer_to_agent': 'agent2',
            'adk_custom_metadata': {
              'a2a:task_id': 'task1',
              'a2a:context_id': 'context1',
            },
          },
        };

        const event = toAdkEvent(message, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.author).toBe('agent1');
        expect(event!.content?.role).toBe('model');
        expect(event!.content?.parts).toEqual([
          {text: 'hello from agent', thought: false},
        ]);
        expect(event!.turnComplete).toBe(true);
        expect(event!.actions?.escalate).toBe(true);
        expect(event!.actions?.transferToAgent).toBe('agent2');
        expect(event!.customMetadata).toEqual({
          'a2a:task_id': 'task1',
          'a2a:context_id': 'context1',
        });
      });
    });

    describe('TaskStatusUpdateEvent', () => {
      it('converts final status update', () => {
        const finalUpdate: TaskStatusUpdateEvent = {
          kind: 'status-update',
          taskId: 'task1',
          contextId: 'context1',
          status: {
            state: 'completed',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [{kind: 'text', text: 'done'}],
            },
          },
          final: true,
        };

        const event = toAdkEvent(finalUpdate, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.author).toBe('agent1');
        expect(event!.content?.role).toBe('model');
        expect(event!.content?.parts).toEqual([{text: 'done', thought: false}]);
        expect(event!.turnComplete).toBe(true);
      });

      it('converts final status update (failed without message parts)', () => {
        const finalUpdate: TaskStatusUpdateEvent = {
          kind: 'status-update',
          taskId: 'task1',
          contextId: 'context1',
          status: {
            state: 'failed',
          },
          final: true,
        };

        const event = toAdkEvent(finalUpdate, 'inv1', 'agent1');
        expect(event).toBeUndefined();
      });

      it('converts final status update (failed with text part)', () => {
        const finalUpdate: TaskStatusUpdateEvent = {
          kind: 'status-update',
          taskId: 'task1',
          contextId: 'context1',
          status: {
            state: 'failed',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [{kind: 'text', text: 'error occurred'}],
            },
          },
          final: true,
        };

        const event = toAdkEvent(finalUpdate, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.errorMessage).toBe('error occurred');
        expect(event!.content).toBeUndefined();
        expect(event!.turnComplete).toBe(true);
      });

      it('converts non-final status update with partial message', () => {
        const nonFinalUpdate: TaskStatusUpdateEvent = {
          kind: 'status-update',
          taskId: 'task1',
          contextId: 'context1',
          status: {
            state: 'working',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [{kind: 'text', text: 'thinking loudly...'}],
            },
          },
          final: false,
        };

        const event = toAdkEvent(nonFinalUpdate, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.partial).toBe(true);
        expect(event!.turnComplete).toBe(false);
        expect(event!.content?.parts).toEqual([
          {text: 'thinking loudly...', thought: false},
        ]);
      });

      it('returns undefined if non-final status update has no message', () => {
        const nonFinalUpdate: TaskStatusUpdateEvent = {
          kind: 'status-update',
          taskId: 'task1',
          contextId: 'context1',
          status: {
            state: 'working',
          },
          final: false,
        };

        expect(toAdkEvent(nonFinalUpdate, 'inv1', 'agent1')).toBeUndefined();
      });
    });

    describe('TaskArtifactUpdateEvent', () => {
      it('converts artifact update with no parts to undefined', () => {
        const artifactUpdate: TaskArtifactUpdateEvent = {
          kind: 'artifact-update',
          taskId: 'task1',
          contextId: 'context1',
          artifact: {
            artifactId: 'art1',
            parts: [],
          },
        };

        expect(toAdkEvent(artifactUpdate, 'inv1', 'agent1')).toBeUndefined();
      });

      it('sets partial to true when append is true', () => {
        const artifactUpdate: TaskArtifactUpdateEvent = {
          kind: 'artifact-update',
          taskId: 'task1',
          contextId: 'context1',
          append: true,
          lastChunk: true,
          artifact: {
            artifactId: 'art1',
            parts: [{kind: 'text', text: 'part'}],
          },
        };

        const event = toAdkEvent(artifactUpdate, 'inv1', 'agent1');
        expect(event?.partial).toBe(true);
      });

      it('sets partial to true when lastChunk is false', () => {
        const artifactUpdate: TaskArtifactUpdateEvent = {
          kind: 'artifact-update',
          taskId: 'task1',
          contextId: 'context1',
          append: false,
          lastChunk: false,
          artifact: {
            artifactId: 'art1',
            parts: [{kind: 'text', text: 'part'}],
          },
        };

        const event = toAdkEvent(artifactUpdate, 'inv1', 'agent1');
        expect(event?.partial).toBe(true);
      });

      it('sets partial to false when append is false and lastChunk is true', () => {
        const artifactUpdate: TaskArtifactUpdateEvent = {
          kind: 'artifact-update',
          taskId: 'task1',
          contextId: 'context1',
          append: false,
          lastChunk: true,
          artifact: {
            artifactId: 'art1',
            parts: [{kind: 'text', text: 'part'}],
          },
        };

        const event = toAdkEvent(artifactUpdate, 'inv1', 'agent1');
        expect(event?.partial).toBe(false);
      });

      it('converts artifact update', () => {
        const artifactUpdate: TaskArtifactUpdateEvent = {
          kind: 'artifact-update',
          taskId: 'task1',
          contextId: 'context1',
          metadata: {
            'adk_custom_metadata': {
              'a2a:task_id': 'task2',
            },
          },
          artifact: {
            artifactId: 'art1',
            parts: [
              {
                kind: 'data',
                data: {id: 'testTool', name: 'testTool', args: {}},
                metadata: {
                  'adk_is_long_running': true,
                  'adk_type': 'function_call',
                },
              },
            ],
            metadata: {
              'adk_partial': true,
              'adk_custom_metadata': {
                'a2a:task_id': 'task2',
              },
              'adk_type': 'function_call',
            },
          },
        };

        const event = toAdkEvent(artifactUpdate, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.partial).toBe(true);
        expect(event!.longRunningToolIds).toEqual(['testTool']);
        expect(event!.customMetadata).toEqual({'a2a:task_id': 'task2'});
        expect(event!.content?.parts).toEqual([
          {functionCall: {id: 'testTool', name: 'testTool', args: {}}},
        ]);
      });
    });

    describe('Task', () => {
      it('returns undefined for task with no parts and non-terminal state', () => {
        const task: Task = {
          kind: 'task',
          id: 'task1',
          contextId: 'context1',
          status: {state: 'working'},
        };
        expect(toAdkEvent(task, 'inv1', 'agent1')).toBeUndefined();
      });

      it('converts completed task with artifacts and status message', () => {
        const task: Task = {
          kind: 'task',
          id: 'task1',
          contextId: 'context1',
          artifacts: [
            {
              artifactId: 'art1',
              parts: [
                {
                  kind: 'data',
                  data: {id: 'artTool', name: 'artTool', args: {}},
                  metadata: {
                    'adk_is_long_running': true,
                    'adk_type': 'function_call',
                  },
                },
              ],
            },
          ],
          status: {
            state: 'completed',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [{kind: 'text', text: 'task complete'}],
            },
          },
          metadata: {
            'adk_custom_metadata': {
              'a2a:task_id': 't1',
              'a2a:context_id': 'c1',
            },
          },
        };

        const event = toAdkEvent(task, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.turnComplete).toBe(true);
        expect(event!.longRunningToolIds).toEqual(['artTool']);
        expect(event!.content?.parts).toEqual([
          {functionCall: {id: 'artTool', name: 'artTool', args: {}}},
          {text: 'task complete', thought: false},
        ]);
        expect(event!.customMetadata).toEqual({
          'a2a:task_id': 't1',
          'a2a:context_id': 'c1',
        });
      });

      it('converts failed task with text error message', () => {
        const task: Task = {
          kind: 'task',
          id: 'task1',
          contextId: 'context1',
          status: {
            state: 'failed',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [{kind: 'text', text: 'task failed miserably'}],
            },
          },
        };

        const event = toAdkEvent(task, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.turnComplete).toBe(true);
        expect(event!.errorMessage).toBe('task failed miserably');
        expect(event!.content).toBeUndefined();
      });

      it('converts input-required task and extracts longRunningToolIds', () => {
        const task: Task = {
          kind: 'task',
          id: 'task1',
          contextId: 'context1',
          status: {
            state: 'input-required',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [
                {
                  kind: 'data',
                  data: {id: 'inputTool', name: 'inputTool', args: {}},
                  metadata: {
                    'adk_is_long_running': true,
                    'adk_type': 'function_call',
                  },
                },
              ],
            },
          },
        };

        const event = toAdkEvent(task, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.turnComplete).toBe(true);
        expect(event!.longRunningToolIds).toEqual(['inputTool']);
      });
    });
  });
});
