/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {BasePlugin} from '../../src/plugins/base_plugin.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession} from '../../src/sessions/session.js';
import {BaseNode} from '../../src/workflow/base_node.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
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
