/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {DEFAULT_ROUTE} from '../../src/workflow/graph.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {replyAgent} from './test_helpers.js';

async function runViaRunner(
  workflow: Workflow,
  text: string,
): Promise<Event[]> {
  const agent = workflow;
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'test_app',
    userId: 'u1',
  });
  const runner = new Runner({appName: 'test_app', agent, sessionService});

  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'u1',
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text}]},
  })) {
    events.push(event);
  }
  return events;
}

describe('Phase 8 — Workflow via the real Runner', () => {
  it('runs a single-node workflow end-to-end', async () => {
    const wf = new Workflow({
      name: 'greet_wf',
      edges: [
        [
          'START',
          node((_c: NodeContext, input: string) => `hello ${input}`, {
            name: 'greet',
          }),
        ],
      ],
    });
    const events = await runViaRunner(wf, 'world');
    expect(events.some((e) => e.output === 'hello world')).toBe(true);
  });

  it('runs a linear sequence end-to-end (input threads through)', async () => {
    const a = node((_c: NodeContext, i: string) => `${i}->A`, {name: 'a'});
    const b = node((_c: NodeContext, i: string) => `${i}->B`, {name: 'b'});
    const wf = new Workflow({name: 'seq_wf', edges: [['START', a, b]]});

    const events = await runViaRunner(wf, 'INIT');
    const outputs = events
      .filter((e) => e.output !== undefined)
      .map((e) => e.output);
    expect(outputs).toContain('INIT->A');
    expect(outputs).toContain('INIT->A->B');
  });

  it('runs a routed workflow end-to-end', async () => {
    const route = node(
      (_c: NodeContext, input: string) =>
        createEvent({route: input.includes('?') ? 'q' : 's', output: input}),
      {name: 'route'},
    );
    const q = node((_c: NodeContext, i: string) => `Q:${i}`, {name: 'q'});
    const s = node((_c: NodeContext, i: string) => `S:${i}`, {name: 's'});
    const wf = new Workflow({
      name: 'route_wf',
      edges: [
        ['START', route],
        [route, {q, s}],
      ],
    });

    const events = await runViaRunner(wf, 'hi?');
    expect(events.some((e) => e.output === 'Q:hi?')).toBe(true);
  });

  it('falls back to DEFAULT_ROUTE end-to-end', async () => {
    const check = node(
      (_c: NodeContext, input: string) =>
        createEvent(
          input === 'skip' ? {output: input} : {route: 'go', output: input},
        ),
      {name: 'check'},
    );
    const go = node((_c: NodeContext, i: string) => `GO:${i}`, {
      name: 'go_node',
    });
    const fallback = node((_c: NodeContext, i: string) => `DEFAULT:${i}`, {
      name: 'fallback',
    });
    const wf = new Workflow({
      name: 'default_wf',
      edges: [
        ['START', check],
        [check, {go, [DEFAULT_ROUTE]: fallback}],
      ],
    });

    const events = await runViaRunner(wf, 'skip');
    expect(events.some((e) => e.output === 'DEFAULT:skip')).toBe(true);
  });
});

/**
 * The fan-in contract, pinned without a model.
 *
 * The `parallel_worker` sample covers this too, but only against recorded
 * responses: when a worker produces no output the aggregate receives a hole,
 * and the symptom is a fixture mismatch — which a re-record silently absorbs.
 * These run the same shape through the real Runner with a `Workflow` root and
 * assert on what the aggregate is actually handed, so a fan-in regression fails
 * here whatever the fixtures say.
 */
describe('ParallelWorker fan-in under a node root', () => {
  /** Builds `START -> seed -> worker(parallel) -> aggregate`, capturing the aggregate's input. */
  function fanInWorkflow(inner: Parameters<typeof node>[0]): {
    wf: Workflow;
    received: () => unknown;
  } {
    let seen: unknown;
    const seed = node(() => ['a', 'b', 'c'], {name: 'seed'});
    // Fewer workers than items, so the pool reuses a slot — the shape that
    // first surfaced the holes.
    const worker = node(inner, {parallelWorker: true, maxParallelWorkers: 2});
    const aggregate = node(
      (_c: NodeContext, nodeInput: unknown) => {
        seen = nodeInput;
        return 'done';
      },
      {name: 'aggregate'},
    );
    return {
      wf: new Workflow({
        name: 'fan_in_wf',
        edges: [['START', seed, worker, aggregate]],
      }),
      received: () => seen,
    };
  }

  it('hands the aggregate one output per item, in item order', async () => {
    const {wf, received} = fanInWorkflow(
      node((_c: NodeContext, item: string) => item.toUpperCase(), {
        name: 'shout',
      }),
    );

    await runViaRunner(wf, 'go');

    expect(received()).toEqual(['A', 'B', 'C']);
  });

  it('gives an agent worker an output per item, not a hole', async () => {
    // An agent worker is the case that broke: with no `ic.agent` at the root,
    // a worker that produced nothing left `undefined` in the list, and the
    // aggregate read a property off it.
    const {wf, received} = fanInWorkflow(replyAgent('worker'));

    await runViaRunner(wf, 'go');

    expect(received()).toEqual(['ok', 'ok', 'ok']);
  });
});
