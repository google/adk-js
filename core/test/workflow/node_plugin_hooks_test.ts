/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {Event} from '../../src/events/event.js';
import {BasePlugin} from '../../src/plugins/base_plugin.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {createSession} from '../../src/sessions/session.js';
import {BaseNode} from '../../src/workflow/base_node.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {createIc, driveNode} from './test_helpers.js';

class RecordingPlugin extends BasePlugin {
  readonly before: Array<{name: string; input: unknown}> = [];
  readonly after: Array<{name: string; output: unknown}> = [];

  constructor(
    name = 'recorder',
    private readonly beforeResult?: unknown,
    private readonly afterResult?: unknown,
  ) {
    super(name);
  }

  override async beforeNodeCallback(params: {
    node: BaseNode;
    nodeContext: NodeContext;
    input: unknown;
  }): Promise<unknown | undefined> {
    this.before.push({name: params.node.name, input: params.input});
    return this.beforeResult;
  }

  override async afterNodeCallback(params: {
    node: BaseNode;
    nodeContext: NodeContext;
    output: unknown;
  }): Promise<unknown | undefined> {
    this.after.push({name: params.node.name, output: params.output});
    return this.afterResult;
  }
}

function icWith(plugin: BasePlugin): InvocationContext {
  const ic = createIc();
  return ic.clone({pluginManager: new PluginManager([plugin])});
}

describe('workflow node plugin hooks', () => {
  it('reports each node run to before and after callbacks', async () => {
    const plugin = new RecordingPlugin();
    const target = node((_ctx: NodeContext, input: unknown) => `saw:${input}`, {
      name: 'target',
    });

    const {output} = await driveNode(target, 'in', icWith(plugin));

    expect(output).toBe('saw:in');
    expect(plugin.before).toEqual([{name: 'target', input: 'in'}]);
    expect(plugin.after).toEqual([{name: 'target', output: 'saw:in'}]);
  });

  it('skips the node body when beforeNodeCallback returns a value', async () => {
    const plugin = new RecordingPlugin('cache', 'cached-value');
    let ran = false;
    const target = node(
      () => {
        ran = true;
        return 'fresh';
      },
      {name: 'target'},
    );

    const {output} = await driveNode(target, 'in', icWith(plugin));

    expect(ran).toBe(false);
    expect(output).toBe('cached-value');
    expect(plugin.after).toEqual([]);
  });

  it('emits a delegated cache hit once with its node provenance', async () => {
    const target = node(() => 'unused', {
      name: 'target',
      isolationScope: 'cache',
    });
    class CachePlugin extends BasePlugin {
      constructor() {
        super('cache');
      }
      override async beforeNodeCallback({
        node,
        nodeContext,
      }: {
        node: BaseNode;
        nodeContext: NodeContext;
      }) {
        if (node === target) {
          nodeContext.state.set('cacheHit', true);
          return 'cached-value';
        }
        return undefined;
      }
    }
    const wrapper = node(
      async (ctx: NodeContext) => {
        await ctx.runNode(target, undefined, {
          useAsOutput: true,
          useSubBranch: true,
        });
        return ctx.output;
      },
      {name: 'wrapper'},
    );

    const {events, output} = await driveNode(
      wrapper,
      undefined,
      icWith(new CachePlugin()),
    );

    expect(output).toBe('cached-value');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      author: 'target',
      invocationId: 'inv-1',
      isolationScope: 'cache',
      output: 'cached-value',
      content: {role: 'model', parts: [{text: 'cached-value'}]},
      actions: {stateDelta: {cacheHit: true}},
      nodeInfo: {
        path: 'wrapper.target',
        outputFor: ['wrapper.target', 'wrapper'],
      },
    });
    expect(events[0].branch).toContain('target');
  });

  it('replaces the output when afterNodeCallback returns a value', async () => {
    const plugin = new RecordingPlugin('rewriter', undefined, 'rewritten');
    const target = node(() => 'original', {name: 'target'});

    const {output} = await driveNode(target, 'in', icWith(plugin));

    expect(output).toBe('rewritten');
    expect(plugin.after).toEqual([{name: 'target', output: 'original'}]);
  });

  it('fires for every node of a graph, and for the workflow node itself', async () => {
    const plugin = new RecordingPlugin();
    const a = node(() => 'a', {name: 'a'});
    const b = node((_ctx: NodeContext, input: unknown) => `${input}b`, {
      name: 'b',
    });
    const wf = new Workflow({name: 'wf', edges: [['START', a, b]]});

    const {output} = await driveNode(wf, 'in', icWith(plugin));

    expect(output).toBe('ab');
    expect(plugin.before.map((c) => c.name)).toEqual(['wf', 'a', 'b']);
    expect(plugin.after.map((c) => c.name)).toEqual(['a', 'b', 'wf']);
  });

  it('does not fire afterNodeCallback when the node throws', async () => {
    const plugin = new RecordingPlugin();
    const boom = node(
      () => {
        throw new Error('nope');
      },
      {name: 'boom'},
    );

    await expect(driveNode(boom, 'in', icWith(plugin))).rejects.toThrow('nope');
    expect(plugin.before.map((c) => c.name)).toEqual(['boom']);
    expect(plugin.after).toEqual([]);
  });

  it('leaves execution untouched when no plugin implements the hooks', async () => {
    const target = node(() => 'plain', {name: 'target'});
    const ic = new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({
        id: 's1',
        appName: 'app',
        userId: 'u',
        state: {},
        lastUpdateTime: Date.now(),
      }),
      agent: createIc().agent,
      pluginManager: new PluginManager([]),
    });

    const {output} = await driveNode(target, 'in', ic);

    expect(output).toBe('plain');
  });
});

