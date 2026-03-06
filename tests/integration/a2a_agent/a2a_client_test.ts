/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Message,
  MessageSendParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {Client, ClientFactory} from '@a2a-js/sdk/client';
import * as crypto from 'crypto';
import * as path from 'path';
import {describe, it} from 'vitest';
import {createTestApiServer, TestAdkApiServer} from '../test_api_server.js';

type A2AEvent =
  | Message
  | Task
  | TaskStatusUpdateEvent
  | TaskArtifactUpdateEvent;

function createA2AClient(
  server: TestAdkApiServer,
  agentName: string,
): Promise<Client> {
  const factory = new ClientFactory();

  return factory.createFromUrl(
    `http://${server.host}:${server.port}/a2a/${agentName}/`,
  );
}

describe('ADK Agent served in A2A mode', () => {
  let adkApiServer: TestAdkApiServer;

  beforeAll(async () => {
    adkApiServer = createTestApiServer({
      agentsDir: path.join(__dirname, 'agents'),
      a2a: true,
    });
    await adkApiServer.start();
  });

  afterAll(async () => {
    await adkApiServer.stop();
  });

  it('should execute agent and get response', async () => {
    const client = await createA2AClient(adkApiServer, 'weather_time_agent');
    const message: MessageSendParams = {
      message: {
        messageId: crypto.randomUUID(),
        role: 'user',
        parts: [{kind: 'text', text: 'Hello, what is weather in New York?'}],
        kind: 'message',
      },
    };

    const response = await client.sendMessage(message);
    expect(response).toBe({
      'contextId': 'e3db15d2-0fc3-4243-b2bf-c1776ebc3f66',
      'history': [
        {
          'contextId': 'e3db15d2-0fc3-4243-b2bf-c1776ebc3f66',
          'kind': 'message',
          'messageId': '4a353ae6-5d97-4ae6-b267-992b736b2be3',
          'parts': [
            {
              'kind': 'text',
              'text': 'Hello, what is weather in New York?',
            },
          ],
          'role': 'user',
          'taskId': 'c5c99ac8-8654-46db-a8aa-efade27034df',
        },
      ],
      'id': '2b6176d3-f9bd-4a87-ba11-a37618738745',
      'kind': 'task',
      'status': {
        'state': 'submitted',
        'timestamp': '2026-03-06T01:31:02.834Z',
      },
    });
  });

  it('should execute agent and get stream response', async () => {
    const client = await createA2AClient(adkApiServer, 'weather_time_agent');

    const message: MessageSendParams = {
      message: {
        messageId: crypto.randomUUID(),
        role: 'user',
        parts: [{kind: 'text', text: 'Hello, what is weather in New York?'}],
        kind: 'message',
      },
    };

    const a2aEvents: A2AEvent[] = [];
    const stream = client.sendMessageStream(message);
    for await (const a2aEvent of stream) {
      a2aEvents.push(a2aEvent);
    }

    expect(a2aEvents.length).toBe(5);
  });
});
