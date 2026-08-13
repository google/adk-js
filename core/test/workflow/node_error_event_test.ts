/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {Event} from '../../src/events/event.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession} from '../../src/sessions/session.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {BaseNode} from '../../src/workflow/base_node.js';
import {isNodeTimeoutError} from '../../src/workflow/errors.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {
  isNodeErrorEvent,
  NodeErrorEvent,
} from '../../src/workflow/node_error_event.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {WorkflowAgent} from '../../src/workflow/workflow_agent.js';
import {createIc} from './test_helpers.js';

interface FailedRun {
  events: Event[];
  errorEvents: NodeErrorEvent[];
  thrown: unknown;
}

async function driveExpectingFailure(
  node: BaseNode,
  input?: unknown,
  ic: InvocationContext = createIc(),
): Promise<FailedRun> {
  const channel = new AsyncQueue<Event>();
  const root = new NodeContext({
    invocationContext: ic,
    channel,
    nodePath: '',
    runId: 'root',
  });
  const events: Event[] = [];
  const settle = root.runNode(node, input, {useAsOutput: true}).then(
    () => channel.close(),
    (err) => channel.fail(err),
  );
  let thrown: unknown;
  try {
    for await (const event of channel) {
      events.push(event);
    }
  } catch (err) {
    thrown = err;
  }
  await settle;
  return {events, errorEvents: events.filter(isNodeErrorEvent), thrown};
}

function icWithId(invocationId: string): InvocationContext {
  return new InvocationContext({
    invocationId,
    session: createSession({
      id: 's1',
      appName: 'app',
      userId: 'u',
      lastUpdateTime: Date.now(),
    }),
    agent: new WorkflowAgent({
      name: 'wf',
      edges: [['START', new FunctionNode('n', () => null)]],
    }),
    pluginManager: new PluginManager(),
  });
}

function throwingNode(name: string, error: Error): FunctionNode {
  return new FunctionNode(name, async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    throw error;
  });
}

describe('NodeErrorEvent — a failed node leaves a record', () => {
  it('emits exactly one error event for the node that threw, and still rejects', async () => {
    const kaboom = new Error('kaboom');
    const wf = new Workflow({
      name: 'wf',
      edges: [['START', throwingNode('boom', kaboom)]],
    });

    const {errorEvents, thrown} = await driveExpectingFailure(wf, 'x');

    expect(errorEvents).toHaveLength(1);
    const [error] = errorEvents;
    expect(error.isNodeError).toBe(true);
    expect(error.nodeInfo?.path).toBe('wf.boom');
    expect(error.author).toBe('boom');
    expect(error.errorMessage).toBe('kaboom');
    expect(error.errorType).toBe('Error');
    expect(error.errorCode).toBe('UNKNOWN_ERROR');
    expect(error.attemptCount).toBe(1);
    expect(thrown).toBe(kaboom);
  });

  it('keeps the stack trace out of the persisted event', async () => {
    const wf = new Workflow({
      name: 'wf',
      edges: [['START', throwingNode('boom', new Error('kaboom'))]],
    });

    const {errorEvents} = await driveExpectingFailure(wf, 'x');

    const serialized = JSON.stringify(errorEvents[0]);
    expect(serialized).not.toContain('node_error_event_test');
    expect(serialized).not.toContain('at ');
  });

  it('prefers a machine-readable `code` on the error for errorCode', async () => {
    const coded = Object.assign(new TypeError('connection refused'), {
      code: 'ECONNREFUSED',
    });
    const wf = new Workflow({
      name: 'wf',
      edges: [['START', throwingNode('call', coded)]],
    });

    const {errorEvents} = await driveExpectingFailure(wf, 'x');

    expect(errorEvents[0].errorCode).toBe('ECONNREFUSED');
    expect(errorEvents[0].errorType).toBe('TypeError');
  });

  it('falls back to a generic errorCode rather than repeating errorType', async () => {
    const wf = new Workflow({
      name: 'wf',
      edges: [['START', throwingNode('boom', new RangeError('out of range'))]],
    });

    const {errorEvents} = await driveExpectingFailure(wf, 'x');

    expect(errorEvents[0].errorType).toBe('RangeError');
    expect(errorEvents[0].errorCode).toBe('UNKNOWN_ERROR');
  });
});

