/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  DEFAULT_ROUTE,
  Edge,
  Event,
  FunctionTool,
  JoinNode,
  LlmAgent,
  LoopAgent,
  node,
  ParallelAgent,
  SequentialAgent,
  Workflow,
} from '@google/adk';
import {parse} from 'ts-graphviz/ast';
import {describe, expect, it} from 'vitest';

import {
  getAgentGraphAsDot,
  getWorkflowHighlights,
} from '../../src/server/agent_graph.js';

describe('AgentGraph', () => {
  it('generates a DOT graph for a simple LlmAgent with a FunctionTool', async () => {
    const tool = new FunctionTool({
      name: 'testTool',
      description: 'a test tool',
      execute: async () => 'result',
    });
    const agent = new LlmAgent({
      name: 'testAgent',
      tools: [tool],
    });

    const dotGraph = await getAgentGraphAsDot(agent, []);
    expect(dotGraph).toContain('strict digraph "testAgent" {');
    expect(dotGraph).toContain('rankdir = "LR"');
    expect(dotGraph).toContain('"testAgent"');
    expect(dotGraph).toContain('label = "🤖 testAgent"');
    expect(dotGraph).toContain('"testTool"');
    expect(dotGraph).toContain('label = "🔧 testTool"');
    expect(dotGraph).toContain('"testAgent" -> "testTool" [');
  });

  it('generates a DOT graph for a SequentialAgent', async () => {
    const tool1 = new FunctionTool({
      name: 'tool1',
      description: 'tool1',
      execute: async () => 'result',
    });
    const agent1 = new LlmAgent({
      name: 'agent1',
      tools: [tool1],
    });
    const tool2 = new FunctionTool({
      name: 'tool2',
      description: 'tool2',
      execute: async () => 'result',
    });
    const agent2 = new LlmAgent({
      name: 'agent2',
      tools: [tool2],
    });
    const sequentialAgent = new SequentialAgent({
      name: 'sequentialAgent',
      subAgents: [agent1, agent2],
    });

    const dotGraph = await getAgentGraphAsDot(sequentialAgent, []);
    expect(dotGraph).toContain('strict digraph "sequentialAgent"');
    expect(dotGraph).toContain('rankdir = "LR"');
    expect(dotGraph).toContain('"agent1"');
    expect(dotGraph).toContain('label = "🤖 agent1"');
    expect(dotGraph).toContain('"tool1"');
    expect(dotGraph).toContain('label = "🔧 tool1"');
    expect(dotGraph).toContain('"agent2"');
    expect(dotGraph).toContain('label = "🤖 agent2"');
    expect(dotGraph).toContain('"tool2"');
    expect(dotGraph).toContain('label = "🔧 tool2"');
    expect(dotGraph).toContain('"agent1" -> "tool1"');
    expect(dotGraph).toContain('"agent2" -> "tool2"');
    expect(dotGraph).toContain('"agent1" -> "agent2"');
    expect(dotGraph).toContain(
      'subgraph "cluster_sequentialAgent (Sequential Agent)"',
    );
  });

  it('generates a DOT graph with highlighted edges', async () => {
    const agent1 = new LlmAgent({name: 'agent1'});
    const agent2 = new LlmAgent({name: 'agent2'});
    const sequentialAgent = new SequentialAgent({
      name: 'sequentialAgent',
      subAgents: [agent1, agent2],
    });

    const highlights: Array<[string, string]> = [['agent1', 'agent2']];
    const dotGraph = await getAgentGraphAsDot(sequentialAgent, highlights);

    expect(dotGraph).toContain('strict digraph "sequentialAgent"');
    expect(dotGraph).toContain('rankdir = "LR"');
    expect(dotGraph).toContain('"agent1"');
    expect(dotGraph).toContain('label = "🤖 agent1"');
    expect(dotGraph).toContain('"agent2"');
    expect(dotGraph).toContain('label = "🤖 agent2"');
    expect(dotGraph).toContain('"agent1" -> "agent2"');
    expect(dotGraph).toContain(
      'subgraph "cluster_sequentialAgent (Sequential Agent)"',
    );
    expect(dotGraph).toContain(
      'label = "cluster_sequentialAgent (Sequential Agent)"',
    );
  });

  it('generates a DOT graph with highlighted nodes', async () => {
    const agent1 = new LlmAgent({name: 'agent1'});
    const agent2 = new LlmAgent({name: 'agent2'});
    const sequentialAgent = new SequentialAgent({
      name: 'sequentialAgent',
      subAgents: [agent1, agent2],
    });

    const highlights: Array<[string, string]> = [['agent1', 'agent3']];
    const dotGraph = await getAgentGraphAsDot(sequentialAgent, highlights);

    expect(dotGraph).toContain('strict digraph "sequentialAgent"');
    expect(dotGraph).toContain('rankdir = "LR";');
    expect(dotGraph).toContain('"agent1"');
    expect(dotGraph).toContain('label = "🤖 agent1";');
    expect(dotGraph).toContain('"agent2"');
    expect(dotGraph).toContain('label = "🤖 agent2";');
    expect(dotGraph).toContain('"agent1" -> "agent2"');
    expect(dotGraph).toContain('cluster_sequentialAgent (Sequential Agent)"');
    expect(dotGraph).toContain(
      'label = "cluster_sequentialAgent (Sequential Agent)"',
    );
  });

  it('generates a DOT graph for a LoopAgent', async () => {
    const tool1 = new FunctionTool({
      name: 'tool1',
      description: 'tool1',
      execute: async () => 'result',
    });
    const agent1 = new LlmAgent({
      name: 'agent1',
      tools: [tool1],
    });
    const tool2 = new FunctionTool({
      name: 'tool2',
      description: 'tool2',
      execute: async () => 'result',
    });
    const agent2 = new LlmAgent({
      name: 'agent2',
      tools: [tool2],
    });
    const loopAgent = new LoopAgent({
      name: 'loopAgent',
      subAgents: [agent1, agent2],
    });

    const dotGraph = await getAgentGraphAsDot(loopAgent, []);
    expect(dotGraph).toContain('strict digraph "loopAgent"');
    expect(dotGraph).toContain('rankdir = "LR"');
    expect(dotGraph).toContain('"agent1"');
    expect(dotGraph).toContain('label = "🤖 agent1"');
    expect(dotGraph).toContain('"tool1"');
    expect(dotGraph).toContain('label = "🔧 tool1"');
    expect(dotGraph).toContain('"agent2"');
    expect(dotGraph).toContain('label = "🤖 agent2"');
    expect(dotGraph).toContain('"tool2"');
    expect(dotGraph).toContain('label = "🔧 tool2"');
    expect(dotGraph).toContain('"agent1" -> "agent2"');
    expect(dotGraph).toContain('"agent2" -> "agent1"');
    expect(dotGraph).toContain('"agent1" -> "tool1"');
    expect(dotGraph).toContain('"agent2" -> "tool2"');
    expect(dotGraph).toContain('subgraph "cluster_loopAgent (Loop Agent)"');
    expect(dotGraph).toContain('label = "cluster_loopAgent (Loop Agent)"');
  });

  it('generates a DOT graph for a ParallelAgent', async () => {
    const tool1 = new FunctionTool({
      name: 'tool1',
      description: 'tool1',
      execute: async () => 'result',
    });
    const agent1 = new LlmAgent({
      name: 'agent1',
      tools: [tool1],
    });
    const tool2 = new FunctionTool({
      name: 'tool2',
      description: 'tool2',
      execute: async () => 'result',
    });
    const agent2 = new LlmAgent({
      name: 'agent2',
      tools: [tool2],
    });
    const parallelAgent = new ParallelAgent({
      name: 'parallelAgent',
      subAgents: [agent1, agent2],
    });

    const dotGraph = await getAgentGraphAsDot(parallelAgent, []);
    expect(dotGraph).toContain('strict digraph "parallelAgent"');
    expect(dotGraph).toContain('rankdir = "LR"');
    expect(dotGraph).toContain('"agent1"');
    expect(dotGraph).toContain('label = "🤖 agent1"');
    expect(dotGraph).toContain('"tool1"');
    expect(dotGraph).toContain('label = "🔧 tool1"');
    expect(dotGraph).toContain('"agent2"');
    expect(dotGraph).toContain('label = "🤖 agent2"');
    expect(dotGraph).toContain('"tool2"');
    expect(dotGraph).toContain('label = "🔧 tool2"');
    expect(dotGraph).toContain('"agent1" -> "tool1"');
    expect(dotGraph).toContain('"agent2" -> "tool2"');
    expect(dotGraph).toContain(
      'subgraph "cluster_parallelAgent (Parallel Agent)"',
    );
    expect(dotGraph).toContain(
      'label = "cluster_parallelAgent (Parallel Agent)"',
    );
  });
});

