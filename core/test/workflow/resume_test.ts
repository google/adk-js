/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {z} from 'zod/v4';
import {
  createEvent,
  Event,
  transformToCamelCaseEvent,
  transformToSnakeCaseEvent,
} from '../../src/events/event.js';
import {createEventActions} from '../../src/events/event_actions.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {
  createRequestInputEvent,
  hasRequestInputFunctionCall,
} from '../../src/workflow/utils/hitl_utils.js';
import {
  isFastForwardable,
  reconstructNodeStates,
} from '../../src/workflow/utils/rehydration_utils.js';
import {Workflow} from '../../src/workflow/workflow.js';

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

  describe('a reply checked against the schema its interrupt declared', () => {
    /** An interrupt that asked for `{userResponse: string}`, and a reply to it. */
    function eventsWithReply(response: Record<string, unknown>): Event[] {
      const interrupt = createRequestInputEvent(
        new RequestInput({
          interruptId: 'gate-1',
          responseSchema: z.object({userResponse: z.string()}),
        }),
      );
      interrupt.author = 'gate';
      interrupt.nodeInfo = {path: 'wf.gate'};
      return [
        interrupt,
        createEvent({
          author: 'user',
          content: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'gate-1',
                  name: 'adk_request_input',
                  response,
                },
              },
            ],
          },
        }),
      ];
    }

    it('resolves a reply in the declared shape', () => {
      const states = reconstructNodeStates(
        eventsWithReply({userResponse: 'yes'}),
      );

      expect(states.get('gate')?.resolvedResponses.get('gate-1')).toEqual({
        userResponse: 'yes',
      });
    });

    it('resolves a free-text reply wrapped as {result: …}', () => {
      const states = reconstructNodeStates(
        eventsWithReply({result: 'museum and lunch'}),
      );

      expect(states.get('gate')?.resolvedResponses.get('gate-1')).toBe(
        'museum and lunch',
      );
    });

    it('rejects the wrong envelope instead of passing it to the next node', () => {
      // `{response: x}` is not the `{result: x}` envelope, so it is not
      // unwrapped; before this check it reached the successor whole and
      // surfaced downstream as a stringified "[object Object]".
      expect(() =>
        reconstructNodeStates(eventsWithReply({response: '21'})),
      ).toThrow(/reply to interrupt 'gate-1' does not match/i);
    });

    describe('after a rejected reply', () => {
      /** A rejected reply, followed by whatever the user tried next. */
      function eventsWithRetry(retry: Event): Event[] {
        return [...eventsWithReply({response: '21'}), retry];
      }

      it('stops rejecting once the turn that carried it has passed', () => {
        // The reply stays in the session for good. Re-throwing on every replay
        // is what used to make one malformed answer end the session.
        const retry = createEvent({
          author: 'user',
          content: {role: 'user', parts: [{text: 'museum and lunch'}]},
        });

        expect(() =>
          reconstructNodeStates(eventsWithRetry(retry)),
        ).not.toThrow();
      });

      it('leaves the interrupt unresolved, so the next answer still lands', () => {
        const retry = createEvent({
          author: 'user',
          content: {role: 'user', parts: [{text: 'museum and lunch'}]},
        });

        const gate = reconstructNodeStates(eventsWithRetry(retry)).get('gate');

        expect(gate?.interruptIds.has('gate-1')).toBe(true);
        expect(gate?.resolvedResponses.has('gate-1')).toBe(false);
      });

      it('accepts a corrected structured reply for the same interrupt', () => {
        const retry = createEvent({
          author: 'user',
          content: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'gate-1',
                  name: 'adk_request_input',
                  response: {userResponse: 'museum and lunch'},
                },
              },
            ],
          },
        });

        const states = reconstructNodeStates(eventsWithRetry(retry));

        expect(states.get('gate')?.resolvedResponses.get('gate-1')).toEqual({
          userResponse: 'museum and lunch',
        });
      });
    });
  });

  it('recovers structured output and interrupt input after a DB serialization round-trip', () => {
    const events: Event[] = [
      createEvent({
        author: 'lookup',
        nodeInfo: {path: 'wf.lookup'},
        output: {cityName: 'Paris', timeInfo: '10:10 AM'},
      }),
      createEvent({
        author: 'gate',
        nodeInfo: {path: 'wf.gate'},
        longRunningToolIds: ['gate-1'],
        // The engine stashes the waiting node's original input here so it
        // re-runs with it on resume (see node_runner runOnce).
        actions: createEventActions({
          agentState: {input: {userId: 42, requestedItems: ['a', 'b']}},
        }),
      }),
    ];

    // Simulate what a persistent (DB/Vertex) session store does on write+read:
    // snake_case on save, camelCase on load. Without the preserve-list fix this
    // mangles the arbitrary output/agentState keys.
    const persisted = events.map(
      (e) => transformToCamelCaseEvent(transformToSnakeCaseEvent(e)) as Event,
    );

    const states = reconstructNodeStates(persisted);
    expect(states.get('lookup')?.output).toEqual({
      cityName: 'Paris',
      timeInfo: '10:10 AM',
    });
    expect(states.get('gate')?.input).toEqual({
      userId: 42,
      requestedItems: ['a', 'b'],
    });
  });

  it('scopes reconstruction to direct children so nested same-named nodes do not collide', () => {
    const events: Event[] = [
      createEvent({nodeInfo: {path: 'root.process'}, output: 'OUTER'}),
      createEvent({nodeInfo: {path: 'root.inner.process'}, output: 'INNER'}),
    ];
    const outer = reconstructNodeStates(events, 'root');
    const inner = reconstructNodeStates(events, 'root.inner');
    expect(outer.get('process')?.output).toBe('OUTER');
    expect(inner.get('process')?.output).toBe('INNER');
    // The outer scope must not absorb the nested (grandchild) node.
    expect(outer.size).toBe(1);
  });

  it('keys by leaf name when no parent path is given (utility mode)', () => {
    const events: Event[] = [
      createEvent({nodeInfo: {path: 'wf.a'}, output: 'A'}),
    ];
    expect(reconstructNodeStates(events).get('a')?.output).toBe('A');
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
    // A single-node HITL gate that RE-RUNS on resume to read its answer from
    // ctx.resumeInputs. In the faithful (Python) model this is rerun_on_resume=
    // true; the default (false) is the two-node pattern where the node does not
    // re-run and its output becomes the resume value.
    const gate = node(
      (ctx: NodeContext, input: unknown) => {
        const answer = ctx.resumeInputs['gate-1'];
        if (answer === undefined) {
          return new RequestInput({interruptId: 'gate-1', message: 'approve?'});
        }
        return `${input}|${answer}`;
      },
      {name: 'gate', rerunOnResume: true},
    );
    const c = node((_c: NodeContext, input: unknown) => `C(${input})`, {
      name: 'c',
    });
    const wf = new Workflow({
      name: 'resume_wf',
      edges: [['START', a, gate, c]],
    });

    const agent = wf;
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
