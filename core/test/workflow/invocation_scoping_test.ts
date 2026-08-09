/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {resolveResumedInvocationId, Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {createRequestInputEvent} from '../../src/workflow/utils/hitl_utils.js';
import {reconstructNodeStatesByPath} from '../../src/workflow/utils/rehydration_utils.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {WorkflowAgent} from '../../src/workflow/workflow_agent.js';

describe('rehydration — invocation scoping', () => {
  it('does not reuse a completed node from a different invocation', () => {
    const events = [
      createEvent({
        author: 'authorize',
        invocationId: 'inv-a',
        nodeInfo: {path: 'wf.authorize@1'},
        output: {authorized: true},
      }),
    ];

    // Same session, a later invocation: the earlier node must not be visible.
    expect(
      reconstructNodeStatesByPath(events, 'inv-b').get('wf.authorize@1'),
    ).toBeUndefined();

    // Its own invocation still sees it, which is what resume relies on.
    expect(
      reconstructNodeStatesByPath(events, 'inv-a').get('wf.authorize@1')
        ?.output,
    ).toEqual({authorized: true});

    // Omitting the invocation id keeps the unscoped utility behaviour.
    expect(
      reconstructNodeStatesByPath(events).get('wf.authorize@1')?.output,
    ).toEqual({authorized: true});
  });

  it('re-runs a node in a new invocation on the same session', async () => {
    let authorized = true;
    let authChecks = 0;
    let sinkRuns = 0;

    const authorize = node(
      (_ctx: NodeContext, _input: unknown) => {
        authChecks++;
        if (!authorized) {
          throw new Error('NOT_AUTHORIZED');
        }
        return {authorized: true};
      },
      {name: 'authorize'},
    );

    const workflow = new Workflow({
      name: 'gated_workflow',
      dynamicEntry: async (ctx: NodeContext, input: unknown) => {
        await ctx.runNode(authorize, input);
        sinkRuns++;
        return 'done';
      },
    });

    const sessions = new InMemorySessionService();
    const runner = new Runner({
      appName: 'app',
      agent: new WorkflowAgent(workflow),
      sessionService: sessions,
    });
    const session = await sessions.createSession({appName: 'app', userId: 'u'});

    const runTurn = async (text: string) => {
      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: 'u',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text}]},
      })) {
        events.push(event);
      }
      return events;
    };

    await runTurn('first');
    expect(authChecks).toBe(1);
    expect(sinkRuns).toBe(1);

    // The caller keeps the session but loses the entitlement. A second message
    // is a new invocation, so the gate must run again rather than being
    // fast-forwarded from the first invocation's cached output.
    authorized = false;
    await expect(runTurn('second')).rejects.toThrow('NOT_AUTHORIZED');
    expect(authChecks).toBe(2);
    expect(sinkRuns).toBe(1);
  });
});

describe('runner — resumed invocation id', () => {
  it('adopts the invocation that raised the interrupt being answered', () => {
    const events = [
      createRequestInputEvent(
        new RequestInput({interruptId: 'gate-1', message: '?'}),
        'inv-a',
      ),
    ];
    const resumed = resolveResumedInvocationId(events, {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'gate-1',
            name: 'adk_request_input',
            response: {},
          },
        },
      ],
    });
    expect(resumed).toBe('inv-a');
  });

  it('adopts the invocation still waiting on an unanswered interrupt', () => {
    const events = [
      createRequestInputEvent(
        new RequestInput({interruptId: 'gate-1', message: '?'}),
        'inv-a',
      ),
    ];
    // A plain-text reply carries no function response, but there is exactly one
    // pending interrupt to continue.
    expect(
      resolveResumedInvocationId(events, {
        role: 'user',
        parts: [{text: 'yes'}],
      }),
    ).toBe('inv-a');
  });

  it('starts a new invocation when nothing is pending', () => {
    const events = [
      createEvent({author: 'a', invocationId: 'inv-a', output: 'done'}),
    ];
    expect(
      resolveResumedInvocationId(events, {role: 'user', parts: [{text: 'hi'}]}),
    ).toBeUndefined();
  });

  it('starts a new invocation once every interrupt has been answered', () => {
    const events = [
      createRequestInputEvent(
        new RequestInput({interruptId: 'gate-1', message: '?'}),
        'inv-a',
      ),
      createEvent({
        author: 'user',
        invocationId: 'inv-a',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'gate-1',
                name: 'adk_request_input',
                response: {result: 'ok'},
              },
            },
          ],
        },
      }),
    ];
    expect(
      resolveResumedInvocationId(events, {
        role: 'user',
        parts: [{text: 'next'}],
      }),
    ).toBeUndefined();
  });
});
