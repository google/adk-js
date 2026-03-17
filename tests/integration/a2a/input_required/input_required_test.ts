/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event as AdkEvent,
  createEvent,
  InvocationContext,
  RemoteA2AAgent,
  Session,
} from '@google/adk';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {createTestApiServer, TestAdkApiServer} from '../../test_api_server.js';

describe('A2A: RemoteAgent InputRequired', () => {
  let server: TestAdkApiServer;

  beforeAll(async () => {
    server = createTestApiServer({
      agentsDir: path.join(__dirname, 'test_agents'),
      a2a: true,
    });
    await server.start();
  });

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

    const clientCtx = {
      session: {
        appName: 'caller',
        userId: 'caller-user',
        id: 'context-1',
        events: [
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'Do something'}]},
          }),
        ],
      } as unknown as Session,
      invocationId: 'invoke-1',
    } as unknown as InvocationContext;

    const events: AdkEvent[] = [];
    for await (const ev of remoteAgent.runAsync(clientCtx)) {
      events.push(ev);
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    const inputReqEvent = events[events.length - 1];

    expect(inputReqEvent.longRunningToolIds).toContain(toolCallId);

    const hasToolCall = inputReqEvent.content?.parts?.some(
      (p) => p.functionCall?.name === approvalToolName,
    );
    expect(hasToolCall).toBe(true);

    clientCtx.session.events.push(
      createEvent({
        author: 'user',
        content: {
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
      }),
    );

    const events2: AdkEvent[] = [];
    for await (const ev of remoteAgent.runAsync(clientCtx)) {
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

    const clientCtx = {
      session: {
        appName: 'caller',
        userId: 'caller-user',
        id: 'context-2',
        events: [
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'Create a ticket'}]},
          }),
        ],
      } as unknown as Session,
      invocationId: 'invoke-2',
    } as unknown as InvocationContext;

    const events: AdkEvent[] = [];
    for await (const ev of remoteAgent.runAsync(clientCtx)) {
      events.push(ev);
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    const inputReqEvent = events[events.length - 1];
    expect(inputReqEvent.longRunningToolIds).toContain(confirmationCallId);

    clientCtx.session.events.push(
      createEvent({
        author: 'user',
        content: {
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
      }),
    );

    const events2: AdkEvent[] = [];
    for await (const ev of remoteAgent.runAsync(clientCtx)) {
      events2.push(ev);
    }

    expect(events2.length).toBeGreaterThanOrEqual(1);
    const finalEvent = events2[events2.length - 1];
    const hasCompleteText = finalEvent.content?.parts?.some(
      (p) => p.text === modelTextTaskComplete,
    );
    expect(hasCompleteText).toBe(true);
  });

  it('MultiHop', async () => {
    const approvalToolName = 'request_approval';
    const toolCallId = 'call-hop';
    const modelTextTaskComplete = 'Hop B complete!';
    const remoteAgentA = new RemoteA2AAgent({
      name: 'multi_hop_remote_agent',
      agentCard: `${server.url}/a2a/multi_hop_remote_agent/`,
    });

    const clientCtx = {
      session: {
        appName: 'caller',
        userId: 'caller-user',
        id: 'context-3',
        events: [
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'Do root task'}]},
          }),
        ],
      } as unknown as Session,
      invocationId: 'invoke-3',
    } as unknown as InvocationContext;

    const events: AdkEvent[] = [];
    for await (const ev of remoteAgentA.runAsync(clientCtx)) {
      events.push(ev);
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    const inputReqEvent = events[events.length - 1];
    expect(inputReqEvent.longRunningToolIds).toContain(toolCallId);

    clientCtx.session.events.push(
      createEvent({
        author: 'user',
        content: {
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
      }),
    );

    const events2: AdkEvent[] = [];
    for await (const ev of remoteAgentA.runAsync(clientCtx)) {
      events2.push(ev);
    }

    expect(events2.length).toBeGreaterThanOrEqual(1);
    const finalEvent = events2[events2.length - 1];
    expect(
      finalEvent.content?.parts?.some((p) => p.text === modelTextTaskComplete),
    ).toBe(true);
  });
});