const noopHandler = async () => 'ok';

async function renderDot(
  agent: Workflow | SequentialAgent,
  highlights: Array<[string, string]> = [],
): Promise<string> {
  const dot = await getAgentGraphAsDot(agent, highlights);
  expect(() => parse(dot)).not.toThrow();

  return dot;
}

function nodeBlock(dot: string, id: string): string {
  const start = dot.indexOf(`"${id}" [`);
  expect(start, `no node statement for "${id}"`).toBeGreaterThanOrEqual(0);

  return dot.slice(start, dot.indexOf('];', start));
}

function edgeBlock(dot: string, from: string, to: string): string {
  const start = dot.indexOf(`"${from}" -> "${to}" [`);
  expect(start, `no edge "${from}" -> "${to}"`).toBeGreaterThanOrEqual(0);

  return dot.slice(start, dot.indexOf('];', start));
}

describe('AgentGraph — graph Workflow', () => {
  it('renders the workflow graph as a cluster of nodes and edges', async () => {
    const workflow = new Workflow({
      name: 'wf',
      edges: [
        [
          'START',
          node(noopHandler, {name: 'one'}),
          node(noopHandler, {name: 'two'}),
          node(noopHandler, {name: 'three'}),
        ],
      ],
    });

    const dot = await renderDot(workflow);

    expect(dot).toContain('subgraph "cluster_wf" {');
    expect(dot).toContain('label = "🧩 wf"');
    expect(nodeBlock(dot, 'wf.one')).toContain('label = "⚙️ one"');
    expect(nodeBlock(dot, 'wf.two')).toContain('label = "⚙️ two"');
    expect(nodeBlock(dot, 'wf.three')).toContain('label = "⚙️ three"');
    expect(edgeBlock(dot, 'wf.__START__', 'wf.one')).toContain(
      'color = "#cccccc"',
    );
    expect(dot).toContain('"wf.one" -> "wf.two"');
    expect(dot).toContain('"wf.two" -> "wf.three"');
  });

  it('draws the entry sentinel as a point rather than a labelled box', async () => {
    const workflow = new Workflow({
      name: 'wf',
      edges: [['START', node(noopHandler, {name: 'one'})]],
    });

    const dot = await renderDot(workflow);

    const start = nodeBlock(dot, 'wf.__START__');
    expect(start).toContain('shape = "point"');
    expect(start).toContain('label = ""');
    expect(dot).not.toContain('label = "__START__"');
    expect(dot).not.toContain('label = "⚙️ __START__"');
  });

  it('labels conditional edges with their route values', async () => {
    const classify = node(noopHandler, {name: 'classify'});
    const approve = node(noopHandler, {name: 'approve'});
    const reject = node(noopHandler, {name: 'reject'});
    const workflow = new Workflow({
      name: 'router',
      edges: [
        ['START', classify],
        [classify, {yes: approve, [DEFAULT_ROUTE]: reject}],
      ],
    });

    const dot = await renderDot(workflow);

    expect(edgeBlock(dot, 'router.classify', 'router.approve')).toContain(
      'label = "yes"',
    );
    expect(edgeBlock(dot, 'router.classify', 'router.reject')).toContain(
      'label = "default"',
    );
    expect(dot).not.toContain('__DEFAULT__');
    expect(edgeBlock(dot, 'router.__START__', 'router.classify')).not.toContain(
      'label',
    );
  });

  it('lists every route of a multi-route edge in one label', async () => {
    const classify = node(noopHandler, {name: 'classify'});
    const handle = node(noopHandler, {name: 'handle'});
    const workflow = new Workflow({
      name: 'router',
      edges: [
        ['START', classify],
        new Edge(classify, handle, ['yes', 'maybe']),
      ],
    });

    const dot = await renderDot(workflow);

    expect(edgeBlock(dot, 'router.classify', 'router.handle')).toContain(
      'label = "yes, maybe"',
    );
  });

  it('merges two routes to the same node into one labelled edge', async () => {
    const classify = node(noopHandler, {name: 'classify'});
    const send = node(noopHandler, {name: 'send'});

    // The renderer emits into a `strict` graph, which merges same-endpoint
    // statements and keeps only the last label. Two route keys pointing at one
    // node are a supported shape, so the routes are joined before emitting.
    const workflow = new Workflow({
      name: 'router',
      edges: [
        ['START', classify],
        [classify, {yes: send, no: send}],
      ],
    });

    const dot = await renderDot(workflow);

    expect(edgeBlock(dot, 'router.classify', 'router.send')).toContain(
      'label = "yes, no"',
    );
  });

  it('renders a nested workflow as a recursive cluster', async () => {
    const inner = new Workflow({
      name: 'inner',
      edges: [['START', node(noopHandler, {name: 'step'})]],
    });
    const outer = new Workflow({
      name: 'outer',
      edges: [
        [
          'START',
          node(noopHandler, {name: 'pre'}),
          inner,
          node(noopHandler, {name: 'post'}),
        ],
      ],
    });

    const dot = await renderDot(outer);

    expect(dot).toContain('subgraph "cluster_outer" {');
    expect(dot).toContain('subgraph "cluster_outer.inner" {');
    expect(dot).toContain('label = "🧩 inner"');
    expect(nodeBlock(dot, 'outer.inner.step')).toContain('label = "⚙️ step"');
    expect(dot).toContain('"outer.pre" -> "outer.inner.__START__"');
    expect(dot).toContain('"outer.inner.step" -> "outer.post"');
  });

  it('anchors an edge out of a workflow that ends in another workflow', async () => {
    const leaf = new Workflow({
      name: 'leaf',
      edges: [['START', node(noopHandler, {name: 'deep'})]],
    });
    const middle = new Workflow({
      name: 'middle',
      edges: [['START', node(noopHandler, {name: 'mid'}), leaf]],
    });
    const outer = new Workflow({
      name: 'outer',
      edges: [['START', middle, node(noopHandler, {name: 'post'})]],
    });

    const dot = await renderDot(outer);

    // The tail is the real leaf node, not the `outer.middle.leaf` cluster id,
    // which no drawn node carries.
    expect(dot).toContain('"outer.middle.leaf.deep" -> "outer.post"');
    expect(dot).not.toContain('"outer.middle.leaf" -> "outer.post"');
    expect(dot).not.toContain('"outer.middle" -> "outer.post"');
  });

  it('shape-codes agent, tool, join and parallel-worker nodes', async () => {
    const writer = new LlmAgent({name: 'writer'});
    const lookup = new FunctionTool({
      name: 'lookup',
      description: 'a test tool',
      execute: async () => 'result',
    });
    const join = new JoinNode({name: 'join'});
    const fanout = node(noopHandler, {name: 'fanout', parallelWorker: true});
    const workflow = new Workflow({
      name: 'kinds',
      edges: [
        ['START', node(writer), join],
        ['START', node(lookup), join],
        [join, fanout],
      ],
    });

    const dot = await renderDot(workflow);

    expect(nodeBlock(dot, 'kinds.writer')).toContain('label = "🤖 writer"');
    expect(nodeBlock(dot, 'kinds.writer')).toContain('shape = "ellipse"');
    expect(nodeBlock(dot, 'kinds.lookup')).toContain('label = "🔧 lookup"');
    expect(nodeBlock(dot, 'kinds.lookup')).toContain('shape = "box"');
    expect(nodeBlock(dot, 'kinds.join')).toContain('label = "🔗 join"');
    expect(nodeBlock(dot, 'kinds.join')).toContain('shape = "hexagon"');
    expect(nodeBlock(dot, 'kinds.fanout')).toContain('label = "🧵 fanout"');
    expect(nodeBlock(dot, 'kinds.fanout')).toContain('shape = "box3d"');
  });

  it('renders an imperative dynamicEntry workflow without a static graph', async () => {
    const workflow = new Workflow({
      name: 'dyn',
      dynamicEntry: async () => 'done',
    });

    const dot = await renderDot(workflow);

    expect(dot).toContain('subgraph "cluster_dyn" {');
    expect(nodeBlock(dot, 'dyn')).toContain('label = "⚡ dyn (dynamic)"');
  });

  it('highlights the dynamic placeholder for an event from one of its nodes', async () => {
    const workflow = new Workflow({
      name: 'dyn',
      dynamicEntry: async () => 'done',
    });

    const dot = await renderDot(workflow, [['dyn.child', '']]);

    expect(nodeBlock(dot, 'dyn')).toContain('fillcolor = "#0F5223"');
  });
});

