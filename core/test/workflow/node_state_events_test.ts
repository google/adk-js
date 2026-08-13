/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * How a node's state writes reach the event stream and the nodes after it.
 * Both directions matter: the session is rebuilt from events, and a later node
 * reads through `ctx.state`.
 */

import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {createIc} from './test_helpers.js';

async function drive(
  wf: Workflow,
  input?: unknown,
): Promise<{output: unknown; events: Event[]}> {
  const channel = new AsyncQueue<Event>();
  const root = new NodeContext({
    invocationContext: createIc(),
    channel,
    nodePath: '',
    runId: 'root',
  });
  const events: Event[] = [];
  const run = root.runNode(wf, input, {useAsOutput: true}).then(
    () => channel.close(),
    (err) => channel.fail(err),
  );
  for await (const event of channel) {
    events.push(event);
  }
  await run;
  return {output: root.output, events};
}

const deltas = (events: Event[]): Array<Record<string, unknown>> =>
  events
    .map((e) => e.actions?.stateDelta ?? {})
    .filter((d) => Object.keys(d).length > 0);

describe('node state writes and the event stream', () => {
  it('reports state written by a generator node that yields nothing', async () => {
    const write = node(
      // eslint-disable-next-line require-yield
      async function* (ctx: NodeContext, input: string) {
        ctx.state.set('seen', input);
      },
      {name: 'write'},
    );
    const read = node((ctx: NodeContext) => `read:${ctx.state.get('seen')}`, {
      name: 'read',
    });
    const wf = new Workflow({name: 'wf', edges: [['START', write, read]]});

    const {output, events} = await drive(wf, 'x');

    expect(deltas(events)).toEqual([{seen: 'x'}]);
    expect(output).toBe('read:x');
  });

  it('makes state carried on an emitted event readable by the next node', async () => {
    const write = node(
      (_c: NodeContext, input: string) =>
        createEvent({actions: {stateDelta: {seen: input.toUpperCase()}}}),
      {name: 'write'},
    );
    const read = node((ctx: NodeContext) => `read:${ctx.state.get('seen')}`, {
      name: 'read',
    });
    const wf = new Workflow({name: 'wf', edges: [['START', write, read]]});

    const {output, events} = await drive(wf, 'x');

    expect(deltas(events)).toEqual([{seen: 'X'}]);
    expect(output).toBe('read:X');
  });
});