describe('NodeErrorEvent — a failure is recorded once, where it happened', () => {
  it('reports a nested failure only at the node that threw', async () => {
    const kaboom = new Error('kaboom');
    const inner = new Workflow({
      name: 'inner',
      edges: [['START', throwingNode('leaf', kaboom)]],
    });
    const outer = new Workflow({name: 'outer', edges: [['START', inner]]});

    const {errorEvents, thrown} = await driveExpectingFailure(outer, 'x');

    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].nodeInfo?.path).toBe('outer.inner.leaf');
    expect(errorEvents[0].author).toBe('leaf');
    expect(thrown).toBe(kaboom);
  });

  it('does not multiply the record by nesting depth', async () => {
    const kaboom = new Error('kaboom');
    const l3 = new Workflow({
      name: 'l3',
      edges: [['START', throwingNode('leaf', kaboom)]],
    });
    const l2 = new Workflow({name: 'l2', edges: [['START', l3]]});
    const l1 = new Workflow({name: 'l1', edges: [['START', l2]]});

    const {errorEvents} = await driveExpectingFailure(l1, 'x');

    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].nodeInfo?.path).toBe('l1.l2.l3.leaf');
  });

  it("reports an inner workflow's own failure at the parent, since no node threw", async () => {
    const inner = new Workflow({
      name: 'inner',
      edges: [
        [
          'START',
          [
            new FunctionNode('a', async () => 'one'),
            new FunctionNode('b', async () => 'two'),
          ],
        ],
      ],
    });
    const outer = new Workflow({name: 'outer', edges: [['START', inner]]});

    const {errorEvents} = await driveExpectingFailure(outer, 'x');

    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].nodeInfo?.path).toBe('outer.inner');
    expect(errorEvents[0].errorMessage).toContain('multiple terminal nodes');
  });

  it('records the same error instance again in a different invocation', async () => {
    const shared = new Error('shared');
    const wf = new Workflow({
      name: 'wf',
      edges: [['START', throwingNode('boom', shared)]],
    });

    const first = await driveExpectingFailure(wf, 'x', icWithId('inv-a'));
    const second = await driveExpectingFailure(wf, 'x', icWithId('inv-b'));

    expect(first.errorEvents).toHaveLength(1);
    expect(second.errorEvents).toHaveLength(1);
  });
});

describe('NodeErrorEvent — delivery ordering through WorkflowAgent', () => {
  it('reaches the caller BEFORE the rejection surfaces', async () => {
    const kaboom = new Error('kaboom');
    const agent = new WorkflowAgent({
      name: 'wf',
      edges: [['START', throwingNode('boom', kaboom)]],
    });
    const ic = new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({
        id: 's1',
        appName: 'app',
        userId: 'u',
        lastUpdateTime: Date.now(),
      }),
      agent,
      userContent: {role: 'user', parts: [{text: 'go'}]},
      pluginManager: new PluginManager(),
    });

    const observed: string[] = [];
    let thrown: unknown;
    try {
      for await (const event of agent.runAsync(ic)) {
        observed.push(isNodeErrorEvent(event) ? 'node-error' : 'event');
      }
    } catch (err) {
      thrown = err;
      observed.push('rejected');
    }

    expect(observed).toEqual(['node-error', 'rejected']);
    expect(thrown).toBe(kaboom);
  });
});

describe('NodeErrorEvent — cancellation is not failure', () => {
  it('does not emit for a sibling cancelled by another node failure', async () => {
    let patientCancelled = false;
    const patient = new FunctionNode('patient', async (ctx) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2000);
        ctx.abortSignal?.addEventListener(
          'abort',
          () => {
            patientCancelled = true;
            clearTimeout(timer);
            reject(new Error('patient was cancelled'));
          },
          {once: true},
        );
      });
      return 'never';
    });
    const wf = new Workflow({
      name: 'wf',
      edges: [['START', [patient, throwingNode('boom', new Error('boom'))]]],
    });

    const {errorEvents} = await driveExpectingFailure(wf, 'x');

    expect(patientCancelled).toBe(true);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].author).toBe('boom');
    expect(errorEvents.some((e) => e.author === 'patient')).toBe(false);
  });

  it('does not emit when the invocation itself is aborted', async () => {
    const controller = new AbortController();
    const node = new FunctionNode('aborted', async (ctx) => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (ctx.abortSignal?.aborted) {
        throw new Error('aborted by the caller');
      }
      return 'never';
    });
    const wf = new Workflow({name: 'wf', edges: [['START', node]]});

    const {errorEvents, thrown} = await driveExpectingFailure(
      wf,
      'x',
      createIc({}, controller.signal),
    );

    expect(errorEvents).toHaveLength(0);
    expect((thrown as Error).message).toBe('aborted by the caller');
  });
});

describe('NodeErrorEvent — retries and timeouts', () => {
  it('emits once for a node that exhausts its retryConfig, not once per attempt', async () => {
    let attempts = 0;
    const flaky = new FunctionNode(
      'flaky',
      () => {
        attempts++;
        throw new Error('still broken');
      },
      {retryConfig: {maxAttempts: 3, initialDelay: 0.001, jitter: 0}},
    );
    const wf = new Workflow({name: 'wf', edges: [['START', flaky]]});

    const {errorEvents} = await driveExpectingFailure(wf, 'x');

    expect(attempts).toBe(3);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].attemptCount).toBe(3);
    expect(errorEvents[0].errorMessage).toBe('still broken');
  });

  it('emits for a genuine timeout, identifying it as one', async () => {
    const slow = new FunctionNode(
      'slow',
      () =>
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('late'), 500),
        ),
      {timeout: 0.02},
    );
    const wf = new Workflow({name: 'wf', edges: [['START', slow]]});

    const {errorEvents, thrown} = await driveExpectingFailure(wf, 'x');

    expect(isNodeTimeoutError(thrown)).toBe(true);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].errorType).toBe('NodeTimeoutError');
    expect(errorEvents[0].errorCode).toBe('UNKNOWN_ERROR');
    expect(errorEvents[0].errorMessage).toContain('timed out');
    expect(errorEvents[0].nodeInfo?.path).toBe('wf.slow');
  });
});
