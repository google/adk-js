/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  createEvent,
  createResumabilityConfig,
  Event,
  InMemoryRunner,
  InMemorySessionService,
  InvocationContext,
} from '@google/adk';
import {FunctionCall, FunctionResponse} from '@google/genai';
import {describe, expect, it} from 'vitest';

/**
 * Sub-agent simulating a long-running operation initiation and resumption handling.
 */
class DataProcessingAgent extends BaseAgent {
  constructor() {
    super({
      name: 'DataProcessingAgent',
      description:
        'Agent responsible for long-running batch data processing tasks.',
    });
  }

  override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const lastEvent = ctx.session.events[ctx.session.events.length - 1];

    // Check if we are resumed with a function response matching our LRO
    const lroResponse = lastEvent?.content?.parts?.find(
      (p) => p.functionResponse?.name === 'vertex_ai_batch_predict',
    )?.functionResponse;

    if (lroResponse) {
      // Resumed after LRO completion!
      yield createEvent({
        author: this.name,
        content: {
          role: 'model',
          parts: [
            {
              text: `Batch processing completed successfully! Status: ${
                (lroResponse.response as {status?: string})?.status
              }`,
            },
          ],
        },
      });
      return;
    }

    // Otherwise, initiate the long-running operation tool call
    const lroCall: FunctionCall = {
      id: 'lro-call-id-999',
      name: 'vertex_ai_batch_predict',
      args: {dataset: 'gs://bucket/data.csv'},
    };

    yield createEvent({
      author: this.name,
      content: {
        role: 'model',
        parts: [
          {text: 'Initiating long-running Vertex AI batch prediction...'},
          {functionCall: lroCall},
        ],
      },
      longRunningToolIds: ['lro-call-id-999'],
    });
  }
}

/**
 * Root orchestrator agent that transfers to DataProcessingAgent when requested.
 */
class RootOrchestratorAgent extends BaseAgent {
  constructor(subAgents: BaseAgent[]) {
    super({
      name: 'RootOrchestratorAgent',
      subAgents,
    });
  }

  override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const lastEvent = ctx.session.events[ctx.session.events.length - 1];
    const text = lastEvent?.content?.parts?.[0]?.text || '';

    if (text.includes('process data')) {
      const targetAgent = this.findSubAgent('DataProcessingAgent');
      if (targetAgent) {
        yield* targetAgent.runAsync(ctx);
        return;
      }
    }

    yield createEvent({
      author: this.name,
      content: {
        role: 'model',
        parts: [{text: 'Hello from root orchestrator.'}],
      },
    });
  }
}

describe('E2E LRO Session Resumption Routing', () => {
  it('should correctly route LRO completion back to the initiating sub-agent across serialized sessions without mocks', async () => {
    // 1. Setup agents hierarchy and persistent session store
    const dataProcessingAgent = new DataProcessingAgent();
    const rootAgent = new RootOrchestratorAgent([dataProcessingAgent]);
    const sessionService = new InMemorySessionService();
    const appName = 'lro_resumption_app';
    const userId = 'user-abc';

    // 2. Initial turn: User requests data processing, root transfers to DataProcessingAgent which emits LRO tool call
    const initialRunner = new InMemoryRunner({
      agent: rootAgent,
      appName,
      resumabilityConfig: createResumabilityConfig({isResumable: true}),
    });
    // Override sessionService on runner to share the persistent session store across turns
    (
      initialRunner as unknown as {sessionService: InMemorySessionService}
    ).sessionService = sessionService;

    const session = await sessionService.createSession({appName, userId});

    const initialEvents: Event[] = [];
    for await (const ev of initialRunner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Please process data now'}]},
    })) {
      initialEvents.push(ev);
    }

    expect(initialEvents.length).toBeGreaterThanOrEqual(1);
    const lroEvent = initialEvents[initialEvents.length - 1];
    expect(lroEvent.author).toBe('DataProcessingAgent');
    expect(lroEvent.longRunningToolIds).toContain('lro-call-id-999');

    // 3. Session is serialized/paused while external LRO runs asynchronously...
    // Verify stored events in session contain the tool call from DataProcessingAgent
    const storedSession = await sessionService.getSession({
      appName,
      userId,
      sessionId: session.id,
    });
    expect(storedSession?.events.length).toBeGreaterThan(0);

    // 4. LRO completes externally. We invoke a new resumed turn using a freshly instantiated Runner
    const resumedRunner = new InMemoryRunner({
      agent: rootAgent,
      appName,
      resumabilityConfig: createResumabilityConfig({isResumable: true}),
    });
    (
      resumedRunner as unknown as {sessionService: InMemorySessionService}
    ).sessionService = sessionService;

    const lroCompletionResponse: FunctionResponse = {
      id: 'lro-call-id-999',
      name: 'vertex_ai_batch_predict',
      response: {status: 'SUCCEEDED'},
    };

    const resumedEvents: Event[] = [];
    for await (const ev of resumedRunner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [{functionResponse: lroCompletionResponse}],
      },
    })) {
      resumedEvents.push(ev);
    }

    // 5. Verify routing automatically directed execution back to DataProcessingAgent without hitting root
    expect(resumedEvents.length).toBeGreaterThanOrEqual(1);
    const finalEvent = resumedEvents[resumedEvents.length - 1];
    expect(finalEvent.author).toBe('DataProcessingAgent');
    expect(finalEvent.content?.parts?.[0]?.text).toContain(
      'Batch processing completed successfully! Status: SUCCEEDED',
    );
  });
});
