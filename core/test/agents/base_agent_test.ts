/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTransferLlmRequestProcessor,
  BaseAgent,
  BaseAgentConfig,
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
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Not needed for this test
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
          name: 'middle_async_callback_returns',
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
          name: 'all_callbacks_return_undefined',
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
          name: 'first_sync_callback_returns',
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
  });
});
