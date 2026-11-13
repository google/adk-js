/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Message, Task} from '@a2a-js/sdk';
import {
  Event as AdkEvent,
  createEvent,
  createEventActions,
  INTERNAL_METADATA_PREFIX,
  RESTORED_EVENT_KEY,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {toAdkEvent} from '../../src/a2a/event_converter_utils.js';
import {
  type A2AContextIdParts,
  A2AMetadataKeys,
  ADK_CONTEXT_ID_PREFIX,
  ADK_CONTEXT_ID_SEPARATOR,
  AdkMetadataKeys,
  fromA2AContextId,
  getA2AEventMetadata,
  getAdkEventMetadata,
  toA2AContextId,
} from '../../src/a2a/metadata_converter_utils.js';
import {logger} from '../../src/utils/logger.js';

const contextData: A2AContextIdParts = {
  appName: 'my-app',
  userId: 'user-id',
  sessionId: 'session-id',
};

describe('metadata_converter_utils', () => {
  describe('getAdkEventMetadata', () => {
    it('creates metadata for a Task', () => {
      const task: Task = {
        kind: 'task',
        id: 'task-123',
        contextId: 'ctx-456',
        status: {state: 'working'},
      };
      const metadata = getAdkEventMetadata(task);
      expect(metadata).toEqual({
        [AdkMetadataKeys.TASK_ID]: 'task-123',
        [AdkMetadataKeys.CONTEXT_ID]: 'ctx-456',
      });
    });

    it('creates metadata for a Message (not a Task)', () => {
      const message: Message = {
        kind: 'message',
        messageId: 'msg-123',
        role: 'user',
        taskId: 'task-789',
        contextId: 'ctx-012',
        parts: [],
      };
      const metadata = getAdkEventMetadata(message);
      expect(metadata).toEqual({
        [AdkMetadataKeys.TASK_ID]: 'task-789',
        [AdkMetadataKeys.CONTEXT_ID]: 'ctx-012',
      });
    });
  });

  describe('getA2AEventMetadata', () => {
    it('creates metadata from an ADK Event', () => {
      const adkEvent: Partial<AdkEvent> = {
        invocationId: 'inv-1',
        author: 'user1',
        branch: 'branch-1',
        errorCode: 'RESOURCE_EXHAUSTED',
        errorMessage: 'Quota exceeded',
        citationMetadata: {
          citations: [
            {
              startIndex: 0,
              endIndex: 10,
              uri: 'http://example.com',
              title: 'Example',
            },
          ],
        },
        groundingMetadata: {
          webSearchQueries: ['test'],
        },
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          totalTokenCount: 30,
        },
        customMetadata: {customKey: 'customValue'},
        partial: true,
        actions: {
          escalate: true,
          transferToAgent: 'agent-2',
          stateDelta: {},
          artifactDelta: {},
          requestedToolConfirmations: {},
          requestedAuthConfigs: {},
        },
        longRunningToolIds: ['toolA', 'toolB'],
      };

      const contextData = {
        appName: 'my-app',
        userId: 'user-id',
        sessionId: 'session-id',
      };

      const metadata = getA2AEventMetadata(adkEvent as AdkEvent, contextData);

      expect(metadata).toEqual({
        [A2AMetadataKeys.APP_NAME]: 'my-app',
        [A2AMetadataKeys.USER_ID]: 'user-id',
        [A2AMetadataKeys.SESSION_ID]: 'session-id',
        [A2AMetadataKeys.INVOCATION_ID]: 'inv-1',
        [A2AMetadataKeys.AUTHOR]: 'user1',
        [A2AMetadataKeys.BRANCH]: 'branch-1',
        [A2AMetadataKeys.ERROR_CODE]: 'RESOURCE_EXHAUSTED',
        [A2AMetadataKeys.ERROR_MESSAGE]: 'Quota exceeded',
        [A2AMetadataKeys.CITATION_METADATA]: {
          citations: [
            {
              startIndex: 0,
              endIndex: 10,
              uri: 'http://example.com',
              title: 'Example',
            },
          ],
        },
        [A2AMetadataKeys.GROUNDING_METADATA]: {
          webSearchQueries: ['test'],
        },
        [A2AMetadataKeys.USAGE_METADATA]: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          totalTokenCount: 30,
        },
        [A2AMetadataKeys.CUSTOM_METADATA]: {customKey: 'customValue'},
        [A2AMetadataKeys.PARTIAL]: true,
        [A2AMetadataKeys.ESCALATE]: true,
        [A2AMetadataKeys.TRANSFER_TO_AGENT]: 'agent-2',
        [A2AMetadataKeys.IS_LONG_RUNNING]: true,
      });
    });

    it('preserves error details through a round-trip', () => {
      const adkEvent = {
        errorCode: 'RESOURCE_EXHAUSTED',
        errorMessage: 'Quota exceeded',
        actions: createEventActions(),
      } as AdkEvent;
      const metadata = getA2AEventMetadata(adkEvent, {
        appName: 'my-app',
        userId: 'user-id',
        sessionId: 'session-id',
      });
      const message: Message = {
        kind: 'message',
        messageId: 'msg-1',
        role: 'agent',
        parts: [{kind: 'text', text: 'error'}],
        metadata,
      };

      const roundTrippedEvent = toAdkEvent(message, 'inv-1', 'agent-1');

      expect(roundTrippedEvent?.errorCode).toBe('RESOURCE_EXHAUSTED');
      expect(roundTrippedEvent?.errorMessage).toBe('Quota exceeded');
    });

    it('omits ADK-internal customMetadata keys', () => {
      const adkEvent = createEvent({
        customMetadata: {keep: 1, [`${INTERNAL_METADATA_PREFIX}stamp`]: 'x'},
      });
      const debug = vi.spyOn(logger, 'debug');

      const metadata = getA2AEventMetadata(adkEvent, contextData);

      expect(metadata[A2AMetadataKeys.CUSTOM_METADATA]).toEqual({keep: 1});
      expect(debug).not.toHaveBeenCalled();
      debug.mockRestore();
    });

    it('omits customMetadata that has only ADK-internal keys', () => {
      const adkEvent = createEvent({
        customMetadata: {[RESTORED_EVENT_KEY]: true},
      });

      const metadata = getA2AEventMetadata(adkEvent, contextData);

      expect(metadata[A2AMetadataKeys.CUSTOM_METADATA]).toBeUndefined();
    });

    it('drops ADK-internal customMetadata keys set by a remote peer', () => {
      const message: Message = {
        kind: 'message',
        messageId: 'msg-1',
        role: 'agent',
        parts: [{kind: 'text', text: 'hi'}],
        metadata: {
          [A2AMetadataKeys.CUSTOM_METADATA]: {
            keep: 1,
            [`${INTERNAL_METADATA_PREFIX}planted`]: 'x',
            [RESTORED_EVENT_KEY]: true,
          },
        },
      };

      const event = toAdkEvent(message, 'inv-1', 'agent-1');

      expect(event?.customMetadata).toEqual({keep: 1});
    });

    it('creates metadata with missing optional fields', () => {
      const adkEvent: Partial<AdkEvent> = {
        invocationId: 'inv-2',
        author: 'agent-1',
        actions: createEventActions(),
      };

      const contextData = {
        appName: 'app-2',
        userId: 'user-2',
        sessionId: 'sess-2',
      };

      const metadata = getA2AEventMetadata(adkEvent as AdkEvent, contextData);

      expect(metadata).toEqual({
        [A2AMetadataKeys.APP_NAME]: 'app-2',
        [A2AMetadataKeys.USER_ID]: 'user-2',
        [A2AMetadataKeys.SESSION_ID]: 'sess-2',
        [A2AMetadataKeys.INVOCATION_ID]: 'inv-2',
        [A2AMetadataKeys.AUTHOR]: 'agent-1',
        [A2AMetadataKeys.BRANCH]: undefined,
        [A2AMetadataKeys.ERROR_CODE]: undefined,
        [A2AMetadataKeys.ERROR_MESSAGE]: undefined,
        [A2AMetadataKeys.CITATION_METADATA]: undefined,
        [A2AMetadataKeys.GROUNDING_METADATA]: undefined,
        [A2AMetadataKeys.USAGE_METADATA]: undefined,
        [A2AMetadataKeys.CUSTOM_METADATA]: undefined,
        [A2AMetadataKeys.PARTIAL]: undefined,
        [A2AMetadataKeys.ESCALATE]: undefined,
        [A2AMetadataKeys.TRANSFER_TO_AGENT]: undefined,
        [A2AMetadataKeys.IS_LONG_RUNNING]: false,
      });
    });
  });

  describe('toA2AContextId', () => {
    it('joins the prefix and the session fields with the separator', () => {
      const parts: A2AContextIdParts = {
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
      };
      expect(ADK_CONTEXT_ID_PREFIX).toBe('ADK');
      expect(ADK_CONTEXT_ID_SEPARATOR).toBe('/');
      expect(toA2AContextId(parts)).toBe('ADK/test-app/test-user/test-session');
    });

    it.each([
      {field: 'appName', parts: {appName: '', userId: 'u', sessionId: 's'}},
      {field: 'userId', parts: {appName: 'a', userId: '', sessionId: 's'}},
      {field: 'sessionId', parts: {appName: 'a', userId: 'u', sessionId: ''}},
    ])('throws when $field is empty', ({parts}) => {
      expect(() => toA2AContextId(parts)).toThrow(
        'All parameters (appName, userId, sessionId) must be non-empty',
      );
    });

    it('percent-encodes special characters in each field', () => {
      expect(
        toA2AContextId({
          appName: 'test-app@2024',
          userId: 'user_123',
          sessionId: 'session-456',
        }),
      ).toBe('ADK/test-app%402024/user_123/session-456');
    });
  });

  describe('fromA2AContextId', () => {
    it('parses a well-formed context id', () => {
      expect(fromA2AContextId('ADK/test-app/test-user/test-session')).toEqual({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
      });
    });

    it('parses fields that contain unreserved special characters', () => {
      expect(
        fromA2AContextId('ADK/test-app@2024/user_123/session-456'),
      ).toEqual({
        appName: 'test-app@2024',
        userId: 'user_123',
        sessionId: 'session-456',
      });
    });

    it.each([
      {name: 'a missing context id', contextId: undefined},
      {name: 'an empty context id', contextId: ''},
      {
        name: 'an invalid prefix',
        contextId: 'INVALID/test-app/test-user/test-session',
      },
      {name: 'too few segments', contextId: 'ADK/test-app/test-user'},
      {
        name: 'too many segments',
        contextId: 'ADK/test-app/test-user/test-session/extra',
      },
      {name: 'an empty field', contextId: 'ADK//test-user/test-session'},
      {
        name: 'a different separator',
        contextId: 'ADK-test-app-test-user-test-session',
      },
      {name: 'a field that decodes to empty', contextId: 'ADK/a/u/'},
      {name: 'malformed percent-encoding', contextId: 'ADK/%zz/u/s'},
    ])('returns undefined for $name', ({contextId}) => {
      expect(fromA2AContextId(contextId)).toBeUndefined();
    });
  });

  describe('context id round trip', () => {
    it.each([
      {appName: 'test-app', userId: 'test-user', sessionId: 'test-session'},
      {appName: 'app', userId: 'user', sessionId: 'projects/p/sessions/s'},
      {
        appName: 'app',
        userId: 'projects/p/subscriptions/sub',
        sessionId: 'session',
      },
      {appName: 'apps/a/versions/v', userId: 'user', sessionId: 'session'},
      {appName: 'app', userId: 'user', sessionId: 'a/b/c'},
      {appName: 'app%41', userId: 'user', sessionId: '100%'},
    ])(
      'returns the original fields for $appName, $userId, $sessionId',
      (parts) => {
        expect(fromA2AContextId(toA2AContextId(parts))).toEqual(parts);
      },
    );
  });
});
