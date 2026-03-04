/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Message, Task} from '@a2a-js/sdk';
import {Event as AdkEvent, createEventActions} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  A2AMetadataKeys,
  AdkMetadataKeys,
  getA2AEventMetadata,
  getAdkEventMetadata,
} from '../../src/a2a/metadata_converter_utils.js';

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
        errorMessage: 'Something went wrong',
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
        [A2AMetadataKeys.ERROR_CODE]: 'Something went wrong',
        [A2AMetadataKeys.ERROR_MESSAGE]: 'Something went wrong',
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
});
