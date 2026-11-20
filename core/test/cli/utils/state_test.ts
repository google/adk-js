/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  createEmptyState,
  createEvent,
  Event,
  InvocationContext,
  LlmAgent,
  node,
  ParallelWorker,
  START,
  Workflow,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class PlainAgent extends BaseAgent {
  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'plain'}]},
    });
  }

  protected override async *runLiveImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(ctx);
  }
}

describe('createEmptyState', () => {
  it('seeds every static instruction placeholder to an empty string', () => {
    const agent = new LlmAgent({
      name: 'rootAgent',
      instruction: 'Greet {userName} about {topic} in {userName} style.',
    });

    expect(createEmptyState(agent)).toEqual({
      userName: '',
      topic: '',
    });
  });

  it('walks the entire subAgents tree', () => {
    const grandchild = new LlmAgent({
      name: 'grandchildAgent',
      instruction: 'deep {deepKey}',
    });
    const child = new LlmAgent({
      name: 'childAgent',
      instruction: 'mid {midKey}',
      subAgents: [grandchild],
    });
    const root = new LlmAgent({
      name: 'rootAgent',
      instruction: 'top {topKey}',
      subAgents: [child],
    });

    expect(createEmptyState(root)).toEqual({
      topKey: '',
      midKey: '',
      deepKey: '',
    });
  });

  it('merges initializedStates overrides onto seeded keys and preserves extra keys', () => {
    const agent = new LlmAgent({
      name: 'rootAgent',
      instruction: '{firstKey} {secondKey} {thirdKey}',
    });

    expect(
      createEmptyState(agent, {
        secondKey: 'configured',
        extraKey: 'kept',
      }),
    ).toEqual({
      firstKey: '',
      secondKey: 'configured',
      thirdKey: '',
      extraKey: 'kept',
    });
  });

  it('matches only bare word placeholders', () => {
    const agent = new LlmAgent({
      name: 'rootAgent',
      instruction: '{okKey} {user.name} {with-dash} {} {a b} {{escaped}}',
    });

    expect(createEmptyState(agent)).toEqual({
      okKey: '',
      escaped: '',
    });
  });

  it('ignores non-LlmAgent BaseAgent subclasses while traversing their subAgents', () => {
    const root = new PlainAgent({
      name: 'plainRoot',
      subAgents: [
        new PlainAgent({name: 'plainChild'}),
        new LlmAgent({name: 'llmChild', instruction: '{fromLlm}'}),
      ],
    });

    expect(createEmptyState(root)).toEqual({fromLlm: ''});
  });

  it('ignores instruction provider functions on LlmAgent', () => {
    const root = new LlmAgent({
      name: 'rootAgent',
      instruction: () => 'dynamic {neverSeeded}',
      subAgents: [
        new LlmAgent({name: 'childAgent', instruction: '{staticKey}'}),
      ],
    });

    expect(createEmptyState(root)).toEqual({staticKey: ''});
  });

  it('returns an empty object when no placeholders exist', () => {
    const agent = new LlmAgent({
      name: 'rootAgent',
      instruction: 'no placeholders here',
    });

    expect(createEmptyState(agent)).toEqual({});
  });

  it('extracts placeholders from Workflow graph nodes and applies initializedStates', () => {
    const stepAgent = new LlmAgent({
      name: 'stepAgent',
      instruction: 'Use {workflowKey} and {freshKey}',
    });
    const workflow = new Workflow({
      name: 'sampleWorkflow',
      edges: [[START, stepAgent]],
    });

    expect(createEmptyState(workflow)).toEqual({
      workflowKey: '',
      freshKey: '',
    });
    expect(createEmptyState(workflow, {workflowKey: 'preset'})).toEqual({
      workflowKey: 'preset',
      freshKey: '',
    });
  });

  it('extracts placeholders from nested Workflows and ParallelWorker inner nodes', () => {
    const leafAgent = new LlmAgent({
      name: 'leafAgent',
      instruction: 'Use {leafKey}',
    });
    const workerAgent = new LlmAgent({
      name: 'workerAgent',
      instruction: 'Process {workerKey}',
    });
    const builtWorker = node(
      new LlmAgent({
        name: 'builtWorkerAgent',
        instruction: 'Handle {builtWorkerKey}',
      }),
      {parallelWorker: true},
    );
    const innerWorkflow = new Workflow({
      name: 'innerWorkflow',
      edges: [[START, leafAgent]],
    });
    const parallelWorker = new ParallelWorker(workerAgent);
    const outerWorkflow = new Workflow({
      name: 'outerWorkflow',
      edges: [
        [START, innerWorkflow],
        [innerWorkflow, parallelWorker],
        [parallelWorker, builtWorker],
      ],
    });

    expect(createEmptyState(outerWorkflow)).toEqual({
      leafKey: '',
      workerKey: '',
      builtWorkerKey: '',
    });
  });

  it('terminates cleanly on cyclic workflow graphs', () => {
    const firstStep = new LlmAgent({
      name: 'firstStep',
      instruction: 'Check {firstKey}',
    });
    const secondStep = new LlmAgent({
      name: 'secondStep',
      instruction: 'Refine {secondKey}',
    });
    const workflowA = new Workflow({
      name: 'workflowA',
      edges: [
        [START, firstStep],
        [firstStep, {retry: secondStep}],
        [secondStep, {again: firstStep}],
      ],
    });
    const workflowB = new Workflow({
      name: 'workflowB',
      edges: [[START, workflowA]],
    });
    workflowA.graph?.nodes.push(workflowB);

    expect(createEmptyState(workflowA)).toEqual({
      firstKey: '',
      secondKey: '',
    });
  });

  it('ignores __proto__ while preserving constructor and prototype as own properties', () => {
    const agent = new LlmAgent({
      name: 'rootAgent',
      instruction: '{__proto__} {constructor} {prototype} {safePlaceholder}',
    });
    const parsedInit: Record<string, unknown> = JSON.parse(
      '{"__proto__":{"polluted":true},"safeInit":"ok"}',
    );

    const state = createEmptyState(agent, parsedInit);

    expect(Object.getPrototypeOf(state)).toBe(Object.prototype);
    expect(Object.hasOwn(state, '__proto__')).toBe(false);
    expect(Object.hasOwn(state, 'constructor')).toBe(true);
    expect(Object.hasOwn(state, 'prototype')).toBe(true);
    expect(state).toEqual({
      constructor: '',
      prototype: '',
      safePlaceholder: '',
      safeInit: 'ok',
    });

    const overriddenInit: Record<string, unknown> = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"customCtor","prototype":"customProto"}',
    );
    const overriddenState = createEmptyState(agent, overriddenInit);

    expect(Object.getPrototypeOf(overriddenState)).toBe(Object.prototype);
    expect(Object.hasOwn(overriddenState, '__proto__')).toBe(false);
    expect(Object.hasOwn(overriddenState, 'constructor')).toBe(true);
    expect(Object.hasOwn(overriddenState, 'prototype')).toBe(true);
    expect(overriddenState).toEqual({
      constructor: 'customCtor',
      prototype: 'customProto',
      safePlaceholder: '',
    });
    expect('polluted' in {}).toBe(false);
    expect(Object.prototype.constructor).toBe(Object);
  });
});
