/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v4';

import {BaseAgent, SingleAgentCallback} from '../../src/agents/base_agent.js';
import {Context} from '../../src/agents/context.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {createEvent, CreateEventParams, Event} from '../../src/events/event.js';
import {BaseLlm} from '../../src/models/base_llm.js';
import {BaseLlmConnection} from '../../src/models/base_llm_connection.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {AgentTool} from '../../src/tools/agent_tool.js';

class OneResponseModel extends BaseLlm {
  calls = 0;

  constructor(private readonly text = 'hello') {
    super({model: 'test-agent-tool'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.calls++;
    if (this.calls > 1) throw new Error('Unexpected second model call.');
    yield {content: {role: 'model', parts: [{text: this.text}]}};
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live mode is not used.');
  }
}

/** A custom agent exercising terminal events through the real Runner. */
class EventSequenceAgent extends BaseAgent {
  constructor(private readonly events: CreateEventParams[]) {
    super({name: 'event_agent'});
  }

  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    for (const event of this.events) {
      yield createEvent({
        ...event,
        author: this.name,
        invocationId: ctx.invocationId,
      });
    }
  }

  // eslint-disable-next-line require-yield
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    throw new Error('Live mode is not used.');
  }
}

async function runTool(agent: BaseAgent, abortSignal?: AbortSignal) {
  const sessions = new InMemorySessionService();
  const session = await sessions.createSession({
    appName: 'parent',
    userId: 'user',
    sessionId: 'session',
  });
  const toolContext = new Context({
    invocationContext: new InvocationContext({
      agent,
      session,
      sessionService: sessions,
      invocationId: 'parent-invocation',
      pluginManager: new PluginManager([]),
      abortSignal,
    }),
  });
  const result = await new AgentTool({agent}).runAsync({
    args: {request: 'go'},
    toolContext,
  });
  const childSession = await sessions.getSession({
    appName: agent.name,
    userId: session.userId,
    sessionId: session.id,
  });
  return {result, toolContext, childSession};
}

function stateOnly(ctx: Context) {
  ctx.state.set('audit', true);
  return undefined;
}

describe('AgentTool response selection through the real Runner', () => {
  for (const structured of [false, true]) {
    describe(structured ? 'structured output' : 'plain output', () => {
      for (const stateKey of [undefined, 'audit', 'temp:audit']) {
        it(
          stateKey === undefined
            ? 'returns the answer without a callback'
            : `preserves the answer after a callback writes ${stateKey}`,
          async () => {
            const text = structured ? '{"answer":"hello"}' : 'hello';
            const model = new OneResponseModel(text);
            const agent = new LlmAgent({
              name: 'child',
              model,
              ...(structured
                ? {outputSchema: z.object({answer: z.string()})}
                : {}),
              ...(stateKey === undefined
                ? {}
                : {
                    afterAgentCallback: (ctx: Context) => {
                      ctx.state.set(stateKey, true);
                      return undefined;
                    },
                  }),
            });
            const {result, toolContext, childSession} = await runTool(agent);

            expect(model.calls).toBe(1);
            const persistedAudit = stateKey === 'audit' ? true : undefined;
            expect(toolContext.state.get('audit')).toBe(persistedAudit);
            expect(childSession?.state['audit']).toBe(persistedAudit);
            expect(toolContext.state.has('temp:audit')).toBe(false);
            expect(childSession?.state['temp:audit']).toBeUndefined();
            if (stateKey !== undefined) {
              const tail = childSession!.events.at(-1)!;
              expect(tail.content).toBeUndefined();
              expect(tail.actions.stateDelta).toEqual(
                stateKey === 'audit' ? {audit: true} : {},
              );
            }
            expect(result).toEqual(structured ? {answer: 'hello'} : 'hello');
          },
        );
      }
    });
  }

  it.each<{name: string; content: Content; expected: string}>([
    {
      name: 'replacement text',
      content: {parts: [{text: 'replacement'}]},
      expected: 'replacement',
    },
    {name: 'explicit empty Content', content: {parts: []}, expected: ''},
    {
      name: 'thought-only Content',
      content: {parts: [{text: 'thought', thought: true}]},
      expected: '',
    },
  ])('keeps the existing result for $name', async ({content, expected}) => {
    const agent = new LlmAgent({
      name: 'child',
      model: new OneResponseModel(),
      afterAgentCallback: (ctx) => {
        ctx.state.set('audit', true);
        return content;
      },
    });
    const {result, toolContext} = await runTool(agent);
    expect(toolContext.state.get('audit')).toBe(true);
    expect(result).toBe(expected);
  });

  it.each<SingleAgentCallback>([
    (ctx) => {
      stateOnly(ctx);
      ctx.actions.escalate = true;
      return undefined;
    },
    (ctx) => {
      stateOnly(ctx);
      ctx.actions.skipSummarization = false;
      return undefined;
    },
    (ctx) => {
      stateOnly(ctx);
      ctx.actions.endOfAgent = true;
      return undefined;
    },
  ])(
    'does not fall back when the callback also emits a control action (%#)',
    async (afterAgentCallback) => {
      const agent = new LlmAgent({
        name: 'child',
        model: new OneResponseModel(),
        afterAgentCallback,
      });
      const {result, toolContext} = await runTool(agent);
      expect(toolContext.state.get('audit')).toBe(true);
      expect(result).toBe('');
    },
  );

  it.each<CreateEventParams>([
    {errorCode: 'TEST_ERROR'},
    {errorMessage: 'failed'},
  ])(
    'does not fall back after an error event with a state delta (%#)',
    async (error) => {
      const agent = new EventSequenceAgent([
        {content: {role: 'model', parts: [{text: 'hello'}]}},
        {...error, actions: {stateDelta: {audit: true}}},
      ]);
      const {result, toolContext} = await runTool(agent);
      expect(toolContext.state.get('audit')).toBe(true);
      expect(result).toBe('');
    },
  );

  it('does not return an earlier answer when the callback aborts the run', async () => {
    const controller = new AbortController();
    const model = new OneResponseModel();
    const agent = new LlmAgent({
      name: 'child',
      model,
      afterAgentCallback: (ctx) => {
        ctx.state.set('audit', true);
        controller.abort();
        return undefined;
      },
    });
    const {result, childSession} = await runTool(agent, controller.signal);
    expect(model.calls).toBe(1);
    expect(
      childSession?.events.some(
        (event) => event.content?.parts?.[0]?.text === 'hello',
      ),
    ).toBe(true);
    expect(result).toBeUndefined();
  });

  it('keeps the empty result when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const model = new OneResponseModel();
    const {result} = await runTool(
      new LlmAgent({name: 'child', model}),
      controller.signal,
    );
    expect(model.calls).toBe(0);
    expect(result).toBe('');
  });

  it('keeps the empty result when the agent only emits state', async () => {
    const {result, toolContext} = await runTool(
      new EventSequenceAgent([{actions: {stateDelta: {audit: true}}}]),
    );
    expect(toolContext.state.get('audit')).toBe(true);
    expect(result).toBe('');
  });
});
