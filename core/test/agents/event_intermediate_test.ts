/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  createEvent,
  Event,
  FunctionTool,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Runner,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

// ---------------------------------------------------------------------------
// Unit tests — Event.intermediate field
// ---------------------------------------------------------------------------

describe('Event.intermediate field', () => {
  it('is undefined by default in createEvent', () => {
    const event = createEvent();
    expect(event.intermediate).toBeUndefined();
  });

  it('is preserved when set via createEvent', () => {
    const event = createEvent({intermediate: true});
    expect(event.intermediate).toBe(true);
  });

  it('can be set to false', () => {
    const event = createEvent({intermediate: false});
    expect(event.intermediate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — LlmAgent marks intermediate events
// ---------------------------------------------------------------------------

/**
 * A mock LLM that returns responses from a queue in order.
 */
class QueuedMockLlm extends BaseLlm {
  private readonly queue: LlmResponse[];

  constructor(responses: LlmResponse[]) {
    super({model: 'mock-llm'});
    this.queue = [...responses];
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const response = this.queue.shift();
    if (response) {
      yield response;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('connect() not supported in QueuedMockLlm');
  }
}

const APP_NAME = 'test-app';
const USER_ID = 'test-user';

describe('LlmAgent.runAsyncImpl intermediate flag', () => {
  let sessionService: InMemorySessionService;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
  });

  async function runAgent(agent: LlmAgent): Promise<Event[]> {
    const runner = new Runner({appName: APP_NAME, agent, sessionService});
    const session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'go'}]},
    })) {
      events.push(event);
    }
    return events;
  }

  it('does not mark events as intermediate when agent responds in one step', async () => {
    const agent = new LlmAgent({
      name: 'single-step-agent',
      model: new QueuedMockLlm([
        {content: {role: 'model', parts: [{text: 'Hello!'}]}},
      ]),
    });

    const events = await runAgent(agent);

    const modelEvents = events.filter((e) => e.author === 'single-step-agent');
    expect(modelEvents.length).toBeGreaterThan(0);
    for (const event of modelEvents) {
      expect(event.intermediate).toBeUndefined();
    }
  });

  it('marks events as intermediate when the step contains a function call', async () => {
    const noopTool = new FunctionTool({
      name: 'noop',
      description: 'Does nothing.',
      execute: async () => 'ok',
    });

    const agent = new LlmAgent({
      name: 'multi-step-agent',
      model: new QueuedMockLlm([
        // Step 1: function call → not a final response → intermediate
        {
          content: {
            role: 'model',
            parts: [{functionCall: {name: 'noop', args: {}}}],
          },
        },
        // Step 2: text → final response → not intermediate
        {content: {role: 'model', parts: [{text: 'Done!'}]}},
      ]),
      tools: [noopTool],
    });

    const events = await runAgent(agent);

    // Events from step 1 (function call + function response) are intermediate
    const step1Events = events.filter(
      (e) =>
        e.content?.parts?.some((p) => p.functionCall) ||
        e.content?.parts?.some((p) => p.functionResponse),
    );
    expect(step1Events.length).toBeGreaterThan(0);
    for (const event of step1Events) {
      expect(event.intermediate).toBe(true);
    }

    // The final text response is not intermediate
    const finalEvent = events.find((e) =>
      e.content?.parts?.some((p) => p.text === 'Done!'),
    );
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.intermediate).toBeUndefined();
  });
});
