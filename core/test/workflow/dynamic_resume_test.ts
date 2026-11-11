/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {
  getRequestInputInterruptIds,
  hasRequestInputFunctionCall,
} from '../../src/workflow/utils/hitl_utils.js';
import {Workflow} from '../../src/workflow/workflow.js';

async function collect(gen: AsyncGenerator<Event>): Promise<Event[]> {
  const out: Event[] = [];
  for await (const e of gen) {
    out.push(e);
  }
  return out;
}

describe('Phase 5b-cont — dynamic (ctx.runNode) resume via the Runner', () => {
  it('dedups a completed dynamic node and resumes a waiting one', async () => {
    let stepRuns = 0;
    let askRuns = 0;

    const step = new FunctionNode('step', (_c, input) => {
      stepRuns++;
      return `step(${input})`;
    });
    // Re-entry HITL node: it re-runs on resume and consumes the reply itself,
    // so it must declare `rerunOnResume: true`. With the default (false) the
    // scheduler completes it with the raw reply as its output instead (the
    // handoff form), exactly like a static graph node — see the handoff test
    // below.
    const ask = new FunctionNode(
      'ask',
      (ctx: NodeContext) => {
        askRuns++;
        const answer = ctx.resumeInputs['confirm'];
        if (answer === undefined) {
          return new RequestInput({
            interruptId: 'confirm',
            message: 'confirm?',
          });
        }
        return `confirmed:${answer}`;
      },
      {rerunOnResume: true},
    );

    // Imperative workflow: run `step` (completes), then `ask` (interrupts).
    const wf = new Workflow({
      name: 'dyn_resume_wf',
      dynamicEntry: async (ctx, input) => {
        const s = await ctx.runNode(step, input);
        const a = await ctx.runNode(ask);
        return {step: s.output, ask: a.output};
      },
    });

    const agent = wf;
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u1',
    });
    const runner = new Runner({appName: 'test_app', agent, sessionService});

    // Turn 1: step runs, ask interrupts.
    const turn1 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'x'}]},
      }),
    );
    expect(stepRuns).toBe(1);
    expect(turn1.some(hasRequestInputFunctionCall)).toBe(true);

    // Turn 2: provide the confirmation and resume.
    const turn2 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'confirm',
                name: 'adk_request_input',
                response: {result: 'yes'},
              },
            },
          ],
        },
      }),
    );

    // `step` was fast-forwarded (cached) -> NOT re-executed.
    expect(stepRuns).toBe(1);
    // `ask` re-ran with the resolved resume input and completed.
    expect(askRuns).toBe(2);
    expect(turn2.some((e) => e.output === 'step(x)')).toBe(false);
    expect(turn2.some((e) => e.output === 'confirmed:yes')).toBe(true);
  });

  it('replays a completed rerun-on-resume child instead of running it again', async () => {
    // `rerunOnResume` says what to do with an interrupt the child is still
    // waiting on, not that a run which already produced its output should
    // happen again. The static graph replays such a node (`resume_loopback_
    // test.ts`); a child reached through `ctx.runNode()` must agree.
    let stepRuns = 0;
    let askRuns = 0;

    const step = new FunctionNode(
      'step',
      (_c, input) => {
        stepRuns++;
        return `step(${input})`;
      },
      {rerunOnResume: true},
    );
    const ask = new FunctionNode(
      'ask',
      (ctx: NodeContext) => {
        askRuns++;
        const answer = ctx.resumeInputs['confirm'];
        return answer === undefined
          ? new RequestInput({interruptId: 'confirm', message: 'confirm?'})
          : `confirmed:${answer}`;
      },
      {rerunOnResume: true},
    );

    const wf = new Workflow({
      name: 'dyn_replay_wf',
      dynamicEntry: async (ctx, input) => {
        const s = await ctx.runNode(step, input);
        const a = await ctx.runNode(ask);
        return {step: s.output, ask: a.output};
      },
    });

    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u1',
    });
    const runner = new Runner({appName: 'test_app', agent: wf, sessionService});

    await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'x'}]},
      }),
    );
    expect(stepRuns).toBe(1);

    const turn2 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'confirm',
                name: 'adk_request_input',
                response: {result: 'yes'},
              },
            },
          ],
        },
      }),
    );

    // Completed last turn, so it is replayed from its cached output even
    // though it asked to rerun on resume.
    expect(stepRuns).toBe(1);
    expect(askRuns).toBe(2);
    expect(turn2.some((e) => e.output === 'confirmed:yes')).toBe(true);
  });

  it('hands the resume value to a rerunOnResume=false child without re-running it', async () => {
    let askRuns = 0;

    // Handoff HITL node: it just raises the interrupt (with a framework-issued
    // id) and relies on `rerunOnResume: false` to be completed with the reply
    // as its output. Before the handoff existed this re-ran on every turn,
    // minting a fresh interrupt id each time, so the workflow never resumed.
    const ask = new FunctionNode(
      'ask',
      async function* () {
        askRuns++;
        yield new RequestInput({message: 'confirm?'});
      },
      {rerunOnResume: false},
    );

    const wf = new Workflow({
      name: 'dyn_handoff_wf',
      dynamicEntry: async (ctx, input) => {
        const a = await ctx.runNode(ask, input);
        // `ctx.runNode()` resolves (rather than throwing) while the child is
        // still interrupted, so the caller must check before using `output`.
        if (a.interruptIds.length > 0) {
          return undefined;
        }
        return `decided:${String(a.output).trim().toLowerCase()}`;
      },
    });

    const agent = wf;
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u1',
    });
    const runner = new Runner({appName: 'test_app', agent, sessionService});

    const turn1 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'ship it'}]},
      }),
    );
    expect(askRuns).toBe(1);
    expect(turn1.some(hasRequestInputFunctionCall)).toBe(true);

    // Reply in plain text: the single pending interrupt is unambiguous.
    const turn2 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'yes'}]},
      }),
    );

    // The child did NOT re-run, and no second interrupt was raised.
    expect(askRuns).toBe(1);
    expect(turn2.some(hasRequestInputFunctionCall)).toBe(false);
    expect(turn2.some((e) => e.output === 'decided:yes')).toBe(true);
  });

  it("answers a graph node's dynamic child from a structured reply", async () => {
    // The shape `samples/workflows/dynamic/human_input` has: a graph node
    // driving an interactive child through `ctx.runNode`, so the interrupt is
    // raised a level below the workflow's own children. The workflow's
    // rehydrated view is keyed to its DIRECT children, so a reply addressed to
    // that deeper interrupt used to be dropped — the child re-ran, minted a
    // fresh interrupt id, and asked again on every turn. Plain text got
    // through (it is mapped to the pending interrupt by the agent), which is
    // why the handoff test above did not catch this.
    let askRuns = 0;

    const ask = new FunctionNode(
      'get_user_approval',
      () => {
        askRuns++;
        return new RequestInput({message: 'Please approve this request'});
      },
      {rerunOnResume: false},
    );

    const handle = new FunctionNode(
      'handle_process',
      async (ctx: NodeContext, input: unknown) => {
        const approval = await ctx.runNode(ask, input);
        if (approval.interruptIds.length > 0) {
          return undefined;
        }
        return String(approval.output).trim().toLowerCase() === 'yes'
          ? 'Approved'
          : 'Denied';
      },
      {rerunOnResume: true},
    );

    const agent = new Workflow({
      name: 'root_agent',
      edges: [['START', handle]],
    });
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u1',
    });
    const runner = new Runner({appName: 'test_app', agent, sessionService});

    const turn1 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'delete the database'}]},
      }),
    );
    const [interruptId] = turn1.flatMap(getRequestInputInterruptIds);
    expect(interruptId).toBeDefined();

    // Answer that interrupt by id, the way a UI does.
    const turn2 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: interruptId,
                name: 'adk_request_input',
                response: {result: 'yes'},
              },
            },
          ],
        },
      }),
    );

    expect(askRuns).toBe(1);
    expect(turn2.some(hasRequestInputFunctionCall)).toBe(false);
    expect(turn2.some((e) => e.output === 'Approved')).toBe(true);
  });

  it('hands back a fast-forwarded run when the same run id is asked for twice', async () => {
    let stepRuns = 0;
    const outputs: unknown[] = [];

    const step = new FunctionNode('step', (_c, input) => {
      stepRuns++;
      return `step(${input})`;
    });
    const ask = new FunctionNode(
      'ask',
      (ctx: NodeContext) => {
        const answer = ctx.resumeInputs['confirm'];
        return answer === undefined
          ? new RequestInput({interruptId: 'confirm', message: 'confirm?'})
          : `confirmed:${answer}`;
      },
      {rerunOnResume: true},
    );

    const wf = new Workflow({
      name: 'dyn_same_run_id_wf',
      dynamicEntry: async (ctx, input) => {
        const first = await ctx.runNode(step, input, {runId: 'once'});
        const second = await ctx.runNode(step, input, {runId: 'once'});
        outputs.push(first.output, second.output);
        const a = await ctx.runNode(ask);
        return {step: first.output, ask: a.output};
      },
    });

    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u1',
    });
    const runner = new Runner({appName: 'test_app', agent: wf, sessionService});

    await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'x'}]},
      }),
    );
    // Turn 1: the in-flight task dedups the second call.
    expect(stepRuns).toBe(1);

    const turn2 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'confirm',
                name: 'adk_request_input',
                response: {result: 'yes'},
              },
            },
          ],
        },
      }),
    );

    // Turn 2: the first call fast-forwards from the recorded run; the second
    // must hand back that same result rather than executing the body again.
    expect(stepRuns).toBe(1);
    expect(outputs).toEqual(['step(x)', 'step(x)', 'step(x)', 'step(x)']);
    expect(turn2.some((e) => e.output === 'confirmed:yes')).toBe(true);
  });
});
