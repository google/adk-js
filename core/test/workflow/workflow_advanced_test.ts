/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {BaseNode} from '../../src/workflow/base_node.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {JoinNode} from '../../src/workflow/nodes/join_node.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {createIc, driveNode, FnNode} from './test_helpers.js';

describe('workflow — maxConcurrency', () => {
  it('bounds the number of concurrently running graph nodes', async () => {
    let active = 0;
    let peak = 0;
    const slow = (name: string): BaseNode =>
      new FunctionNode(name, async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return name;
      });
    const join = new JoinNode({name: 'join'});
    const wf = new Workflow({
      name: 'bounded',
      maxConcurrency: 2,
      edges: [['START', [slow('a'), slow('b'), slow('c'), slow('d')], join]],
    });

    await driveNode(wf, 'x');
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });

  it('rejects maxConcurrency below 1 (0 is not "unlimited")', () => {
    const n = new FunctionNode('n', () => 'x');
    expect(
      () =>
        new Workflow({name: 'bad0', edges: [['START', n]], maxConcurrency: 0}),
    ).toThrow(/positive integer/);
  });

  it('rejects a non-integer maxConcurrency', () => {
    const n = new FunctionNode('n', () => 'x');
    expect(
      () =>
        new Workflow({
          name: 'bad_frac',
          edges: [['START', n]],
          maxConcurrency: 1.5,
        }),
    ).toThrow(/positive integer/);
  });
});

describe('workflow — sibling cancellation on failure', () => {
  it('cancels an in-flight cooperative sibling when another node fails', async () => {
    let siblingCancelled = false;
    // A cooperative node that waits, but bails out early if the workflow-scoped
    // abort signal fires (which happens when its sibling throws).
    const patient = new FunctionNode('patient', async (ctx) => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        ctx.abortSignal?.addEventListener(
          'abort',
          () => {
            siblingCancelled = true;
            clearTimeout(timer);
            resolve();
          },
          {once: true},
        );
      });
      return 'patient-done';
    });
    const boom = new FunctionNode('boom', async () => {
      // Let `patient` start and attach its abort listener first, then fail.
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('boom');
    });
    const wf = new Workflow({
      name: 'cancel_siblings',
      edges: [['START', [patient, boom]]],
    });

    await expect(driveNode(wf, 'x')).rejects.toThrow('boom');
    expect(siblingCancelled).toBe(true);
  });
});

describe('workflow — error propagation', () => {
  it('fails the workflow when a node throws (no retry)', async () => {
    const boom = new FunctionNode('boom', () => {
      throw new Error('kaboom');
    });
    const wf = new Workflow({name: 'err', edges: [['START', boom]]});
    await expect(driveNode(wf, 'x')).rejects.toThrow('kaboom');
  });

  it('does not run downstream nodes after an upstream failure', async () => {
    let downstreamRan = false;
    const boom = new FunctionNode('boom', () => {
      throw new Error('stop');
    });
    const after = new FunctionNode('after', () => {
      downstreamRan = true;
      return 'after';
    });
    const wf = new Workflow({
      name: 'err_chain',
      edges: [['START', boom, after]],
    });
    await expect(driveNode(wf, 'x')).rejects.toThrow('stop');
    expect(downstreamRan).toBe(false);
  });
});

describe('workflow — join with three predecessors', () => {
  it('waits for all predecessors before the join runs', async () => {
    const a = new FnNode('a', (_c, i) => `A(${i})`);
    const b = new FnNode('b', (_c, i) => `B(${i})`);
    const c = new FnNode('c', (_c, i) => `C(${i})`);
    const join = new JoinNode({name: 'join'});
    const wf = new Workflow({
      name: 'triple_join',
      edges: [['START', [a, b, c], join]],
    });
    expect((await driveNode(wf, 'x')).output).toEqual({
      a: 'A(x)',
      b: 'B(x)',
      c: 'C(x)',
    });
  });
});

describe('workflow — retry with exception allow-list', () => {
  it('retries only listed error types', async () => {
    let attempts = 0;
    const node = new FunctionNode(
      'typed',
      () => {
        attempts++;
        if (attempts < 2) {
          throw new TypeError('transient');
        }
        return 'ok';
      },
      {
        retryConfig: {
          maxAttempts: 4,
          initialDelay: 0.001,
          jitter: 0,
          exceptions: [TypeError],
        },
      },
    );
    const wf = new Workflow({name: 'typed_retry', edges: [['START', node]]});
    expect((await driveNode(wf, 'x')).output).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('does not retry an unlisted error type', async () => {
    let attempts = 0;
    const node = new FunctionNode(
      'typed2',
      () => {
        attempts++;
        throw new RangeError('nope');
      },
      {
        retryConfig: {
          maxAttempts: 4,
          initialDelay: 0.001,
          jitter: 0,
          exceptions: [TypeError],
        },
      },
    );
    const wf = new Workflow({name: 'typed_retry2', edges: [['START', node]]});
    await expect(driveNode(wf, 'x')).rejects.toThrow('nope');
    expect(attempts).toBe(1);
  });
});

describe('workflow — rerunOnResume', () => {
  it('re-runs a rerunOnResume node on resume instead of fast-forwarding', async () => {
    let runs = 0;
    // A node that already "completed" in a prior turn (output event in session)
    // but is marked rerunOnResume, so it must run again.
    const node = new FnNode(
      'always',
      () => {
        runs++;
        return 'fresh';
      },
      {rerunOnResume: true},
    );
    const wf = new Workflow({name: 'rerun', edges: [['START', node]]});

    // Seed a session as if `node` completed in a prior turn.
    const priorEvent: Event = createEvent({
      author: 'always',
      nodeInfo: {path: 'rerun.always'},
      output: 'stale',
    });
    const ic = createIc();
    ic.session.events.push(priorEvent);

    const {output} = await driveNode(wf, 'x', ic);
    // Because rerunOnResume is true, it re-executed rather than using 'stale'.
    expect(runs).toBe(1);
    expect(output).toBe('fresh');
  });

  it('fast-forwards a completed node that is NOT rerunOnResume', async () => {
    let runs = 0;
    const node = new FnNode('once', () => {
      runs++;
      return 'fresh';
    });
    const wf = new Workflow({name: 'ff', edges: [['START', node]]});

    const ic = createIc();
    // Belongs to the run in progress (same invocation), so rehydration sees it.
    // An event left behind by a run that already FINISHED is deliberately
    // ignored instead — see rehydration_utils_test.ts.
    const priorEvent: Event = createEvent({
      author: 'once',
      invocationId: ic.invocationId,
      nodeInfo: {path: 'ff.once'},
      output: 'cached',
    });
    ic.session.events.push(priorEvent);

    const {output} = await driveNode(wf, 'x', ic);
    // Not rerunOnResume + has cached output -> fast-forwarded, not re-run.
    expect(runs).toBe(0);
    expect(output).toBe('cached');
  });
});
