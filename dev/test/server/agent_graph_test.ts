import {FunctionTool, LlmAgent, LoopAgent, ParallelAgent, SequentialAgent} from '@google/adk';

import {getAgentGraphAsDot} from '../../src/server/agent_graph.js';

describe('AgentGraph', () => {
  it('generates a DOT graph for a simple LlmAgent with a FunctionTool',
     async () => {
       const tool = new FunctionTool({
         name: 'testTool',
         description: 'a test tool',
         execute: async () => 'result'
       });
       const agent = new LlmAgent({
         name: 'testAgent',
         tools: [tool],
       });

       const dotGraph = await getAgentGraphAsDot(agent, []);
       expect(dotGraph).toContain(`strict digraph "testAgent" {
  rankdir = "LR";
  bgcolor = "#333537";
  "testAgent" [
    label = "🤖 testAgent";
    style = "rounded";
    fillcolor = "#ffffff";
    color = "#cccccc";
    shape = "ellipse";
    fontcolor = "#cccccc";
  ];
  "testTool" [
    label = "🔧 testTool";
    style = "rounded";
    fillcolor = "#ffffff";
    color = "#cccccc";
    shape = "box";
    fontcolor = "#cccccc";
  ];
  "testAgent" -> "testTool" [
    arrowhead = "none";
    color = "#cccccc";
  ];
}`);
     });

  it('generates a DOT graph for a SequentialAgent', async () => {
    const tool1 = new FunctionTool(
        {name: 'tool1', description: 'tool1', execute: async () => 'result'});
    const agent1 = new LlmAgent({
      name: 'agent1',
      tools: [tool1],
    });
    const tool2 = new FunctionTool(
        {name: 'tool2', description: 'tool2', execute: async () => 'result'});
    const agent2 = new LlmAgent({
      name: 'agent2',
      tools: [tool2],
    });
    const sequentialAgent = new SequentialAgent({
      name: 'sequentialAgent',
      subAgents: [agent1, agent2],
    });

    const dotGraph = await getAgentGraphAsDot(sequentialAgent, []);
    expect(dotGraph).toContain(`strict digraph "sequentialAgent" {
  rankdir = "LR";
  bgcolor = "#333537";
  "agent1" [
    label = "🤖 agent1";
    style = "rounded";
    fillcolor = "#ffffff";
    color = "#cccccc";
    shape = "ellipse";
    fontcolor = "#cccccc";
  ];
  "tool1" [
    label = "🔧 tool1";
    style = "rounded";
    fillcolor = "#ffffff";
    color = "#cccccc";
    shape = "box";
    fontcolor = "#cccccc";
  ];
  "agent2" [
    label = "🤖 agent2";
    style = "rounded";
    fillcolor = "#ffffff";
    color = "#cccccc";
    shape = "ellipse";
    fontcolor = "#cccccc";
  ];
  "tool2" [
    label = "🔧 tool2";
    style = "rounded";
    fillcolor = "#ffffff";
    color = "#cccccc";
    shape = "box";
    fontcolor = "#cccccc";
  ];
  subgraph "cluster_sequentialAgent (Sequential Agent)" {
    label = "cluster_sequentialAgent (Sequential Agent)";
    style = "rounded";
    bgcolor = "#ffffff";
    fontcolor = "#cccccc";
    "agent1" [
      label = "🤖 agent1";
      style = "rounded";
      fillcolor = "#ffffff";
      color = "#cccccc";
      shape = "ellipse";
      fontcolor = "#cccccc";
    ];
    "tool1" [
      label = "🔧 tool1";
      style = "rounded";
      fillcolor = "#ffffff";
      color = "#cccccc";
      shape = "box";
      fontcolor = "#cccccc";
    ];
    "agent2" [
      label = "🤖 agent2";
      style = "rounded";
      fillcolor = "#ffffff";
      color = "#cccccc";
      shape = "ellipse";
      fontcolor = "#cccccc";
    ];
    "tool2" [
      label = "🔧 tool2";
      style = "rounded";
      fillcolor = "#ffffff";
      color = "#cccccc";
      shape = "box";
      fontcolor = "#cccccc";
    ];
    "agent1" -> "tool1" [
      arrowhead = "none";
      color = "#cccccc";
    ];
    "agent2" -> "tool2" [
      arrowhead = "none";
      color = "#cccccc";
    ];
  }
  "agent1" -> "agent2" [
    color = "#69CB87";
  ];
  "agent1" -> "tool1" [
    arrowhead = "none";
    color = "#cccccc";
  ];
  "agent2" -> "tool2" [
    arrowhead = "none";
    color = "#cccccc";
  ];
}`);
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

    expect(dotGraph).toContain(`strict digraph "sequentialAgent" {
  rankdir = "LR";
  bgcolor = "#333537";
  "agent1" [
    label = "🤖 agent1";
    style = "filled,rounded";
    fillcolor = "#0F5223";
    color = "#0F5223";
    shape = "ellipse";
    fontcolor = "#cccccc";
  ];
  "agent2" [
    label = "🤖 agent2";
    style = "filled,rounded";
    fillcolor = "#0F5223";
    color = "#0F5223";
    shape = "ellipse";
    fontcolor = "#cccccc";
  ];
  subgraph "cluster_sequentialAgent (Sequential Agent)" {
    label = "cluster_sequentialAgent (Sequential Agent)";
    style = "rounded";
    bgcolor = "#ffffff";
    fontcolor = "#cccccc";
    "agent1" [
      label = "🤖 agent1";
      style = "filled,rounded";
      fillcolor = "#0F5223";
      color = "#0F5223";
      shape = "ellipse";
      fontcolor = "#cccccc";
    ];
    "agent2" [
      label = "🤖 agent2";
      style = "filled,rounded";
      fillcolor = "#0F5223";
      color = "#0F5223";
      shape = "ellipse";
      fontcolor = "#cccccc";
    ];
  }
  "agent1" -> "agent2" [
    color = "#69CB87";
  ];
}`);
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

    expect(dotGraph).toEqual(`strict digraph "sequentialAgent" {
  rankdir = "LR";
  bgcolor = "#333537";
  "agent1" [
    label = "🤖 agent1";
    style = "filled,rounded";
    fillcolor = "#0F5223";
    color = "#0F5223";
    shape = "ellipse";
    fontcolor = "#cccccc";
  ];
  "agent2" [
    label = "🤖 agent2";
    style = "rounded";
    fillcolor = "#ffffff";
    color = "#cccccc";
    shape = "ellipse";
    fontcolor = "#cccccc";
  ];
  subgraph "cluster_sequentialAgent (Sequential Agent)" {
    label = "cluster_sequentialAgent (Sequential Agent)";
    style = "rounded";
    bgcolor = "#ffffff";
    fontcolor = "#cccccc";
    "agent1" [
      label = "🤖 agent1";
      style = "filled,rounded";
      fillcolor = "#0F5223";
      color = "#0F5223";
      shape = "ellipse";
      fontcolor = "#cccccc";
    ];
    "agent2" [
      label = "🤖 agent2";
      style = "rounded";
      fillcolor = "#ffffff";
      color = "#cccccc";
      shape = "ellipse";
      fontcolor = "#cccccc";
    ];
  }
  "agent1" -> "agent2" [
    color = "#69CB87";
  ];
}`);
    expect(dotGraph).toEqual(`strict digraph "sequentialAgent" {
  rankdir = "LR";
  bgcolor = "#333537";
  "agent1" [
    label = "🤖 agent1";
    style = "filled,rounded";
    fillcolor = "#0F5223";
    color = "#0F5223";
    shape = "ellipse";
    fontcolor = "#cccccc";
  ];
  "agent2" [
    label = "🤖 agent2";
    style = "rounded";
    fillcolor = "#ffffff";
    color = "#cccccc";
    shape = "ellipse";
    fontcolor = "#cccccc";
  ];
  subgraph "cluster_sequentialAgent (Sequential Agent)" {
    label = "cluster_sequentialAgent (Sequential Agent)";
    style = "rounded";
    bgcolor = "#ffffff";
    fontcolor = "#cccccc";
    "agent1" [
      label = "🤖 agent1";
      style = "filled,rounded";
      fillcolor = "#0F5223";
      color = "#0F5223";
      shape = "ellipse";
      fontcolor = "#cccccc";
    ];
    "agent2" [
      label = "🤖 agent2";
      style = "rounded";
      fillcolor = "#ffffff";
      color = "#cccccc";
      shape = "ellipse";
      fontcolor = "#cccccc";
    ];
  }
  "agent1" -> "agent2" [
    color = "#69CB87";
  ];
}`);
  });

  it('generates a DOT graph for a LoopAgent', async () => {
    const tool1 = new FunctionTool(
        {name: 'tool1', description: 'tool1', execute: async () => 'result'});
    const agent1 = new LlmAgent({
      name: 'agent1',
      tools: [tool1],
    });
    const tool2 = new FunctionTool(
        {name: 'tool2', description: 'tool2', execute: async () => 'result'});
    const agent2 = new LlmAgent({
      name: 'agent2',
      tools: [tool2],
    });
    const loopAgent = new LoopAgent({
      name: 'loopAgent',
      subAgents: [agent1, agent2],
    });

    const dotGraph = await getAgentGraphAsDot(loopAgent, []);
    expect(dotGraph).toContain(`strict digraph "loopAgent" {
  rankdir = "LR";
  bgcolor = "#333537";
  "agent1" [
    label = "🤖 agent1";
    style = "rounded";
    fillcolor = "#ffffff";
    color = "#cccccc";
    shape = "ellipse";
    fontcolor = "#cccccc";
  ];
  "tool1" [
    label = "🔧 tool1";
    style = "rounded";
    fillcolor = "#ffffff";
    color = "#cccccc";
    shape = "box";
    fontcolor = "#cccccc";
  ];
  "agent2" [
    label = "🤖 agent2";
    style = "rounded";
    fillcolor = "#ffffff";
    color = "#cccccc";
    shape = "ellipse";
    fontcolor = "#cccccc";
  ];
  "tool2" [
    label = "🔧 tool2";
    style = "rounded";
    fillcolor = "#ffffff";
    color = "#cccccc";
    shape = "box";
    fontcolor = "#cccccc";
  ];
  subgraph "cluster_loopAgent (Loop Agent)" {
    label = "cluster_loopAgent (Loop Agent)";
    style = "rounded";
    bgcolor = "#ffffff";
    fontcolor = "#cccccc";
    "agent1" [
      label = "🤖 agent1";
      style = "rounded";
      fillcolor = "#ffffff";
      color = "#cccccc";
      shape = "ellipse";
      fontcolor = "#cccccc";
    ];
    "tool1" [
      label = "🔧 tool1";
      style = "rounded";
      fillcolor = "#ffffff";
      color = "#cccccc";
      shape = "box";
      fontcolor = "#cccccc";
    ];
    "agent2" [
      label = "🤖 agent2";
      style = "rounded";
      fillcolor = "#ffffff";
      color = "#cccccc";
      shape = "ellipse";
      fontcolor = "#cccccc";
    ];
    "tool2" [
      label = "🔧 tool2";
      style = "rounded";
      fillcolor = "#ffffff";
      color = "#cccccc";
      shape = "box";
      fontcolor = "#cccccc";
    ];
    "agent1" -> "tool1" [
      arrowhead = "none";
      color = "#cccccc";
    ];
    "agent2" -> "tool2" [
      arrowhead = "none";
      color = "#cccccc";
    ];
  }
  "agent1" -> "agent2" [
    color = "#69CB87";
  ];
  "agent2" -> "agent1" [
    color = "#69CB87";
  ];
  "agent1" -> "tool1" [
    arrowhead = "none";
    color = "#cccccc";
  ];
  "agent2" -> "tool2" [
    arrowhead = "none";
    color = "#cccccc";
  ];
}`);
  });

  it('generates a DOT graph for a ParallelAgent', async () => {
    const tool1 = new FunctionTool(
        {name: 'tool1', description: 'tool1', execute: async () => 'result'});
    const agent1 = new LlmAgent({
      name: 'agent1',
      tools: [tool1],
    });
    const tool2 = new FunctionTool(
        {name: 'tool2', description: 'tool2', execute: async () => 'result'});
    const agent2 = new LlmAgent({
      name: 'agent2',
      tools: [tool2],
    });
    const parallelAgent = new ParallelAgent({
      name: 'parallelAgent',
      subAgents: [agent1, agent2],
    });

    const dotGraph = await getAgentGraphAsDot(parallelAgent, []);
    expect(dotGraph).toContain(`strict digraph "parallelAgent" {
  rankdir = "LR";
  bgcolor = "#333537";
  "agent1" [
    label = "🤖 agent1";
    style = "rounded";
    fillcolor = "#ffffff";
    color = "#cccccc";
    shape = "ellipse";
    fontcolor = "#cccccc";
  ];
  "tool1" [
    label = "🔧 tool1";
    style = "rounded";
    fillcolor = "#ffffff";
    color = "#cccccc";
    shape = "box";
    fontcolor = "#cccccc";
  ];
  "agent2" [
    label = "🤖 agent2";
    style = "rounded";
    fillcolor = "#ffffff";
    color = "#cccccc";
    shape = "ellipse";
    fontcolor = "#cccccc";
  ];
  "tool2" [
    label = "🔧 tool2";
    style = "rounded";
    fillcolor = "#ffffff";
    color = "#cccccc";
    shape = "box";
    fontcolor = "#cccccc";
  ];
  subgraph "cluster_parallelAgent (Parallel Agent)" {
    label = "cluster_parallelAgent (Parallel Agent)";
    style = "rounded";
    bgcolor = "#ffffff";
    fontcolor = "#cccccc";
    "agent1" [
      label = "🤖 agent1";
      style = "rounded";
      fillcolor = "#ffffff";
      color = "#cccccc";
      shape = "ellipse";
      fontcolor = "#cccccc";
    ];
    "tool1" [
      label = "🔧 tool1";
      style = "rounded";
      fillcolor = "#ffffff";
      color = "#cccccc";
      shape = "box";
      fontcolor = "#cccccc";
    ];
    "agent2" [
      label = "🤖 agent2";
      style = "rounded";
      fillcolor = "#ffffff";
      color = "#cccccc";
      shape = "ellipse";
      fontcolor = "#cccccc";
    ];
    "tool2" [
      label = "🔧 tool2";
      style = "rounded";
      fillcolor = "#ffffff";
      color = "#cccccc";
      shape = "box";
      fontcolor = "#cccccc";
    ];
    "agent1" -> "tool1" [
      arrowhead = "none";
      color = "#cccccc";
    ];
    "agent2" -> "tool2" [
      arrowhead = "none";
      color = "#cccccc";
    ];
  }
  "agent1" -> "tool1" [
    arrowhead = "none";
    color = "#cccccc";
  ];
  "agent2" -> "tool2" [
    arrowhead = "none";
    color = "#cccccc";
  ];
}`);
  });
});
