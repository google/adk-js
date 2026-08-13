/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {context, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {BasePlugin} from '../../src/plugins/base_plugin.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {driveWorkflow, FnNode} from './test_helpers.js';

const exporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  contextManager.disable();
});

beforeEach(() => {
  exporter.reset();
});

function onlySpan(name: string): ReadableSpan {
  const matches = exporter.getFinishedSpans().filter((s) => s.name === name);
  expect(matches.map((s) => s.name)).toEqual([name]);
  return matches[0];
}

function spansNamed(name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((s) => s.name === name);
}

function expectChildOf(child: ReadableSpan, parent: ReadableSpan): void {
  expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
  expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
}

describe('workflow telemetry — span tree', () => {
  it('nests every node span under the workflow span in a sequential graph', async () => {
    const a = new FnNode('step_a', (_c, input) => `${input}->A`);
    const b = new FnNode('step_b', (_c, input) => `${input}->B`);
    const c = new FnNode('step_c', (_c, input) => `${input}->C`);
    const wf = new Workflow({name: 'seq', edges: [['START', a, b, c]]});

    expect((await driveWorkflow(wf, 'INIT')).output).toBe('INIT->A->B->C');

    const wfSpan = onlySpan('invoke_workflow seq');
    const nodeSpans = ['step_a', 'step_b', 'step_c'].map((name) =>
      onlySpan(`execute_node ${name}`),
    );
    for (const nodeSpan of nodeSpans) {
      expectChildOf(nodeSpan, wfSpan);
    }

    expectChildOf(wfSpan, onlySpan('execute_node seq'));

    expect(wfSpan.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_workflow',
      'adk.workflow.name': 'seq',
      'adk.node.path': 'seq',
    });
    expect(nodeSpans[0].attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_node',
      'adk.node.path': 'seq.step_a',
      'adk.node.attempt': 1,
      'adk.node.status': 'completed',
      'adk.node.interrupt_count': 0,
    });
  });

  it('keeps concurrently scheduled nodes as siblings, not nested', async () => {
    let startLeft!: () => void;
    let startRight!: () => void;
    const leftStarted = new Promise<void>((r) => (startLeft = r));
    const rightStarted = new Promise<void>((r) => (startRight = r));

    // Each node runs a dynamic child while its sibling is also in flight, so
    // the inner spans below can only land on the right parent if each node's
    // context binding survives being interleaved with the other's.
    const left = new FnNode('left', async (ctx) => {
      startLeft();
      await rightStarted;
      await ctx.runNode(new FnNode('inner_left', () => 'l'), 'x');
      return 'L';
    });
    const right = new FnNode('right', async (ctx) => {
      startRight();
      await leftStarted;
      await ctx.runNode(new FnNode('inner_right', () => 'r'), 'x');
      return 'R';
    });
    const join = new FnNode('join', (_c, input) => input);
    const wf = new Workflow({
      name: 'fan',
      edges: [['START', [left, right], join]],
    });

    await driveWorkflow(wf, 'x');

    const wfSpan = onlySpan('invoke_workflow fan');
    const leftSpan = onlySpan('execute_node left');
    const rightSpan = onlySpan('execute_node right');

    // Overlap is guaranteed structurally, not asserted on timestamps: neither
    // node can return until the other has started, so the run only completes
    // if both were in flight at once. OTel HrTime is too coarse to compare
    // sub-millisecond span intervals reliably.
    expectChildOf(leftSpan, wfSpan);
    expectChildOf(rightSpan, wfSpan);
    expect(leftSpan.parentSpanContext?.spanId).not.toBe(
      rightSpan.spanContext().spanId,
    );
    expect(rightSpan.parentSpanContext?.spanId).not.toBe(
      leftSpan.spanContext().spanId,
    );

    // The point of binding the context per node: work started inside one node
    // nests under that node, never under whichever sibling happens to be
    // running alongside it.
    expectChildOf(onlySpan('execute_node inner_left'), leftSpan);
    expectChildOf(onlySpan('execute_node inner_right'), rightSpan);
  });

  it('emits one attempt span per try for a retried node', async () => {
    let attempts = 0;
    const flaky = new FnNode(
      'flaky',
      () => {
        attempts++;
        if (attempts < 2) {
          throw new Error('transient');
        }
        return 'ok';
      },
      {retryConfig: {maxAttempts: 2, initialDelay: 0.001, jitter: 0}},
    );
    const wf = new Workflow({name: 'retry_wf', edges: [['START', flaky]]});

    expect((await driveWorkflow(wf, 'x')).output).toBe('ok');
    expect(attempts).toBe(2);

    const nodeSpan = onlySpan('execute_node flaky');
    const attemptSpans = spansNamed('execute_node_attempt flaky');
    expect(attemptSpans).toHaveLength(2);
    for (const attemptSpan of attemptSpans) {
      expectChildOf(attemptSpan, nodeSpan);
    }

    expect(attemptSpans[0].attributes).toMatchObject({
      'adk.node.path': 'retry_wf.flaky',
      'adk.node.attempt': 1,
      'adk.node.status': 'failed',
    });
    expect(attemptSpans[1].attributes).toMatchObject({
      'adk.node.attempt': 2,
      'adk.node.status': 'completed',
    });
    expect(nodeSpan.attributes).toMatchObject({
      'adk.node.attempt': 2,
      'adk.node.status': 'completed',
    });
  });

  it('does not emit attempt spans for a node without a retry config', async () => {
    const plain = new FnNode('plain', () => 'ok');
    const wf = new Workflow({name: 'plain_wf', edges: [['START', plain]]});

    await driveWorkflow(wf, 'x');

    expect(spansNamed('execute_node_attempt plain')).toHaveLength(0);
  });

  it('marks a failed node span as failed', async () => {
    const boom = new FnNode('boom', () => {
      throw new Error('kaboom');
    });
    const wf = new Workflow({name: 'fail_wf', edges: [['START', boom]]});

    await expect(driveWorkflow(wf, 'x')).rejects.toThrow('kaboom');

    expect(onlySpan('execute_node boom').attributes).toMatchObject({
      'adk.node.status': 'failed',
    });
  });
});

