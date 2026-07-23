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
  createSession,
  Event,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PlanReActPlanner,
  PluginManager,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  NL_PLANNING_REQUEST_PROCESSOR,
  NL_PLANNING_RESPONSE_PROCESSOR,
} from '../../../src/agents/processors/nl_planning_processor.js';
import {PLANNING_TAG} from '../../../src/planners/plan_re_act_planner.js';

class MockNonLlmAgent extends BaseAgent {
  constructor(name: string) {
    super({name});
  }
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

/** A subclass of BuiltInPlanner that overrides processPlanningResponse. */
class OverriddenBuiltInPlanner extends BuiltInPlanner {
  processPlanningResponseCalled = false;
  receivedParts?: Part[];

  override processPlanningResponse(
    _callbackContext: Context,
    responseParts: Part[],
  ): Part[] | undefined {
    this.processPlanningResponseCalled = true;
    this.receivedParts = responseParts;
    return responseParts;
  }
}

/** A subclass of BuiltInPlanner that does NOT override processPlanningResponse. */
class NonOverriddenBuiltInPlanner extends BuiltInPlanner {}

/** A custom planner that writes to the callback state during processing. */
class StatefulPlanner extends BasePlanner {
  override buildPlanningInstruction(): undefined {
    return undefined;
  }
  override processPlanningResponse(
    callbackContext: Context,
    responseParts: Part[],
  ): Part[] {
    callbackContext.state.set('planner_key', 'planner_value');
    return responseParts;
  }
}

function createInvocationContext(agent: BaseAgent): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

function createLlmRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}, ...overrides};
}

async function drainRequest(
  ctx: InvocationContext,
  llmRequest: LlmRequest,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of NL_PLANNING_REQUEST_PROCESSOR.runAsync(
    ctx,
    llmRequest,
  )) {
    events.push(event);
  }
  return events;
}

async function drainResponse(
  ctx: InvocationContext,
  llmResponse: LlmResponse,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of NL_PLANNING_RESPONSE_PROCESSOR.runAsync(
    ctx,
    llmResponse,
  )) {
    events.push(event);
  }
  return events;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NlPlanningRequestProcessor', () => {
  it('applies the thinking config for a BuiltInPlanner', async () => {
    const planner = new BuiltInPlanner({
      thinkingConfig: {includeThoughts: true},
    });
    const applySpy = vi.spyOn(planner, 'applyThinkingConfig');
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      planner,
    });
    const ctx = createInvocationContext(agent);
    const llmRequest = createLlmRequest();

    await drainRequest(ctx, llmRequest);

    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledWith(llmRequest);
    expect(llmRequest.config?.thinkingConfig).toBe(planner.thinkingConfig);
  });

  it('leaves the request content list unchanged for a BuiltInPlanner', async () => {
    const planner = new BuiltInPlanner({thinkingConfig: {}});
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      planner,
    });
    const ctx = createInvocationContext(agent);
    const contents: Content[] = [
      {role: 'user', parts: [{text: 'Hello'}]},
      {
        role: 'model',
        parts: [
          {text: 'thinking...', thought: true},
          {text: 'Here is my response'},
        ],
      },
    ];
    const llmRequest = createLlmRequest({contents});
    const snapshot = structuredClone(contents);

    await drainRequest(ctx, llmRequest);

    expect(llmRequest.contents).toEqual(snapshot);
  });

  it('appends the planning instruction for a PlanReActPlanner', async () => {
    const planner = new PlanReActPlanner();
    vi.spyOn(planner, 'buildPlanningInstruction').mockReturnValue(
      'Test instruction',
    );
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      planner,
    });
    const ctx = createInvocationContext(agent);
    const llmRequest = createLlmRequest({
      config: {systemInstruction: 'Original instruction'},
    });

    await drainRequest(ctx, llmRequest);

    expect(llmRequest.config?.systemInstruction).toBe(
      'Original instruction\n\nTest instruction',
    );
  });

  it('appends the real NL planning instruction for a PlanReActPlanner', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      planner: new PlanReActPlanner(),
    });
    const ctx = createInvocationContext(agent);
    const llmRequest = createLlmRequest();

    await drainRequest(ctx, llmRequest);

    expect(llmRequest.config?.systemInstruction).toContain(PLANNING_TAG);
  });

  it('does not append when the planning instruction is empty', async () => {
    const planner = new PlanReActPlanner();
    vi.spyOn(planner, 'buildPlanningInstruction').mockReturnValue('');
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      planner,
    });
    const ctx = createInvocationContext(agent);
    const llmRequest = createLlmRequest();

    await drainRequest(ctx, llmRequest);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('removes thought flags from all history parts for a PlanReActPlanner', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      planner: new PlanReActPlanner(),
    });
    const ctx = createInvocationContext(agent);
    const llmRequest = createLlmRequest({
      contents: [
        {role: 'user', parts: [{text: 'initial query'}]},
        {
          role: 'model',
          parts: [
            {text: 'Text with thought', thought: true},
            {text: 'Regular text'},
          ],
        },
        {role: 'model'}, // content with no parts (exercises the `?? []` guard)
        {role: 'user', parts: [{text: 'follow up'}]},
      ],
    });

    await drainRequest(ctx, llmRequest);

    const allThoughtsCleared = llmRequest.contents.every((content) =>
      (content.parts ?? []).every((part) => part.thought === undefined),
    );
    expect(allThoughtsCleared).toBe(true);
  });

  it('tolerates a request without contents for a PlanReActPlanner', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      planner: new PlanReActPlanner(),
    });
    const ctx = createInvocationContext(agent);
    const llmRequest = createLlmRequest({
      contents: undefined as unknown as Content[],
    });

    await expect(drainRequest(ctx, llmRequest)).resolves.toEqual([]);
  });

  it('is a no-op for a custom BasePlanner subclass', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      planner: new StatefulPlanner(),
    });
    const ctx = createInvocationContext(agent);
    const llmRequest = createLlmRequest({
      config: {systemInstruction: 'Original instruction'},
    });

    await drainRequest(ctx, llmRequest);

    expect(llmRequest.config?.systemInstruction).toBe('Original instruction');
  });

  it('resolves a truthy non-BasePlanner value to a PlanReActPlanner', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    });
    // Simulate a planner value that is not a BasePlanner instance.
    (agent as {planner?: unknown}).planner = {notA: 'planner'};
    const ctx = createInvocationContext(agent);
    const llmRequest = createLlmRequest();

    await drainRequest(ctx, llmRequest);

    expect(llmRequest.config?.systemInstruction).toContain(PLANNING_TAG);
  });

  it('is a no-op when the agent has no planner', async () => {
    const agent = new LlmAgent({name: 'test_agent', model: 'gemini-2.5-flash'});
    const ctx = createInvocationContext(agent);
    const llmRequest = createLlmRequest({
      config: {systemInstruction: 'Original instruction'},
    });

    await drainRequest(ctx, llmRequest);

    expect(llmRequest.config?.systemInstruction).toBe('Original instruction');
  });

  it('is a no-op when the agent is not an LlmAgent', async () => {
    const agent = new MockNonLlmAgent('non_llm_agent');
    const ctx = createInvocationContext(agent);
    const llmRequest = createLlmRequest({
      config: {systemInstruction: 'Original instruction'},
    });

    await drainRequest(ctx, llmRequest);

    expect(llmRequest.config?.systemInstruction).toBe('Original instruction');
  });
});