describe('workflow node cache hits on resume', () => {
  it.each(
    ['static', 'dynamic'].flatMap((kind) =>
      ['cached-value', null, false, 0, ''].map((cached) => ({kind, cached})),
    ),
  )(
    'restores a cached $kind node with output $cached without rerunning it',
    async ({kind, cached}) => {
      let bodyRuns = 0;
      let hookCalls = 0;
      const target = node(
        () => {
          bodyRuns++;
          return 'original';
        },
        {name: 'target'},
      );
      class OutputPlugin extends BasePlugin {
        constructor() {
          super('output');
        }
        override async beforeNodeCallback({node}: {node: BaseNode}) {
          if (node === target) {
            hookCalls++;
            // The cache may expire while the workflow waits for a reply.
            return hookCalls === 1 ? cached : undefined;
          }
          return undefined;
        }
      }
      const gate = node(
        (ctx: NodeContext, input: unknown) => {
          if (ctx.resumeInputs['approve'] === undefined) {
            return new RequestInput({
              interruptId: 'approve',
              message: 'approve?',
            });
          }
          return {cached: input};
        },
        {name: 'gate', rerunOnResume: true},
      );
      const supervisor = node(
        async (ctx: NodeContext) => {
          const result = await ctx.runNode(target);
          await ctx.runNode(gate);
          return {cached: result.output};
        },
        {name: 'supervisor', rerunOnResume: true},
      );
      const workflow = new Workflow({
        name: 'wf',
        edges:
          kind === 'dynamic'
            ? [['START', supervisor]]
            : [['START', target, gate]],
      });
      const sessionService = new InMemorySessionService();
      const session = await sessionService.createSession({
        appName: 'test_app',
        userId: 'u1',
      });
      const runner = new Runner({
        appName: 'test_app',
        agent: workflow,
        sessionService,
        plugins: [new OutputPlugin()],
      });
      const first: Event[] = [];
      for await (const event of runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'start'}]},
      })) {
        first.push(event);
      }
      expect(
        first.some((event) => event.longRunningToolIds?.includes('approve')),
      ).toBe(true);
      const resumed: Event[] = [];
      for await (const event of runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'approve',
                name: 'adk_request_input',
                response: {result: 'yes'},
              },
            },
          ],
        },
      })) {
        resumed.push(event);
      }
      expect(
        resumed.filter((event) => event.output !== undefined).at(-1)?.output,
      ).toEqual({cached});
      expect(first.filter((event) => event.author === 'target')).toHaveLength(
        1,
      );
      expect(resumed.filter((event) => event.author === 'target')).toHaveLength(
        0,
      );
      expect(hookCalls).toBe(1);
      expect(bodyRuns).toBe(0);
    },
  );
});