describe('workflow telemetry — a workflow run as a runner root', () => {
  it('still emits workflow and node spans without an agent wrapper', async () => {
    // Driving the workflow as a node loses `BaseAgent.runAsync`'s
    // `invoke_agent` span. That is only acceptable because node execution is
    // traced in its own right — so assert it, rather than assume it.
    const workflow = new Workflow({
      name: 'traced_root',
      edges: [['START', new FnNode('step', () => 'done')]],
    });

    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'app',
      userId: 'u',
    });
    const runner = new Runner({
      appName: 'app',
      agent: workflow,
      sessionService,
    });
    for await (const _ of runner.runAsync({
      userId: 'u',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'go'}]},
    })) {
      void _;
    }

    const workflowSpan = onlySpan('invoke_workflow traced_root');
    const nodeSpan = onlySpan('execute_node step');
    expectChildOf(nodeSpan, workflowSpan);
  });

  it('still runs the node plugin hooks without an agent wrapper', async () => {
    // Same argument for plugins: the hooks hang off node execution, not off
    // the agent the workflow used to be wrapped in.
    const seen: string[] = [];
    class RecordingPlugin extends BasePlugin {
      constructor() {
        super('recording');
      }
      override async beforeNodeCallback({node}: {node: {name: string}}) {
        seen.push(`before:${node.name}`);
        return undefined;
      }
      override async afterNodeCallback({node}: {node: {name: string}}) {
        seen.push(`after:${node.name}`);
        return undefined;
      }
    }

    const workflow = new Workflow({
      name: 'plugged_root',
      edges: [['START', new FnNode('step', () => 'done')]],
    });
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'app',
      userId: 'u',
    });
    const runner = new Runner({
      appName: 'app',
      agent: workflow,
      sessionService,
      plugins: [new RecordingPlugin()],
    });
    for await (const _ of runner.runAsync({
      userId: 'u',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'go'}]},
    })) {
      void _;
    }

    // The workflow is itself a node, so it is bracketed too — the hooks wrap
    // the graph and each node inside it.
    expect(seen).toEqual([
      'before:plugged_root',
      'before:step',
      'after:step',
      'after:plugged_root',
    ]);
  });
});