describe('NlPlanningResponseProcessor', () => {
  const responseParts: Part[] = [
    {text: 'thinking...', thought: true},
    {text: 'Here is my response'},
  ];

  function modelResponse(parts: Part[]): LlmResponse {
    return {content: {role: 'model', parts}};
  }

  it('calls an overriding subclass of BuiltInPlanner (issue #4133)', async () => {
    const planner = new OverriddenBuiltInPlanner({thinkingConfig: {}});
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      planner,
    });
    const ctx = createInvocationContext(agent);
    const parts = [...responseParts];

    await drainResponse(ctx, modelResponse(parts));

    expect(planner.processPlanningResponseCalled).toBe(true);
    expect(planner.receivedParts).toEqual(parts);
  });

  it.each([
    ['base BuiltInPlanner', () => new BuiltInPlanner({thinkingConfig: {}})],
    [
      'non-overriding subclass',
      () => new NonOverriddenBuiltInPlanner({thinkingConfig: {}}),
    ],
  ])(
    'does not call processPlanningResponse for %s',
    async (_label, makePlanner) => {
      const spy = vi.spyOn(BuiltInPlanner.prototype, 'processPlanningResponse');
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'gemini-2.5-flash',
        planner: makePlanner(),
      });
      const ctx = createInvocationContext(agent);

      await drainResponse(ctx, modelResponse([...responseParts]));

      expect(spy).not.toHaveBeenCalled();
    },
  );

  it('reassigns the processed parts for a PlanReActPlanner', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      planner: new PlanReActPlanner(),
    });
    const ctx = createInvocationContext(agent);
    const originalParts: Part[] = [
      {text: `${PLANNING_TAG} my plan`},
      {text: 'regular text'},
    ];
    const llmResponse = modelResponse(originalParts);

    await drainResponse(ctx, llmResponse);

    expect(llmResponse.content?.parts).not.toBe(originalParts);
    expect(llmResponse.content?.parts?.[0].thought).toBe(true);
    expect(llmResponse.content?.parts?.[1].thought).toBeUndefined();
  });

  it('does not reassign parts when the planner returns nothing', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      planner: new PlanReActPlanner(),
    });
    const ctx = createInvocationContext(agent);
    const emptyParts: Part[] = [];
    const llmResponse = modelResponse(emptyParts);

    const events = await drainResponse(ctx, llmResponse);

    expect(llmResponse.content?.parts).toBe(emptyParts);
    expect(events).toEqual([]);
  });

  it('yields a state-delta event when the planner mutates state', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      planner: new StatefulPlanner(),
    });
    const ctx = createInvocationContext(agent);

    const events = await drainResponse(ctx, modelResponse([...responseParts]));

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('test_agent');
    expect(events[0].actions.stateDelta['planner_key']).toBe('planner_value');
  });

  it('is a no-op when the agent has no planner', async () => {
    const agent = new LlmAgent({name: 'test_agent', model: 'gemini-2.5-flash'});
    const ctx = createInvocationContext(agent);
    const originalParts = [...responseParts];
    const llmResponse = modelResponse(originalParts);

    const events = await drainResponse(ctx, llmResponse);

    expect(events).toEqual([]);
    expect(llmResponse.content?.parts).toBe(originalParts);
  });

  it('early-returns when the response has no content', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      planner: new PlanReActPlanner(),
    });
    const ctx = createInvocationContext(agent);

    expect(await drainResponse(ctx, {})).toEqual([]);
  });

  it('early-returns when the response content has no parts', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      planner: new PlanReActPlanner(),
    });
    const ctx = createInvocationContext(agent);

    expect(await drainResponse(ctx, {content: {role: 'model'}})).toEqual([]);
  });

  it('early-returns when the response itself is missing', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      planner: new PlanReActPlanner(),
    });
    const ctx = createInvocationContext(agent);

    expect(
      await drainResponse(ctx, undefined as unknown as LlmResponse),
    ).toEqual([]);
  });
});
