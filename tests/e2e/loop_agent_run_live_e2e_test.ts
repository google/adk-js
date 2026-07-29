/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseAgentConfig,
  Context,
  createEvent,
  createEventActions,
  createSession,
  Event,
  EXIT_LOOP,
  InvocationContext,
  LoopAgent,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class GeneratorLiveAgent extends BaseAgent {
  private iterationCount = 0;

  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Not used in live test
  }

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.iterationCount++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    yield createEvent({
      author: this.name,
      invocationId: context.invocationId,
      branch: context.branch,
      content: {
        role: 'model',
        parts: [{text: `Live generation attempt ${this.iterationCount}`}],
      },
    });
  }
}

class EvaluatorLiveAgent extends BaseAgent {
  private evaluationThreshold: number;
  private attemptCount = 0;

  constructor(config: BaseAgentConfig & {threshold: number}) {
    super(config);
    this.evaluationThreshold = config.threshold;
  }

  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Not used in live test
  }

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.attemptCount++;
    await new Promise((resolve) => setTimeout(resolve, 5));

    if (this.attemptCount >= this.evaluationThreshold) {
      const actions = createEventActions();
      const toolContext = new Context({
        invocationContext: context,
        eventActions: actions,
      });
      await EXIT_LOOP.runAsync({
        args: {},
        toolContext,
      });

      yield createEvent({
        author: this.name,
        invocationId: context.invocationId,
        branch: context.branch,
        content: {
          role: 'model',
          parts: [
            {text: 'Evaluation passed. Exiting loop via EXIT_LOOP tool.'},
          ],
        },
        actions,
      });
    } else {
      yield createEvent({
        author: this.name,
        invocationId: context.invocationId,
        branch: context.branch,
        content: {
          role: 'model',
          parts: [{text: 'Evaluation not satisfactory, requesting retry.'}],
        },
      });
    }
  }
}

describe('E2E LoopAgent Live Streaming Execution', () => {
  it('should stream live events through generator and evaluator sub-agents until EXIT_LOOP terminates execution', async () => {
    const generatorAgent = new GeneratorLiveAgent({name: 'live_generator'});
    const evaluatorAgent = new EvaluatorLiveAgent({
      name: 'live_evaluator',
      threshold: 3, // Escalate on 3rd iteration via EXIT_LOOP
    });

    const loopAgent = new LoopAgent({
      name: 'live_refinement_loop',
      subAgents: [generatorAgent, evaluatorAgent],
      maxIterations: 10,
    });

    const session = createSession({
      id: 'e2e-live-session',
      appName: 'e2e-test-app',
      userId: 'e2e-user',
      lastUpdateTime: Date.now(),
    });

    const context = new InvocationContext({
      invocationId: 'e2e-live-invocation',
      agent: loopAgent,
      session,
      pluginManager: new PluginManager(),
    });

    const yieldedEvents: Event[] = [];
    for await (const event of loopAgent.runLive(context)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(6);

    expect(yieldedEvents[0].author).toBe('live_generator');
    expect(yieldedEvents[1].author).toBe('live_evaluator');
    expect(yieldedEvents[2].author).toBe('live_generator');
    expect(yieldedEvents[3].author).toBe('live_evaluator');
    expect(yieldedEvents[4].author).toBe('live_generator');
    expect(yieldedEvents[5].author).toBe('live_evaluator');

    expect(yieldedEvents[4].content?.parts?.[0]?.text).toContain(
      'Live generation attempt 3',
    );
    expect(yieldedEvents[5].content?.parts?.[0]?.text).toContain(
      'Evaluation passed. Exiting loop via EXIT_LOOP tool.',
    );
    expect(yieldedEvents[5].actions?.escalate).toBe(true);
    expect(yieldedEvents[5].actions?.skipSummarization).toBe(true);
  });
});
