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
import {hasRequestInputFunctionCall} from '../../src/workflow/utils/hitl_utils.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {WorkflowAgent} from '../../src/workflow/workflow_agent.js';

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
    const ask = new FunctionNode('ask', (ctx: NodeContext) => {
      askRuns++;
      const answer = ctx.resumeInputs['confirm'];
      if (answer === undefined) {
        return new RequestInput({interruptId: 'confirm', message: 'confirm?'});
      }
      return `confirmed:${answer}`;
    });

    // Imperative workflow: run `step` (completes), then `ask` (interrupts).
    const wf = new Workflow({
      name: 'dyn_resume_wf',
      dynamicEntry: async (ctx, input) => {
        const s = await ctx.runNode(step, input);
        const a = await ctx.runNode(ask);
        return {step: s.output, ask: a.output};
      },
    });

    const agent = new WorkflowAgent(wf);
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
});
