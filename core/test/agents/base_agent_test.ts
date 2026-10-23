/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTransferLlmRequestProcessor,
  BaseAgent,
  BaseAgentConfig,
  BasePlugin,
  Context,
  Event,
  FunctionTool,
  InMemoryArtifactService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ScopedArtifactService,
  Session,
  SingleAgentCallback,
  createEvent,
  createSession,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';

class MockAgent extends BaseAgent {
  constructor(config: BaseAgentConfig) {
    super(config);
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {role: 'model', parts: [{text: `Response from ${this.name}`}]},
    });
  }

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {
        role: 'model',
        parts: [{text: `Live response from ${this.name}`}],
      },
    });
  }
}

describe('BaseAgent', () => {
  describe('rootAgent', () => {
    it('should return the actual root agent for sub-agents', () => {
      const subAgent = new LlmAgent({
        name: 'sub_agent',
        description: 'A sub agent',
      });

      const rootAgent = new LlmAgent({
        name: 'root_agent',
        description: 'The root agent',
        subAgents: [subAgent],
      });

      expect(subAgent.rootAgent).toBe(rootAgent);
      expect(rootAgent.rootAgent).toBe(rootAgent);
    });

    it('should traverse multiple levels of nesting', () => {
      const leafAgent = new LlmAgent({name: 'leaf_agent'});
      const middleAgent = new LlmAgent({
        name: 'middle_agent',
        subAgents: [leafAgent],
      });
      const rootAgent = new LlmAgent({
        name: 'root_agent',
        subAgents: [middleAgent],
      });

      expect(leafAgent.rootAgent).toBe(rootAgent);
      expect(middleAgent.rootAgent).toBe(rootAgent);
      expect(rootAgent.rootAgent).toBe(rootAgent);
    });
  });

  describe('Abort Signal Handling', () => {
    it('should stop processing beforeAgentCallbacks if aborted', async () => {
      const controller = new AbortController();
      let callback2Called = false;

      const agent = new MockAgent({
        name: 'test_agent',
        beforeAgentCallback: [
          async () => {
            controller.abort();
            return undefined;
          },
          async () => {
            callback2Called = true;
            return undefined;
          },
        ],
      });

      const parentContext = new InvocationContext({
        invocationId: 'test',
        agent: agent,
        session: {
          id: 'test-session',
          appName: 'test-app',
          userId: 'test-user',
          state: {},
          events: [],
          lastUpdateTime: Date.now(),
        } as Session,
        pluginManager: new PluginManager(),
        abortSignal: controller.signal,
      });

      const generator = agent.runAsync(parentContext);

      for await (const _ of generator) {
        // do nothing
      }

      expect(callback2Called).toBe(false);
    });

    it('should stop processing afterAgentCallbacks if aborted', async () => {
      const controller = new AbortController();
      let callback2Called = false;

      const agent = new MockAgent({
        name: 'test_agent',
        afterAgentCallback: [
          async () => {
            controller.abort();
            return undefined;
          },
          async () => {
            callback2Called = true;
            return undefined;
          },
        ],
      });

      const parentContext = new InvocationContext({
        invocationId: 'test',
        agent: agent,
        session: {
          id: 'test-session',
          appName: 'test-app',
          userId: 'test-user',
          state: {},
          events: [],
          lastUpdateTime: Date.now(),
        } as Session,
        pluginManager: new PluginManager(),
        abortSignal: controller.signal,
      });

      const generator = agent.runAsync(parentContext);

      for await (const _ of generator) {
        // do nothing
      }

      expect(callback2Called).toBe(false);
    });
  });

  describe('clone', () => {
    const makeTool = (name: string) =>
      new FunctionTool({
        name,
        description: `tool ${name}`,
        execute: async () => 'ok',
      });

    it('returns a new, equivalent instance when given no overrides', () => {
      const tool = makeTool('search');
      const agent = new LlmAgent({
        name: 'original',
        description: 'the original agent',
        instruction: 'be helpful',
        model: 'gemini-2.5-flash',
        tools: [tool],
      });

      const clone = agent.clone();

      expect(clone).not.toBe(agent);
      expect(clone).toBeInstanceOf(LlmAgent);
      expect(clone.name).toBe('original');
      expect(clone.description).toBe('the original agent');
      expect(clone.instruction).toBe('be helpful');
      expect(clone.model).toBe('gemini-2.5-flash');
      expect(clone.tools).toEqual([tool]);
    });

    it('shallow-copies list fields so clones never share arrays', () => {
      const tool = makeTool('search');
      const agent = new LlmAgent({name: 'original', tools: [tool]});

      const clone = agent.clone();

      // Different array object, same tool instances (shallow copy).
      expect(clone.tools).not.toBe(agent.tools);
      expect(clone.tools[0]).toBe(tool);
    });

    it('rebuilds a single agent-transfer processor (no duplication)', () => {
      const agent = new LlmAgent({name: 'original', instruction: 'hi'});

      const clone = agent.clone();

      const countTransfer = (a: LlmAgent) =>
        a.requestProcessors.filter(
          (p) => p instanceof AgentTransferLlmRequestProcessor,
        ).length;
      expect(countTransfer(agent)).toBe(1);
      expect(countTransfer(clone)).toBe(1);
    });

    it('applies an instruction override without mutating the original', () => {
      const agent = new LlmAgent({name: 'original', instruction: 'old'});

      const clone = agent.clone({instruction: 'new'});

      expect(clone.instruction).toBe('new');
      expect(agent.instruction).toBe('old');
    });

    it('applies a name override only to the clone', () => {
      const agent = new LlmAgent({name: 'original'});

      const clone = agent.clone({name: 'renamed'});

      expect(clone.name).toBe('renamed');
      expect(agent.name).toBe('original');
    });

    it('uses the provided tools when tools is overridden', () => {
      const original = makeTool('search');
      const replacement = makeTool('lookup');
      const agent = new LlmAgent({name: 'original', tools: [original]});

      const clone = agent.clone({tools: [replacement]});

      expect(clone.tools).toEqual([replacement]);
      expect(agent.tools).toEqual([original]);
    });

    it('throws when overriding parentAgent', () => {
      const agent = new LlmAgent({name: 'original'});
      const wouldBeParent = new LlmAgent({name: 'parent'});

      expect(() => agent.clone({parentAgent: wouldBeParent})).toThrow(
        'Cannot update `parentAgent` field in clone.',
      );
    });

    it('detaches the clone of a sub-agent from its parent', () => {
      const subAgent = new LlmAgent({name: 'sub'});
      const root = new LlmAgent({name: 'root', subAgents: [subAgent]});
      expect(subAgent.parentAgent).toBe(root);

      const clone = subAgent.clone();

      expect(clone.parentAgent).toBeUndefined();
    });

    it('recursively clones sub-agents and re-parents them', () => {
      const subAgent = new LlmAgent({name: 'sub'});
      const root = new LlmAgent({name: 'root', subAgents: [subAgent]});

      const clonedRoot = root.clone();

      expect(clonedRoot.subAgents).not.toBe(root.subAgents);
      expect(clonedRoot.subAgents[0]).not.toBe(subAgent);
      expect(clonedRoot.subAgents[0].parentAgent).toBe(clonedRoot);
      // The original tree is untouched.
      expect(subAgent.parentAgent).toBe(root);
    });

    it('uses the provided sub-agents when subAgents is overridden', () => {
      const subAgent = new LlmAgent({name: 'sub'});
      const root = new LlmAgent({name: 'root', subAgents: [subAgent]});
      const replacement = new LlmAgent({name: 'replacement'});

      const clonedRoot = root.clone({subAgents: [replacement]});

      expect(clonedRoot.subAgents[0]).toBe(replacement);
      expect(clonedRoot.subAgents[0].parentAgent).toBe(clonedRoot);
    });

    it('clones a plain BaseAgent subclass', () => {
      const agent = new MockAgent({name: 'mock', description: 'a mock'});

      const clone = agent.clone();

      expect(clone).not.toBe(agent);
      expect(clone).toBeInstanceOf(MockAgent);
      expect(clone.name).toBe('mock');
      expect(clone.description).toBe('a mock');
    });
  });

  describe('agent callbacks', () => {
    function createParentInvocationContext(
      agent: BaseAgent,
    ): InvocationContext {
      return new InvocationContext({
        invocationId: 'test_invocation',
        agent,
        session: createSession({
          id: 'test-session',
          appName: 'test-app',
          userId: 'test-user',
        }),
        pluginManager: new PluginManager(),
      });
    }

    async function collectEvents(
      agent: BaseAgent,
      parentContext = createParentInvocationContext(agent),
    ): Promise<Event[]> {
      const events: Event[] = [];
      for await (const event of agent.runAsync(parentContext)) {
        events.push(event);
      }
      return events;
    }

    describe('canonicalBeforeAgentCallbacks and canonicalAfterAgentCallbacks', () => {
      it('returns empty arrays when no callbacks are configured', () => {
        const agent = new MockAgent({name: 'test_agent'});

        expect(agent.canonicalBeforeAgentCallbacks).toEqual([]);
        expect(agent.canonicalAfterAgentCallbacks).toEqual([]);
      });

      it('normalizes single callbacks into single-element arrays', () => {
        const beforeCb: SingleAgentCallback = () => undefined;
        const afterCb: SingleAgentCallback = () => undefined;
        const agent = new MockAgent({
          name: 'test_agent',
          beforeAgentCallback: beforeCb,
          afterAgentCallback: afterCb,
        });

        expect(agent.canonicalBeforeAgentCallbacks).toEqual([beforeCb]);
        expect(agent.canonicalAfterAgentCallbacks).toEqual([afterCb]);
      });

      it('preserves callback arrays in order', () => {
        const beforeCb1: SingleAgentCallback = () => undefined;
        const beforeCb2: SingleAgentCallback = async () => undefined;
        const afterCb1: SingleAgentCallback = () => undefined;
        const afterCb2: SingleAgentCallback = async () => undefined;
        const agent = new MockAgent({
          name: 'test_agent',
          beforeAgentCallback: [beforeCb1, beforeCb2],
          afterAgentCallback: [afterCb1, afterCb2],
        });

        expect(agent.canonicalBeforeAgentCallbacks).toEqual([
          beforeCb1,
          beforeCb2,
        ]);
        expect(agent.canonicalAfterAgentCallbacks).toEqual([
          afterCb1,
          afterCb2,
        ]);
      });
    });

    describe('single sync and async callbacks', () => {
      it('runs agent when sync beforeAgentCallback returns undefined', async () => {
        const beforeCb = vi.fn((_context: Context) => undefined);
        const agent = new MockAgent({
          name: 'test_agent',
          beforeAgentCallback: beforeCb,
        });

        const events = await collectEvents(agent);

        expect(beforeCb).toHaveBeenCalledOnce();
        expect(beforeCb.mock.calls[0][0]).toBeInstanceOf(Context);
        expect(events).toHaveLength(1);
        expect(events[0].content?.parts?.[0]?.text).toBe(
          'Response from test_agent',
        );
      });

      it('runs agent when async beforeAgentCallback resolves to undefined', async () => {
        const beforeCb = vi.fn(async (_context: Context) => undefined);
        const agent = new MockAgent({
          name: 'test_agent',
          beforeAgentCallback: beforeCb,
        });

        const events = await collectEvents(agent);

        expect(beforeCb).toHaveBeenCalledOnce();
        expect(beforeCb.mock.calls[0][0]).toBeInstanceOf(Context);
        expect(events).toHaveLength(1);
        expect(events[0].content?.parts?.[0]?.text).toBe(
          'Response from test_agent',
        );
      });

      it('bypasses agent run when sync beforeAgentCallback returns content', async () => {
        const beforeCb = vi.fn((): Content => ({
          parts: [{text: 'agent run is bypassed.'}],
        }));
        const afterCb = vi.fn(() => undefined);
        const agent = new MockAgent({
          name: 'test_agent',
          beforeAgentCallback: beforeCb,
          afterAgentCallback: afterCb,
        });

        const events = await collectEvents(agent);

        expect(beforeCb).toHaveBeenCalledOnce();
        expect(afterCb).not.toHaveBeenCalled();
        expect(events).toHaveLength(1);
        expect(events[0].author).toBe('test_agent');
        expect(events[0].content?.parts?.[0]?.text).toBe(
          'agent run is bypassed.',
        );
      });

      it('bypasses agent run when async beforeAgentCallback resolves to content', async () => {
        const beforeCb = vi.fn(async (): Promise<Content> => ({
          parts: [{text: 'agent run is bypassed.'}],
        }));
        const afterCb = vi.fn(() => undefined);
        const agent = new MockAgent({
          name: 'test_agent',
          beforeAgentCallback: beforeCb,
          afterAgentCallback: afterCb,
        });

        const events = await collectEvents(agent);

        expect(beforeCb).toHaveBeenCalledOnce();
        expect(afterCb).not.toHaveBeenCalled();
        expect(events).toHaveLength(1);
        expect(events[0].author).toBe('test_agent');
        expect(events[0].content?.parts?.[0]?.text).toBe(
          'agent run is bypassed.',
        );
      });

      it('leaves response unchanged when sync afterAgentCallback returns undefined', async () => {
        const afterCb = vi.fn((_context: Context) => undefined);
        const agent = new MockAgent({
          name: 'test_agent',
          afterAgentCallback: afterCb,
        });

        const events = await collectEvents(agent);

        expect(afterCb).toHaveBeenCalledOnce();
        expect(afterCb.mock.calls[0][0]).toBeInstanceOf(Context);
        expect(events).toHaveLength(1);
        expect(events[0].content?.parts?.[0]?.text).toBe(
          'Response from test_agent',
        );
      });

      it('leaves response unchanged when async afterAgentCallback resolves to undefined', async () => {
        const afterCb = vi.fn(async (_context: Context) => undefined);
        const agent = new MockAgent({
          name: 'test_agent',
          afterAgentCallback: afterCb,
        });

        const events = await collectEvents(agent);

        expect(afterCb).toHaveBeenCalledOnce();
        expect(afterCb.mock.calls[0][0]).toBeInstanceOf(Context);
        expect(events).toHaveLength(1);
        expect(events[0].content?.parts?.[0]?.text).toBe(
          'Response from test_agent',
        );
      });

      it('appends reply when sync afterAgentCallback returns content', async () => {
        const afterCb = vi.fn((): Content => ({
          parts: [{text: 'Agent reply from after agent callback.'}],
        }));
        const agent = new MockAgent({
          name: 'test_agent',
          afterAgentCallback: afterCb,
        });

        const events = await collectEvents(agent);

        expect(afterCb).toHaveBeenCalledOnce();
        expect(events).toHaveLength(2);
        expect(events[0].content?.parts?.[0]?.text).toBe(
          'Response from test_agent',
        );
        expect(events[1].author).toBe('test_agent');
        expect(events[1].content?.parts?.[0]?.text).toBe(
          'Agent reply from after agent callback.',
        );
      });

      it('appends reply when async afterAgentCallback resolves to content', async () => {
        const afterCb = vi.fn(async (): Promise<Content> => ({
          parts: [{text: 'Agent reply from after agent callback.'}],
        }));
        const agent = new MockAgent({
          name: 'test_agent',
          afterAgentCallback: afterCb,
        });

        const events = await collectEvents(agent);

        expect(afterCb).toHaveBeenCalledOnce();
        expect(events).toHaveLength(2);
        expect(events[0].content?.parts?.[0]?.text).toBe(
          'Response from test_agent',
        );
        expect(events[1].author).toBe('test_agent');
        expect(events[1].content?.parts?.[0]?.text).toBe(
          'Agent reply from after agent callback.',
        );
      });
    });

    describe('callback chaining', () => {
      interface ChainSpec {
        name: string;
        callbacks: Array<{response?: string; isAsync: boolean}>;
        expectedBeforeTexts: string[];
        expectedAfterTexts: string[];
        expectedCalls: number[];
      }

      const CHAIN_CASES: ChainSpec[] = [
        {
          name: 'when middle async callback returns content',
          callbacks: [
            {response: undefined, isAsync: false},
            {response: 'callback_2_response', isAsync: true},
            {response: 'callback_3_response', isAsync: false},
            {response: undefined, isAsync: true},
          ],
          expectedBeforeTexts: ['callback_2_response'],
          expectedAfterTexts: [
            'Response from test_agent',
            'callback_2_response',
          ],
          expectedCalls: [1, 1, 0, 0],
        },
        {
          name: 'when all callbacks return undefined',
          callbacks: [
            {response: undefined, isAsync: false},
            {response: undefined, isAsync: true},
            {response: undefined, isAsync: false},
            {response: undefined, isAsync: true},
          ],
          expectedBeforeTexts: ['Response from test_agent'],
          expectedAfterTexts: ['Response from test_agent'],
          expectedCalls: [1, 1, 1, 1],
        },
        {
          name: 'when first sync callback returns content',
          callbacks: [
            {response: 'callback_1_response', isAsync: false},
            {response: 'callback_2_response', isAsync: true},
          ],
          expectedBeforeTexts: ['callback_1_response'],
          expectedAfterTexts: [
            'Response from test_agent',
            'callback_1_response',
          ],
          expectedCalls: [1, 0],
        },
      ];

      it.each(CHAIN_CASES)(
        'chains beforeAgentCallback ($name)',
        async ({callbacks, expectedBeforeTexts, expectedCalls}) => {
          const spies = callbacks.map(({response, isAsync}) =>
            vi.fn<SingleAgentCallback>(() => {
              const content: Content | undefined = response
                ? {parts: [{text: response}]}
                : undefined;
              return isAsync ? Promise.resolve(content) : content;
            }),
          );

          const agent = new MockAgent({
            name: 'test_agent',
            beforeAgentCallback: spies,
          });

          const events = await collectEvents(agent);

          expect(events.map((e) => e.content?.parts?.[0]?.text)).toEqual(
            expectedBeforeTexts,
          );
          spies.forEach((spy, index) => {
            expect(spy).toHaveBeenCalledTimes(expectedCalls[index]);
          });
        },
      );

      it.each(CHAIN_CASES)(
        'chains afterAgentCallback ($name)',
        async ({callbacks, expectedAfterTexts, expectedCalls}) => {
          const spies = callbacks.map(({response, isAsync}) =>
            vi.fn<SingleAgentCallback>(() => {
              const content: Content | undefined = response
                ? {parts: [{text: response}]}
                : undefined;
              return isAsync ? Promise.resolve(content) : content;
            }),
          );

          const agent = new MockAgent({
            name: 'test_agent',
            afterAgentCallback: spies,
          });

          const events = await collectEvents(agent);

          expect(events.map((e) => e.content?.parts?.[0]?.text)).toEqual(
            expectedAfterTexts,
          );
          spies.forEach((spy, index) => {
            expect(spy).toHaveBeenCalledTimes(expectedCalls[index]);
          });
        },
      );
    });

    describe('Context async artifact methods in callbacks', () => {
      it('throws when loadArtifact or saveArtifact is called without artifactService', async () => {
        const parentContext = createParentInvocationContext(
          new MockAgent({name: 'test_agent'}),
        );
        const callbackContext = new Context({invocationContext: parentContext});

        expect(() => callbackContext.loadArtifact('missing.txt')).toThrow(
          'Artifact service is not initialized.',
        );
        await expect(
          callbackContext.saveArtifact('missing.txt', {text: 'content'}),
        ).rejects.toThrow('Artifact service is not initialized.');
      });

      it('saves and loads artifacts asynchronously inside agent callbacks', async () => {
        const artifactService = new ScopedArtifactService(
          new InMemoryArtifactService(),
          'test-app',
          'test-user',
          'test-session',
        );
        let loadedText: string | undefined;

        const agent = new MockAgent({
          name: 'test_agent',
          beforeAgentCallback: async (context: Context) => {
            await context.saveArtifact('greeting.txt', {
              text: 'stored from before callback',
            });
            return undefined;
          },
          afterAgentCallback: async (context: Context) => {
            const loaded = await context.loadArtifact('greeting.txt');
            loadedText = loaded?.text;
            return undefined;
          },
        });

        const parentContext = new InvocationContext({
          invocationId: 'test_invocation',
          agent,
          session: createSession({
            id: 'test-session',
            appName: 'test-app',
            userId: 'test-user',
          }),
          artifactService,
          pluginManager: new PluginManager(),
        });

        const events = await collectEvents(agent, parentContext);

        expect(loadedText).toBe('stored from before callback');
        expect(events).toHaveLength(1);
        expect(events[0].content?.parts?.[0]?.text).toBe(
          'Response from test_agent',
        );
      });
    });

    describe('plugin beforeAgentCallback and afterAgentCallback', () => {
      class TestPlugin extends BasePlugin {
        beforeAgentCallbackSpy = vi.fn();
        afterAgentCallbackSpy = vi.fn();
        beforeAgentReturnContent?: Content;
        afterAgentReturnContent?: Content;

        constructor(name = 'test_plugin') {
          super(name);
        }

        override async beforeAgentCallback(params: {
          agent: BaseAgent;
          callbackContext: Context;
        }): Promise<Content | undefined> {
          this.beforeAgentCallbackSpy(params);
          return this.beforeAgentReturnContent;
        }

        override async afterAgentCallback(params: {
          agent: BaseAgent;
          callbackContext: Context;
        }): Promise<Content | undefined> {
          this.afterAgentCallbackSpy(params);
          return this.afterAgentReturnContent;
        }
      }

      it.each([
        {
          caseName: 'empty PluginManager',
          pluginManager: new PluginManager(),
        },
        {
          caseName: 'undefined pluginManager',
          pluginManager: undefined as unknown as PluginManager,
        },
      ])(
        'does not construct Context when neither plugins nor canonical callbacks are present on a session-less InvocationContext ($caseName)',
        async ({pluginManager}) => {
          const agent = new MockAgent({name: 'test_agent'});
          const sessionLessContext = new InvocationContext({
            invocationId: 'test_invocation',
            agent,
            session: undefined as unknown as Session,
            pluginManager,
          });

          const events = await collectEvents(agent, sessionLessContext);

          expect(events).toHaveLength(1);
          expect(events[0].content?.parts?.[0]?.text).toBe(
            'Response from test_agent',
          );
        },
      );

      it('invokes plugin beforeAgentCallback and afterAgentCallback when agent has no callbacks', async () => {
        const plugin = new TestPlugin();
        const agent = new MockAgent({name: 'test_agent'});
        const parentContext = new InvocationContext({
          invocationId: 'test_invocation',
          agent,
          session: createSession({
            id: 'test-session',
            appName: 'test-app',
            userId: 'test-user',
          }),
          pluginManager: new PluginManager([plugin]),
        });

        const events = await collectEvents(agent, parentContext);

        expect(plugin.beforeAgentCallbackSpy).toHaveBeenCalledOnce();
        expect(plugin.beforeAgentCallbackSpy).toHaveBeenCalledWith({
          agent,
          callbackContext: expect.any(Context),
        });
        expect(plugin.afterAgentCallbackSpy).toHaveBeenCalledOnce();
        expect(plugin.afterAgentCallbackSpy).toHaveBeenCalledWith({
          agent,
          callbackContext: expect.any(Context),
        });
        expect(events).toHaveLength(1);
        expect(events[0].content?.parts?.[0]?.text).toBe(
          'Response from test_agent',
        );
      });

      it('invokes plugin beforeAgentCallback and afterAgentCallback in runLive', async () => {
        const plugin = new TestPlugin();
        const agent = new MockAgent({name: 'test_agent'});
        const parentContext = new InvocationContext({
          invocationId: 'test_invocation',
          agent,
          session: createSession({
            id: 'test-session',
            appName: 'test-app',
            userId: 'test-user',
          }),
          pluginManager: new PluginManager([plugin]),
        });

        const events: Event[] = [];
        for await (const event of agent.runLive(parentContext)) {
          events.push(event);
        }

        expect(plugin.beforeAgentCallbackSpy).toHaveBeenCalledOnce();
        expect(plugin.afterAgentCallbackSpy).toHaveBeenCalledOnce();
        expect(events).toHaveLength(1);
        expect(events[0].content?.parts?.[0]?.text).toBe(
          'Live response from test_agent',
        );
      });

      it('short-circuits subsequent plugins, canonical callbacks, and agent execution when a plugin beforeAgentCallback returns content', async () => {
        class FirstShortCircuitPlugin extends BasePlugin {
          constructor() {
            super('first_plugin');
          }
          override async beforeAgentCallback({
            callbackContext,
          }: {
            agent: BaseAgent;
            callbackContext: Context;
          }): Promise<Content | undefined> {
            callbackContext.state.set('short_circuit_key', 'from_first_plugin');
            return {
              role: 'model',
              parts: [{text: 'Bypassed by plugin beforeAgentCallback'}],
            };
          }
        }

        const secondPlugin = new TestPlugin('second_plugin');
        const canonicalBeforeCb = vi.fn(() => undefined);
        const agent = new MockAgent({
          name: 'test_agent',
          beforeAgentCallback: canonicalBeforeCb,
        });
        const parentContext = new InvocationContext({
          invocationId: 'test_invocation',
          agent,
          session: createSession({
            id: 'test-session',
            appName: 'test-app',
            userId: 'test-user',
          }),
          pluginManager: new PluginManager([
            new FirstShortCircuitPlugin(),
            secondPlugin,
          ]),
        });

        const events = await collectEvents(agent, parentContext);

        expect(secondPlugin.beforeAgentCallbackSpy).not.toHaveBeenCalled();
        expect(canonicalBeforeCb).not.toHaveBeenCalled();
        expect(secondPlugin.afterAgentCallbackSpy).not.toHaveBeenCalled();
        expect(events).toHaveLength(1);
        expect(events[0].author).toBe('test_agent');
        expect(events[0].content?.parts?.[0]?.text).toBe(
          'Bypassed by plugin beforeAgentCallback',
        );
        expect(events[0].actions.stateDelta).toEqual({
          short_circuit_key: 'from_first_plugin',
        });
      });

      it('runs canonical beforeAgentCallback after plugin beforeAgentCallback returns undefined and preserves plugin state delta', async () => {
        class StateBeforePlugin extends BasePlugin {
          constructor() {
            super('state_before_plugin');
          }
          override async beforeAgentCallback({
            callbackContext,
          }: {
            agent: BaseAgent;
            callbackContext: Context;
          }): Promise<Content | undefined> {
            callbackContext.state.set('plugin_before_key', 'from_plugin');
            return undefined;
          }
        }

        const canonicalBeforeCb = vi.fn((context: Context) => {
          context.state.set('canonical_before_key', 'from_canonical');
          return {
            role: 'model',
            parts: [{text: 'Short-circuited by canonical beforeAgentCallback'}],
          };
        });
        const agent = new MockAgent({
          name: 'test_agent',
          beforeAgentCallback: canonicalBeforeCb,
        });
        const parentContext = new InvocationContext({
          invocationId: 'test_invocation',
          agent,
          session: createSession({
            id: 'test-session',
            appName: 'test-app',
            userId: 'test-user',
          }),
          pluginManager: new PluginManager([new StateBeforePlugin()]),
        });

        const events = await collectEvents(agent, parentContext);

        expect(canonicalBeforeCb).toHaveBeenCalledOnce();
        expect(events).toHaveLength(1);
        expect(events[0].content?.parts?.[0]?.text).toBe(
          'Short-circuited by canonical beforeAgentCallback',
        );
        expect(events[0].actions.stateDelta).toEqual({
          plugin_before_key: 'from_plugin',
          canonical_before_key: 'from_canonical',
        });
      });

      it('yields afterAgentCallback event when plugin afterAgentCallback returns content', async () => {
        const plugin = new TestPlugin();
        plugin.afterAgentReturnContent = {
          role: 'model',
          parts: [{text: 'Overridden by plugin afterAgentCallback'}],
        };
        const canonicalAfterCb = vi.fn(() => undefined);
        const agent = new MockAgent({
          name: 'test_agent',
          afterAgentCallback: canonicalAfterCb,
        });
        const parentContext = new InvocationContext({
          invocationId: 'test_invocation',
          agent,
          session: createSession({
            id: 'test-session',
            appName: 'test-app',
            userId: 'test-user',
          }),
          pluginManager: new PluginManager([plugin]),
        });

        const events = await collectEvents(agent, parentContext);

        expect(plugin.beforeAgentCallbackSpy).toHaveBeenCalledOnce();
        expect(canonicalAfterCb).not.toHaveBeenCalled();
        expect(plugin.afterAgentCallbackSpy).toHaveBeenCalledOnce();
        expect(events).toHaveLength(2);
        expect(events[0].content?.parts?.[0]?.text).toBe(
          'Response from test_agent',
        );
        expect(events[1].content?.parts?.[0]?.text).toBe(
          'Overridden by plugin afterAgentCallback',
        );
      });

      it('runs canonical afterAgentCallback after plugin afterAgentCallback returns undefined and preserves plugin state delta', async () => {
        class StateAfterPlugin extends BasePlugin {
          constructor() {
            super('state_after_plugin');
          }
          override async afterAgentCallback({
            callbackContext,
          }: {
            agent: BaseAgent;
            callbackContext: Context;
          }): Promise<Content | undefined> {
            callbackContext.state.set('plugin_after_key', 'from_plugin');
            return undefined;
          }
        }

        const canonicalAfterCb = vi.fn((context: Context) => {
          context.state.set('canonical_after_key', 'from_canonical');
          return {
            role: 'model',
            parts: [{text: 'Appended by canonical afterAgentCallback'}],
          };
        });
        const agent = new MockAgent({
          name: 'test_agent',
          afterAgentCallback: canonicalAfterCb,
        });
        const parentContext = new InvocationContext({
          invocationId: 'test_invocation',
          agent,
          session: createSession({
            id: 'test-session',
            appName: 'test-app',
            userId: 'test-user',
          }),
          pluginManager: new PluginManager([new StateAfterPlugin()]),
        });

        const events = await collectEvents(agent, parentContext);

        expect(canonicalAfterCb).toHaveBeenCalledOnce();
        expect(events).toHaveLength(2);
        expect(events[0].content?.parts?.[0]?.text).toBe(
          'Response from test_agent',
        );
        expect(events[1].content?.parts?.[0]?.text).toBe(
          'Appended by canonical afterAgentCallback',
        );
        expect(events[1].actions.stateDelta).toEqual({
          plugin_after_key: 'from_plugin',
          canonical_after_key: 'from_canonical',
        });
      });

      it('emits state delta event when plugin beforeAgentCallback mutates state', async () => {
        class StatePlugin extends BasePlugin {
          constructor() {
            super('state_plugin');
          }
          override async beforeAgentCallback({
            callbackContext,
          }: {
            agent: BaseAgent;
            callbackContext: Context;
          }): Promise<Content | undefined> {
            callbackContext.state.set('plugin_before_key', 'val_before');
            return undefined;
          }
        }

        const plugin = new StatePlugin();
        const agent = new MockAgent({name: 'test_agent'});
        const parentContext = new InvocationContext({
          invocationId: 'test_invocation',
          agent,
          session: createSession({
            id: 'test-session',
            appName: 'test-app',
            userId: 'test-user',
          }),
          pluginManager: new PluginManager([plugin]),
        });

        const events = await collectEvents(agent, parentContext);

        expect(events).toHaveLength(2);
        expect(events[0].author).toBe('test_agent');
        expect(events[0].content).toBeUndefined();
        expect(events[0].actions.stateDelta).toEqual({
          plugin_before_key: 'val_before',
        });
        expect(events[1].content?.parts?.[0]?.text).toBe(
          'Response from test_agent',
        );
      });

      it('emits state delta event when plugin afterAgentCallback mutates state', async () => {
        class StatePlugin extends BasePlugin {
          constructor() {
            super('state_plugin');
          }
          override async afterAgentCallback({
            callbackContext,
          }: {
            agent: BaseAgent;
            callbackContext: Context;
          }): Promise<Content | undefined> {
            callbackContext.state.set('plugin_after_key', 'val_after');
            return undefined;
          }
        }

        const plugin = new StatePlugin();
        const agent = new MockAgent({name: 'test_agent'});
        const parentContext = new InvocationContext({
          invocationId: 'test_invocation',
          agent,
          session: createSession({
            id: 'test-session',
            appName: 'test-app',
            userId: 'test-user',
          }),
          pluginManager: new PluginManager([plugin]),
        });

        const events = await collectEvents(agent, parentContext);

        expect(events).toHaveLength(2);
        expect(events[0].content?.parts?.[0]?.text).toBe(
          'Response from test_agent',
        );
        expect(events[1].author).toBe('test_agent');
        expect(events[1].content).toBeUndefined();
        expect(events[1].actions.stateDelta).toEqual({
          plugin_after_key: 'val_after',
        });
      });

      it('stops processing when abortSignal is triggered during plugin beforeAgentCallback', async () => {
        const beforeController = new AbortController();
        class AbortBeforePlugin extends BasePlugin {
          constructor() {
            super('abort_before_plugin');
          }
          override async beforeAgentCallback(): Promise<Content | undefined> {
            beforeController.abort();
            return {role: 'model', parts: [{text: 'Should not be emitted'}]};
          }
        }

        const canonicalBeforeCb = vi.fn(() => undefined);
        const agentBefore = new MockAgent({
          name: 'test_agent',
          beforeAgentCallback: canonicalBeforeCb,
        });
        const beforeContext = new InvocationContext({
          invocationId: 'test_invocation',
          agent: agentBefore,
          session: createSession({
            id: 'test-session',
            appName: 'test-app',
            userId: 'test-user',
          }),
          pluginManager: new PluginManager([new AbortBeforePlugin()]),
          abortSignal: beforeController.signal,
        });

        const beforeEvents = await collectEvents(agentBefore, beforeContext);
        expect(beforeEvents).toHaveLength(0);
        expect(canonicalBeforeCb).not.toHaveBeenCalled();
      });

      it('stops processing when abortSignal is triggered during plugin afterAgentCallback', async () => {
        const afterController = new AbortController();
        class AbortAfterPlugin extends BasePlugin {
          constructor() {
            super('abort_after_plugin');
          }
          override async afterAgentCallback(): Promise<Content | undefined> {
            afterController.abort();
            return {role: 'model', parts: [{text: 'Should not be emitted'}]};
          }
        }

        const canonicalAfterCb = vi.fn(() => undefined);
        const agentAfter = new MockAgent({
          name: 'test_agent',
          afterAgentCallback: canonicalAfterCb,
        });
        const afterContext = new InvocationContext({
          invocationId: 'test_invocation',
          agent: agentAfter,
          session: createSession({
            id: 'test-session',
            appName: 'test-app',
            userId: 'test-user',
          }),
          pluginManager: new PluginManager([new AbortAfterPlugin()]),
          abortSignal: afterController.signal,
        });

        const afterEvents = await collectEvents(agentAfter, afterContext);
        expect(afterEvents).toHaveLength(1);
        expect(afterEvents[0].content?.parts?.[0]?.text).toBe(
          'Response from test_agent',
        );
        expect(canonicalAfterCb).not.toHaveBeenCalled();
      });

      it('stops processing without emitting state delta when canonical callback aborts after plugin mutated state', async () => {
        const controller = new AbortController();
        class StatePlugin extends BasePlugin {
          constructor() {
            super('state_plugin');
          }
          override async beforeAgentCallback({
            callbackContext,
          }: {
            agent: BaseAgent;
            callbackContext: Context;
          }): Promise<Content | undefined> {
            callbackContext.state.set('aborted_key', 'should_not_emit');
            return undefined;
          }
        }

        const agent = new MockAgent({
          name: 'test_agent',
          beforeAgentCallback: () => {
            controller.abort();
            return undefined;
          },
        });
        const parentContext = new InvocationContext({
          invocationId: 'test_invocation',
          agent,
          session: createSession({
            id: 'test-session',
            appName: 'test-app',
            userId: 'test-user',
          }),
          pluginManager: new PluginManager([new StatePlugin()]),
          abortSignal: controller.signal,
        });

        const events = await collectEvents(agent, parentContext);
        expect(events).toHaveLength(0);
      });

      it('notifies onAgentErrorCallback when plugin beforeAgentCallback throws', async () => {
        const originalError = new Error('plugin before failure');
        const onAgentErrorSpy = vi.fn();

        class ThrowingPlugin extends BasePlugin {
          constructor() {
            super('throwing_plugin');
          }
          override async beforeAgentCallback(): Promise<Content | undefined> {
            throw originalError;
          }
          override async onAgentErrorCallback(params: {
            agent: BaseAgent;
            callbackContext: Context;
            error: Error;
          }): Promise<void> {
            onAgentErrorSpy(params);
          }
        }

        const agent = new MockAgent({name: 'test_agent'});
        const parentContext = new InvocationContext({
          invocationId: 'test_invocation',
          agent,
          session: createSession({
            id: 'test-session',
            appName: 'test-app',
            userId: 'test-user',
          }),
          pluginManager: new PluginManager([new ThrowingPlugin()]),
        });

        await expect(collectEvents(agent, parentContext)).rejects.toThrow(
          "Error in plugin 'throwing_plugin' during 'beforeAgentCallback' callback",
        );
        expect(onAgentErrorSpy).toHaveBeenCalledOnce();
        expect(onAgentErrorSpy.mock.calls[0][0].agent).toBe(agent);
        expect(onAgentErrorSpy.mock.calls[0][0].error.cause).toBe(
          originalError,
        );
      });
    });
  });
});
