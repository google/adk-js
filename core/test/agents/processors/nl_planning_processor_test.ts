/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BasePlanner,
  BuiltInPlanner,
  Context,
  createEvent,
  createSession,
  Event,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PlanReActPlanner,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  NL_PLANNING_REQUEST_PROCESSOR,
  NL_PLANNING_RESPONSE_PROCESSOR,
} from '../../../src/agents/processors/nl_planning_processor.js';

class MockBaseAgent extends BaseAgent {
  constructor(name: string) {
    super({name});
  }
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

class StateUpdatingPlanner extends BasePlanner {
  constructor(
    private readonly stateUpdates: Record<string, unknown> = {},
    private readonly processedParts?: Part[],
  ) {
    super();
  }

  override buildPlanningInstruction(): string | undefined {
    return undefined;
  }

  override processPlanningResponse(
    callbackContext: Context,
    _responseParts: Part[],
  ): Part[] | undefined {
    for (const [key, value] of Object.entries(this.stateUpdates)) {
      callbackContext.state.set(key, value);
    }
    return this.processedParts;
  }
}

function createInvocationContext(
  agent: BaseAgent,
  events: Event[] = [],
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events,
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

function createLlmRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
    ...overrides,
  };
}

async function collectEvents<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const event of gen) {
    results.push(event);
  }
  return results;
}

function requestWithHistory(): LlmRequest {
  return createLlmRequest({
    contents: [
      {role: 'user', parts: [{text: 'hello'}]},
      {
        role: 'model',
        parts: [{text: '/*PLANNING*/plan', thought: true}, {text: 'answer'}],
      },
    ],
    config: {
      temperature: 0.3,
      systemInstruction: 'Be brief.',
      thinkingConfig: {thinkingBudget: 0},
    },
  });
}

