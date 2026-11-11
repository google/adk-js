/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CompiledGraphLike,
  Event,
  InvocationContext,
  LangGraphAIMessage,
  LangGraphAgent,
  LangGraphHumanMessage,
  LangGraphMessageLike,
  LangGraphSystemMessage,
  LoopAgent,
  PluginManager,
  createEvent,
  createSession,
  getLastHumanMessages,
  isLangGraphAgent,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

interface LangGraphAgentTestCase {
  readonly name: string;
  readonly hasCheckpointer: boolean;
  readonly rawEvents: ReadonlyArray<readonly [string, string]>;
  readonly expectedMessages: ReadonlyArray<
    LangGraphSystemMessage | LangGraphHumanMessage | LangGraphAIMessage
  >;
}

function createEvents(
  rawEvents: ReadonlyArray<readonly [string, string]>,
): Event[] {
  return rawEvents.map(([author, text]) =>
    createEvent({
      invocationId: 'test_invocation_id',
      author,
      content: {
        role: author === 'user' ? 'user' : 'model',
        parts: [{text}],
      },
    }),
  );
}

describe('LangGraphAgent', () => {
  const testCases: readonly LangGraphAgentTestCase[] = [
    {
      name: 'single-turn with checkpointer',
      hasCheckpointer: true,
      rawEvents: [
        ['user', 'test prompt'],
        ['root_agent', '(some delegation)'],
      ],
      expectedMessages: [
        {type: 'system', content: 'test system prompt'},
        {type: 'human', content: 'test prompt'},
      ],
    },
    {
      name: 'multi-turn without checkpointer',
      hasCheckpointer: false,
      rawEvents: [
        ['user', 'user prompt 1'],
        ['root_agent', 'root agent response'],
        ['weather_agent', 'weather agent response'],
        ['user', 'user prompt 2'],
      ],
      expectedMessages: [
        {type: 'system', content: 'test system prompt'},
        {type: 'human', content: 'user prompt 1'},
        {type: 'ai', content: 'weather agent response'},
        {type: 'human', content: 'user prompt 2'},
      ],
    },
    {
      name: 'multi-turn with checkpointer',
      hasCheckpointer: true,
      rawEvents: [
        ['user', 'user prompt 1'],
        ['root_agent', 'root agent response'],
        ['weather_agent', 'weather agent response'],
        ['user', 'user prompt 2'],
      ],
      expectedMessages: [
        {type: 'system', content: 'test system prompt'},
        {type: 'human', content: 'user prompt 2'},
      ],
    },
  ];

  it.each(testCases)(
    'test_langgraph_agent ($name)',
    async ({hasCheckpointer, rawEvents, expectedMessages}) => {
      const mockGraph: CompiledGraphLike = {
        getGraph: vi.fn(),
        checkpointer: hasCheckpointer ? {} : undefined,
        invoke: vi.fn().mockReturnValue({
          messages: [
            {type: 'ai', content: 'test response'} satisfies LangGraphAIMessage,
          ],
        }),
        getState: vi.fn().mockReturnValue({values: {}}),
      };

      const session = createSession({
        id: 'test_session',
        appName: 'test_app',
        userId: 'test_user',
        state: {},
        events: createEvents(rawEvents),
      });

      const weatherAgent = new LangGraphAgent({
        name: 'weather_agent',
        description: 'A agent that answers weather questions',
        instruction: 'test system prompt',
        graph: mockGraph,
      });

      const parentContext = new InvocationContext({
        invocationId: 'test_invocation_id',
        branch: 'parent_agent',
        agent: weatherAgent,
        session,
        pluginManager: new PluginManager(),
      });

      const yieldedEvents: Event[] = [];
      for await (const event of weatherAgent.runAsync(parentContext)) {
        yieldedEvents.push(event);
      }

      expect(yieldedEvents).toHaveLength(1);
      expect(yieldedEvents[0].author).toBe('weather_agent');
      expect(yieldedEvents[0].branch).toBe('parent_agent');
      expect(yieldedEvents[0].content).toEqual({
        role: 'model',
        parts: [{text: 'test response'}],
      });

      expect(mockGraph.invoke).toHaveBeenCalledTimes(1);
      expect(mockGraph.invoke).toHaveBeenCalledWith(
        {messages: expectedMessages},
        {configurable: {thread_id: 'test_session'}},
      );
      if (hasCheckpointer) {
        expect(mockGraph.getState).toHaveBeenCalledWith({
          configurable: {thread_id: 'test_session'},
        });
      } else {
        expect(mockGraph.getState).not.toHaveBeenCalled();
      }
    },
  );

  it('does not prepend SystemMessage when graph state already contains messages via getState', async () => {
    const mockGraph: CompiledGraphLike = {
      getGraph: vi.fn(),
      checkpointer: {},
      invoke: vi.fn().mockResolvedValue({
        messages: [{type: 'ai', content: 'Done'} satisfies LangGraphAIMessage],
      }),
      getState: vi.fn().mockResolvedValue({
        values: {
          messages: [
            {
              type: 'system',
              content: 'existing system prompt',
            } satisfies LangGraphSystemMessage,
          ],
        },
      }),
    };

    const session = createSession({
      id: 'session_existing_state',
      appName: 'test_app',
      userId: 'test_user',
      state: {},
      events: createEvents([['user', 'follow up']]),
    });

    const agent = new LangGraphAgent({
      name: 'weather_agent',
      instruction: 'test instruction',
      graph: mockGraph,
    });

    const context = new InvocationContext({
      invocationId: 'inv-2',
      agent,
      session,
      pluginManager: new PluginManager(),
    });

    const yieldedEvents: Event[] = [];
    for await (const event of agent.runAsync(context)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents).toHaveLength(1);
    expect(mockGraph.invoke).toHaveBeenCalledWith(
      {messages: [{type: 'human', content: 'follow up'}]},
      {configurable: {thread_id: 'session_existing_state'}},
    );
  });

  it('skips getState when checkpointer is absent and extracts text from structured content parts', async () => {
    const getState = vi
      .fn()
      .mockRejectedValue(new Error('No checkpointer set'));
    const mockGraph: CompiledGraphLike = {
      checkpointer: undefined,
      getState,
      invoke: vi.fn().mockResolvedValue({
        messages: [
          {
            type: 'ai',
            content: [
              'Hello ',
              {type: 'text', text: 'world'},
              {type: 'image_url'},
              {type: 'text', text: '!'},
            ],
          } satisfies LangGraphAIMessage,
        ],
      }),
    };

    const session = createSession({
      id: 'session_no_cp',
      appName: 'test_app',
      userId: 'test_user',
      state: {},
      events: createEvents([['user', 'structured output please']]),
    });

    const agent = new LangGraphAgent({
      name: 'structured_agent',
      instruction: 'system prompt',
      graph: mockGraph,
    });

    const context = new InvocationContext({
      invocationId: 'inv-structured',
      agent,
      session,
      pluginManager: new PluginManager(),
    });

    const yieldedEvents: Event[] = [];
    for await (const event of agent.runAsync(context)) {
      yieldedEvents.push(event);
    }

    expect(getState).not.toHaveBeenCalled();
    expect(yieldedEvents).toHaveLength(1);
    expect(yieldedEvents[0].content).toEqual({
      role: 'model',
      parts: [{text: 'Hello world!'}],
    });
  });

  it('persists multi-turn state across invocations using a checkpointer keyed by configurable.thread_id', async () => {
    const checkpoints = new Map<string, LangGraphMessageLike[]>();
    const invokedInputs: ReadonlyArray<LangGraphMessageLike>[] = [];

    const statefulGraph: CompiledGraphLike = {
      checkpointer: checkpoints,
      getState: async (config) => {
        const threadId = config.configurable.thread_id;
        if (!threadId) {
          throw new Error('Thread ID is required by checkpointer.');
        }
        return {
          values: {
            messages: checkpoints.get(threadId) ?? [],
          },
        };
      },
      invoke: async ({messages}, config) => {
        const threadId = config.configurable.thread_id;
        if (!threadId) {
          throw new Error('Thread ID is required by checkpointer.');
        }
        invokedInputs.push(messages);
        const existing = checkpoints.get(threadId) ?? [];
        const reply: LangGraphAIMessage = {
          type: 'ai',
          content: `Turn ${existing.length + 1} reply`,
        };
        const updated = [...existing, ...messages, reply];
        checkpoints.set(threadId, updated);
        return {messages: updated};
      },
    };

    const agent = new LangGraphAgent({
      name: 'stateful_agent',
      instruction: 'Persist across turns.',
      graph: statefulGraph,
    });

    const session = createSession({
      id: 'thread-42',
      appName: 'test_app',
      userId: 'test_user',
      state: {},
      events: createEvents([['user', 'turn 1 question']]),
    });

    const firstTurnEvents: Event[] = [];
    for await (const event of agent.runAsync(
      new InvocationContext({
        invocationId: 'inv-t1',
        agent,
        session,
        pluginManager: new PluginManager(),
      }),
    )) {
      firstTurnEvents.push(event);
      session.events.push(event);
    }

    session.events.push(...createEvents([['user', 'turn 2 question']]));

    const secondTurnEvents: Event[] = [];
    for await (const event of agent.runAsync(
      new InvocationContext({
        invocationId: 'inv-t2',
        agent,
        session,
        pluginManager: new PluginManager(),
      }),
    )) {
      secondTurnEvents.push(event);
    }

    expect(invokedInputs).toEqual([
      [
        {type: 'system', content: 'Persist across turns.'},
        {type: 'human', content: 'turn 1 question'},
      ],
      [{type: 'human', content: 'turn 2 question'}],
    ]);
    expect(firstTurnEvents[0].content?.parts?.[0]?.text).toBe('Turn 1 reply');
    expect(secondTurnEvents[0].content?.parts?.[0]?.text).toBe('Turn 4 reply');
  });

  it('collects consecutive trailing user events in getLastHumanMessages', () => {
    const events = createEvents([
      ['user', 'first'],
      ['agent', 'reply'],
      ['user', 'second'],
      ['user', 'third'],
    ]);

    const messages: LangGraphMessageLike[] = getLastHumanMessages(events);
    expect(messages).toEqual([
      {type: 'human', content: 'second'},
      {type: 'human', content: 'third'},
    ]);
  });

  it('identifies LangGraphAgent via isLangGraphAgent and clones configuration', () => {
    const mockGraph: CompiledGraphLike = {
      getGraph: vi.fn(),
      invoke: vi.fn(),
      getState: vi.fn(),
    };

    const agent = new LangGraphAgent({
      name: 'lg_agent',
      instruction: 'initial instruction',
      graph: mockGraph,
    });

    expect(isLangGraphAgent(agent)).toBe(true);
    expect(isLangGraphAgent(new LoopAgent({name: 'loop'}))).toBe(false);
    expect(isLangGraphAgent(null)).toBe(false);

    const cloned = agent.clone({name: 'lg_agent_clone'});
    expect(isLangGraphAgent(cloned)).toBe(true);
    expect(cloned.name).toBe('lg_agent_clone');
    expect(cloned.instruction).toBe('initial instruction');
    expect(cloned.graph).toBe(mockGraph);
  });

  it('throws when runLive is called on LangGraphAgent', async () => {
    const mockGraph: CompiledGraphLike = {
      getGraph: vi.fn(),
      invoke: vi.fn(),
      getState: vi.fn(),
    };

    const agent = new LangGraphAgent({
      name: 'lg_agent',
      graph: mockGraph,
    });

    const context = new InvocationContext({
      invocationId: 'inv-live',
      agent,
      session: createSession({
        id: 's1',
        appName: 'app',
        userId: 'u1',
      }),
      pluginManager: new PluginManager(),
    });

    const runLive = async () => {
      for await (const _event of agent.runLive(context)) {
        // Should throw before yielding.
      }
    };

    await expect(runLive()).rejects.toThrowError(
      'This is not supported yet for LangGraphAgent.',
    );
  });

  it('throws when graph.invoke returns an empty messages array', async () => {
    const mockGraph: CompiledGraphLike = {
      invoke: vi.fn().mockResolvedValue({messages: []}),
    };

    const agent = new LangGraphAgent({
      name: 'empty_agent',
      graph: mockGraph,
    });

    const context = new InvocationContext({
      invocationId: 'inv-empty',
      agent,
      session: createSession({
        id: 's-empty',
        appName: 'app',
        userId: 'u1',
      }),
      pluginManager: new PluginManager(),
    });

    const run = async () => {
      for await (const _event of agent.runAsync(context)) {
        // Expect failure before yielding.
      }
    };

    await expect(run()).rejects.toThrowError(
      "LangGraphAgent 'empty_agent' received no messages from graph.invoke().",
    );
  });

  it('throws when checkpointer is configured without getState', async () => {
    const mockGraph: CompiledGraphLike = {
      checkpointer: {},
      invoke: vi.fn().mockResolvedValue({
        messages: [{type: 'ai', content: 'ok'} satisfies LangGraphAIMessage],
      }),
    };

    const agent = new LangGraphAgent({
      name: 'missing_get_state_agent',
      instruction: 'system instruction',
      graph: mockGraph,
    });

    const context = new InvocationContext({
      invocationId: 'inv-no-getstate',
      agent,
      session: createSession({
        id: 's-no-getstate',
        appName: 'app',
        userId: 'u1',
      }),
      pluginManager: new PluginManager(),
    });

    const run = async () => {
      for await (const _event of agent.runAsync(context)) {
        // Expect failure before yielding.
      }
    };

    await expect(run()).rejects.toThrowError(
      "LangGraphAgent 'missing_get_state_agent' requires graph.getState() when graph.checkpointer is configured.",
    );
  });
});
