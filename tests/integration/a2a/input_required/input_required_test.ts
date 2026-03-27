/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event as AdkEvent, InMemoryRunner, RemoteA2AAgent} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {AdkTsApiServer} from '../../test_api_server.js';

const TEST_TIMEOUT = 30000;

describe('A2A: RemoteAgent InputRequired', () => {
  let server: AdkTsApiServer;

  beforeAll(async () => {
    server = new AdkTsApiServer({
      agentsDir: path.join(__dirname, 'test_agents'),
      a2a: true,
      startFailureTimeout: TEST_TIMEOUT,
    });
    await server.start();
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await server.stop();
  });

  it('Long-running tool', async () => {
    const approvalToolName = 'request_approval';
    const toolCallId = 'call-123';
    const modelTextTaskComplete = 'Task complete!';
    const remoteAgent = new RemoteA2AAgent({
      name: 'long_running_tool',
      agentCard: `${server.url}/a2a/long_running_tool/`,
    });

    const runner = new InMemoryRunner({
      agent: remoteAgent,
      appName: 'caller',
    });
    const session = await runner.sessionService.createSession({
      appName: 'caller',
      userId: 'caller-user',
    });

    const events: AdkEvent[] = [];
    for await (const ev of runner.runAsync({
      userId: 'caller-user',
      sessionId: session.id,
      newMessage: createUserContent('Do something'),
    })) {
      events.push(ev);
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    const inputReqEvent = events[events.length - 1];

    expect(inputReqEvent.longRunningToolIds).toContain(toolCallId);

    const hasToolCall = inputReqEvent.content?.parts?.some(
      (p) => p.functionCall?.name === approvalToolName,
    );
    expect(hasToolCall).toBe(true);

    const events2: AdkEvent[] = [];
    for await (const ev of runner.runAsync({
      userId: 'caller-user',
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [
          {text: 'Approved'},
          {
            functionResponse: {
              name: approvalToolName,
              response: {status: 'approved'},
              id: toolCallId,
            },
          },
        ],
      },
    })) {
      events2.push(ev);
    }

    expect(events2.length).toBeGreaterThanOrEqual(1);
    const finalEvent = events2[events2.length - 1];
    const hasCompleteText = finalEvent.content?.parts?.some(
      (p) => p.text === modelTextTaskComplete,
    );
    expect(hasCompleteText).toBe(true);
  });

  it('Tool confirmation', async () => {
    const confirmationCallName = 'adk_request_confirmation';
    const confirmationCallId = 'confirm-xyz';
    const modelTextTaskComplete = 'Ticket created!';
    const remoteAgent = new RemoteA2AAgent({
      name: 'tool_confirmation',
      agentCard: `${server.url}/a2a/tool_confirmation/`,
    });

    const runner = new InMemoryRunner({
      agent: remoteAgent,
      appName: 'caller',
    });
    const session = await runner.sessionService.createSession({
      appName: 'caller',
      userId: 'caller-user',
    });

    const events: AdkEvent[] = [];
    for await (const ev of runner.runAsync({
      userId: 'caller-user',
      sessionId: session.id,
      newMessage: createUserContent('Create a ticket'),
    })) {
      events.push(ev);
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    const inputReqEvent = events[events.length - 1];
    expect(inputReqEvent.longRunningToolIds).toContain(confirmationCallId);

    const events2: AdkEvent[] = [];
    for await (const ev of runner.runAsync({
      userId: 'caller-user',
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: confirmationCallName,
              response: {confirmed: true},
              id: confirmationCallId,
            },
          },
        ],
      },
    })) {
      events2.push(ev);
    }

    expect(events2.length).toBeGreaterThanOrEqual(1);
    const finalEvent = events2[events2.length - 1];
    const hasCompleteText = finalEvent.content?.parts?.some(
      (p) => p.text === modelTextTaskComplete,
    );
    expect(hasCompleteText).toBe(true);
  });

  it('Remote Agent -> Remote Agent -> ADK Agent', async () => {
    const approvalToolName = 'request_approval';
    const toolCallId = 'call-hop';
    const modelTextTaskComplete = 'Hop B complete!';
    const remoteAgentA = new RemoteA2AAgent({
      name: 'multi_hop_remote_agent',
      agentCard: `${server.url}/a2a/multi_hop_remote_agent/`,
    });

    const runner = new InMemoryRunner({
      agent: remoteAgentA,
      appName: 'caller',
    });
    const session = await runner.sessionService.createSession({
      appName: 'caller',
      userId: 'caller-user',
    });

    const events: AdkEvent[] = [];
    for await (const ev of runner.runAsync({
      userId: 'caller-user',
      sessionId: session.id,
      newMessage: createUserContent('Do root task'),
    })) {
      events.push(ev);
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    const inputReqEvent = events[events.length - 1];
    expect(inputReqEvent.longRunningToolIds).toContain(toolCallId);

    const events2: AdkEvent[] = [];
    for await (const ev of runner.runAsync({
      userId: 'caller-user',
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: approvalToolName,
              response: {status: 'approved'},
              id: toolCallId,
            },
          },
        ],
      },
    })) {
      events2.push(ev);
    }

    expect(events2.length).toBeGreaterThanOrEqual(1);
    const finalEvent = events2[events2.length - 1];
    expect(
      finalEvent.content?.parts?.some((p) => p.text === modelTextTaskComplete),
    ).toBe(true);
  });
});
