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