describe('NlPlanningRequestProcessor', () => {
  it('leaves the request unchanged when the agent has no planner', async () => {
    const ctx = createInvocationContext(new LlmAgent({name: 'agent'}));
    const llmRequest = requestWithHistory();
    const expected = structuredClone(llmRequest);

    const events = await collectEvents(
      NL_PLANNING_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
    );

    expect(events).toHaveLength(0);
    expect(llmRequest).toEqual(expected);
  });

  it('leaves the request unchanged for a non-LlmAgent', async () => {
    const ctx = createInvocationContext(new MockBaseAgent('non-llm-agent'));
    const llmRequest = requestWithHistory();
    const expected = structuredClone(llmRequest);

    await collectEvents(
      NL_PLANNING_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
    );

    expect(llmRequest).toEqual(expected);
  });

  it('treats a planner that is not a BasePlanner as no planner', async () => {
    const agent = new LlmAgent({name: 'agent'});
    // A plain JavaScript caller can assign any value to the field.
    Reflect.set(agent, 'planner', {
      buildPlanningInstruction: () => 'plan first',
      processPlanningResponse: () => [{text: 'replaced'}],
    });
    const ctx = createInvocationContext(agent);
    const llmRequest = requestWithHistory();
    const expectedRequest = structuredClone(llmRequest);
    const llmResponse = createLlmResponse();
    const expectedResponse = structuredClone(llmResponse);

    await collectEvents(
      NL_PLANNING_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
    );
    await collectEvents(
      NL_PLANNING_RESPONSE_PROCESSOR.runAsync(ctx, llmResponse),
    );

    expect(llmRequest).toEqual(expectedRequest);
    expect(llmResponse).toEqual(expectedResponse);
  });

  it('applies the thinking config of a BuiltInPlanner', async () => {
    const thinkingConfig = {includeThoughts: true, thinkingBudget: 1024};
    const agent = new LlmAgent({
      name: 'agent',
      planner: new BuiltInPlanner({thinkingConfig}),
    });
    const llmRequest = createLlmRequest();

    await collectEvents(
      NL_PLANNING_REQUEST_PROCESSOR.runAsync(
        createInvocationContext(agent),
        llmRequest,
      ),
    );

    expect(llmRequest.config).toEqual({thinkingConfig});
  });

  it('overrides an existing thinking config and appends no instruction for a BuiltInPlanner', async () => {
    const thinkingConfig = {thinkingBudget: 2048};
    const agent = new LlmAgent({
      name: 'agent',
      planner: new BuiltInPlanner({thinkingConfig}),
    });
    const llmRequest = requestWithHistory();

    await collectEvents(
      NL_PLANNING_REQUEST_PROCESSOR.runAsync(
        createInvocationContext(agent),
        llmRequest,
      ),
    );

    expect(llmRequest.config?.thinkingConfig).toEqual(thinkingConfig);
    expect(llmRequest.config?.systemInstruction).toBe('Be brief.');
    expect(llmRequest.config?.temperature).toBe(0.3);
  });

  it('appends the PlanReAct instruction after the existing instruction', async () => {
    const planner = new PlanReActPlanner();
    const agent = new LlmAgent({name: 'agent', planner});
    const ctx = createInvocationContext(agent);
    const llmRequest = requestWithHistory();
    const planningInstruction = planner.buildPlanningInstruction(
      new ReadonlyContext(ctx),
      llmRequest,
    );

    await collectEvents(
      NL_PLANNING_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
    );

    expect(planningInstruction).toBeTruthy();
    expect(llmRequest.config?.systemInstruction).toBe(
      `Be brief.\n\n${planningInstruction}`,
    );
    expect(llmRequest.config?.thinkingConfig).toEqual({thinkingBudget: 0});
  });

  it('clears thought flags on the request without changing session events', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      planner: new PlanReActPlanner(),
    });
    const sessionEvent = createEvent({
      invocationId: 'earlier',
      author: 'agent',
      content: {
        role: 'model',
        parts: [
          {text: '/*PLANNING*/plan', thought: true},
          {text: '/*REASONING*/why', thought: true},
          {text: 'answer'},
        ],
      },
    });
    const ctx = createInvocationContext(agent, [sessionEvent]);
    const llmRequest = createLlmRequest({
      contents: [
        {role: 'user', parts: [{text: 'hello'}]},
        sessionEvent.content!,
        {role: 'user'},
      ],
    });

    await collectEvents(
      NL_PLANNING_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
    );

    for (const content of llmRequest.contents) {
      for (const part of content.parts ?? []) {
        expect(part).not.toHaveProperty('thought');
      }
    }
    expect(llmRequest.contents[1].parts).toEqual([
      {text: '/*PLANNING*/plan'},
      {text: '/*REASONING*/why'},
      {text: 'answer'},
    ]);
    expect(llmRequest.contents[2]).toEqual({role: 'user'});
    expect(sessionEvent.content?.parts).toEqual([
      {text: '/*PLANNING*/plan', thought: true},
      {text: '/*REASONING*/why', thought: true},
      {text: 'answer'},
    ]);
    expect(ctx.session.events[0].content?.parts?.[0].thought).toBe(true);
  });
});

function createLlmResponse(overrides: Partial<LlmResponse> = {}): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: [
        {text: '/*PLANNING*/make a plan'},
        {text: '/*REASONING*/because/*FINAL_ANSWER*/the answer'},
      ],
    },
    ...overrides,
  };
}

