/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {hasRequestInputFunctionCall} from '../../src/workflow/utils/hitl_utils.js';
import {
  isFastForwardable,
  reconstructNodeStates,
} from '../../src/workflow/utils/rehydration_utils.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {WorkflowAgent} from '../../src/workflow/workflow_agent.js';

describe('Phase 5b — rehydration utility', () => {
  it('reconstructs completed outputs and unresolved interrupts', () => {
    const events: Event[] = [
      createEvent({author: 'a', nodeInfo: {path: 'wf.a'}, output: 'A(x)'}),
      createEvent({
        author: 'gate',
        nodeInfo: {path: 'wf.gate'},
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'adk_request_input', id: 'gate-1'}}],
        },
        longRunningToolIds: ['gate-1'],
      }),
    ];
    const states = reconstructNodeStates(events);

    expect(states.get('a')?.output).toBe('A(x)');
    expect(isFastForwardable(states.get('a')!)).toBe(true);
    expect([...states.get('gate')!.interruptIds]).toEqual(['gate-1']);
    // gate has no output and an unresolved interrupt -> not fast-forwardable.
    expect(isFastForwardable(states.get('gate')!)).toBe(false);
  });

  it('resolves an interrupt from a user function response', () => {
    const events: Event[] = [
      createEvent({
        author: 'gate',
        nodeInfo: {path: 'wf.gate'},
        longRunningToolIds: ['gate-1'],
      }),
      createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'gate-1',
                name: 'adk_request_input',
                response: {result: 'approved'},
              },
            },
          ],
        },
      }),
    ];
    const states = reconstructNodeStates(events);
    expect(states.get('gate')?.resolvedResponses.get('gate-1')).toBe(
      'approved',
    );
  });
});

describe('Phase 5b — HITL resume via the Runner', () => {
  it('resumes an interrupted workflow without re-running completed nodes', async () => {
    let aRuns = 0;
    const a = node(
      (_c: NodeContext, input: unknown) => {
        aRuns++;
        return `A(${input})`;
      },
      {name: 'a'},
    );
    const gate = node(
      (ctx: NodeContext, input: unknown) => {
        const answer = ctx.resumeInputs['gate-1'];
        if (answer === undefined) {
          return new RequestInput({interruptId: 'gate-1', message: 'approve?'});
        }
        return `${input}|${answer}`;
      },
      {name: 'gate'},
    );
    const c = node((_c: NodeContext, input: unknown) => `C(${input})`, {
      name: 'c',
    });
    const wf = new Workflow({
      name: 'resume_wf',
      edges: [['START', a, gate, c]],
    });

    const agent = new WorkflowAgent(wf);
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u1',
    });
    const runner = new Runner({appName: 'test_app', agent, sessionService});

    // --- Turn 1: run until the gate interrupts ---
    const turn1: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'u1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'x'}]},
    })) {
      turn1.push(event);
    }
    expect(aRuns).toBe(1);
    expect(turn1.some(hasRequestInputFunctionCall)).toBe(true);
    // c must not have produced output yet.
    expect(turn1.some((e) => e.output === 'C(A(x)|approved)')).toBe(false);

    // --- Turn 2: provide the interrupt response and resume ---
    const turn2: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'u1',
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'gate-1',
              name: 'adk_request_input',
              response: {result: 'approved'},
            },
          },
        ],
      },
    })) {
      turn2.push(event);
    }

    // A was fast-forwarded (cached), NOT re-executed.
    expect(aRuns).toBe(1);
    // The workflow resumed through the gate and completed at c.
    expect(turn2.some((e) => e.output === 'C(A(x)|approved)')).toBe(true);
  });
});