describe('AgentGraph — workflow execution highlights', () => {
  const workflow = () =>
    new Workflow({
      name: 'wf',
      edges: [
        [
          'START',
          node(noopHandler, {name: 'one'}),
          node(noopHandler, {name: 'two'}),
        ],
      ],
    });

  function nodeEvent(invocationId: string, path: string): Event {
    return createEvent({
      invocationId,
      author: path,
      nodeInfo: {path},
    });
  }

  it('derives the executed node and the traversed edge from nodeInfo.path', async () => {
    const events = [
      nodeEvent('inv-1', 'wf.one'),
      nodeEvent('inv-1', 'wf.two@0'),
    ];

    const highlights = getWorkflowHighlights(events, events[1]);
    expect(highlights).toEqual([['wf.one', 'wf.two']]);

    const dot = await renderDot(workflow(), highlights!);
    expect(nodeBlock(dot, 'wf.two')).toContain('fillcolor = "#0F5223"');
    expect(nodeBlock(dot, 'wf.one')).toContain('fillcolor = "#0F5223"');
    expect(edgeBlock(dot, 'wf.one', 'wf.two')).toContain('color = "#69CB87"');
  });

  it('highlights only the node when it is the first of the invocation', async () => {
    const events = [nodeEvent('inv-0', 'wf.two'), nodeEvent('inv-1', 'wf.one')];

    const highlights = getWorkflowHighlights(events, events[1]);
    expect(highlights).toEqual([['wf.one', '']]);

    const dot = await renderDot(workflow(), highlights!);
    expect(nodeBlock(dot, 'wf.one')).toContain('fillcolor = "#0F5223"');
    expect(nodeBlock(dot, 'wf.two')).toContain('fillcolor = "#ffffff"');
    expect(edgeBlock(dot, 'wf.one', 'wf.two')).toContain('color = "#cccccc"');
  });

  it('skips repeated events from the same node when finding the edge', async () => {
    const events = [
      nodeEvent('inv-1', 'wf.one'),
      nodeEvent('inv-1', 'wf.two'),
      nodeEvent('inv-1', 'wf.two'),
    ];

    expect(getWorkflowHighlights(events, events[2])).toEqual([
      ['wf.one', 'wf.two'],
    ]);
  });

  it('highlights a parallel-worker box for an event from one of its items', async () => {
    const fanout = node(noopHandler, {name: 'fanout', parallelWorker: true});
    const parallel = new Workflow({
      name: 'wf',
      edges: [['START', fanout]],
    });
    // A `ParallelWorker` item runs at `<node path>.<inner name>@<index>`, so the
    // event path sits one level below the box that is actually drawn.
    const events = [nodeEvent('inv-1', 'wf.fanout.fanout@0')];

    const highlights = getWorkflowHighlights(events, events[0]);
    expect(highlights).toEqual([['wf.fanout.fanout', '']]);

    const dot = await renderDot(parallel, highlights!);
    expect(nodeBlock(dot, 'wf.fanout')).toContain('fillcolor = "#0F5223"');
  });

  it('returns undefined for an event that no workflow node produced', () => {
    const event = createEvent({invocationId: 'inv-1', author: 'agent'});

    expect(getWorkflowHighlights([event], event)).toBeUndefined();
  });
});