describe('NlPlanningResponseProcessor', () => {
  it('leaves the response unchanged when the agent has no planner', async () => {
    const ctx = createInvocationContext(new LlmAgent({name: 'agent'}));
    const llmResponse = createLlmResponse();
    const originalContent = llmResponse.content;
    const expected = structuredClone(llmResponse);

    const events = await collectEvents(
      NL_PLANNING_RESPONSE_PROCESSOR.runAsync(ctx, llmResponse),
    );

    expect(events).toHaveLength(0);
    expect(llmResponse).toEqual(expected);
    expect(llmResponse.content).toBe(originalContent);
  });

  it('leaves the response unchanged for a non-LlmAgent', async () => {
    const ctx = createInvocationContext(new MockBaseAgent('non-llm-agent'));
    const llmResponse = createLlmResponse();
    const expected = structuredClone(llmResponse);

    await collectEvents(
      NL_PLANNING_RESPONSE_PROCESSOR.runAsync(ctx, llmResponse),
    );

    expect(llmResponse).toEqual(expected);
  });

  it('replaces the parts with the PlanReAct-processed parts', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      planner: new PlanReActPlanner(),
    });
    const llmResponse = createLlmResponse();
    const originalContent = llmResponse.content!;
    const originalParts = structuredClone(originalContent.parts);

    await collectEvents(
      NL_PLANNING_RESPONSE_PROCESSOR.runAsync(
        createInvocationContext(agent),
        llmResponse,
      ),
    );

    expect(llmResponse.content).toEqual({
      role: 'model',
      parts: [
        {text: '/*PLANNING*/make a plan', thought: true},
        {text: '/*REASONING*/because/*FINAL_ANSWER*/', thought: true},
        {text: 'the answer'},
      ],
    });
    expect(llmResponse.content).not.toBe(originalContent);
    expect(originalContent.parts).toEqual(originalParts);
  });

  it('processes partial responses too', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      planner: new PlanReActPlanner(),
    });
    const llmResponse = createLlmResponse({
      partial: true,
      content: {role: 'model', parts: [{text: '/*PLANNING*/step one'}]},
    });

    await collectEvents(
      NL_PLANNING_RESPONSE_PROCESSOR.runAsync(
        createInvocationContext(agent),
        llmResponse,
      ),
    );

    expect(llmResponse.content?.parts).toEqual([
      {text: '/*PLANNING*/step one', thought: true},
    ]);
  });

  it('leaves the parts alone for a BuiltInPlanner', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      planner: new BuiltInPlanner({thinkingConfig: {includeThoughts: true}}),
    });
    const llmResponse = createLlmResponse();
    const originalContent = llmResponse.content;
    const originalParts = llmResponse.content!.parts;

    await collectEvents(
      NL_PLANNING_RESPONSE_PROCESSOR.runAsync(
        createInvocationContext(agent),
        llmResponse,
      ),
    );

    expect(llmResponse.content).toBe(originalContent);
    expect(llmResponse.content?.parts).toBe(originalParts);
  });

  it.each([
    ['missing content', {content: undefined}],
    ['content without parts', {content: {role: 'model'}}],
    ['empty parts', {content: {role: 'model', parts: []}}],
  ])('does nothing for %s', async (_name, overrides) => {
    const agent = new LlmAgent({
      name: 'agent',
      planner: new PlanReActPlanner(),
    });
    const llmResponse = createLlmResponse(overrides);
    const expected = structuredClone(llmResponse);

    await collectEvents(
      NL_PLANNING_RESPONSE_PROCESSOR.runAsync(
        createInvocationContext(agent),
        llmResponse,
      ),
    );

    expect(llmResponse).toEqual(expected);
  });

  it('yields a state-update event when the planner modifies state', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      planner: new StateUpdatingPlanner({planStep: 'step-1'}, [
        {text: 'processed'},
      ]),
    });
    const ctx = createInvocationContext(agent);
    ctx.branch = 'root.agent';
    const llmResponse = createLlmResponse();

    const events = await collectEvents(
      NL_PLANNING_RESPONSE_PROCESSOR.runAsync(ctx, llmResponse),
    );

    expect(llmResponse.content?.parts).toEqual([{text: 'processed'}]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      invocationId: 'test-invocation',
      author: 'agent',
      branch: 'root.agent',
      actions: {
        stateDelta: {planStep: 'step-1'},
      },
    });
  });

  it('updates response parts and yields no event when the planner does not modify state', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      planner: new StateUpdatingPlanner({}, [{text: 'processed'}]),
    });
    const ctx = createInvocationContext(agent);
    const llmResponse = createLlmResponse();

    const events = await collectEvents(
      NL_PLANNING_RESPONSE_PROCESSOR.runAsync(ctx, llmResponse),
    );

    expect(llmResponse.content?.parts).toEqual([{text: 'processed'}]);
    expect(events).toHaveLength(0);
  });
});
