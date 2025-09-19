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
       expect(dotGraph).toContain('digraph "testAgent"');
       expect(dotGraph).toContain('"testAgent" -> "testTool"');
       expect(dotGraph).toContain('label = "🤖 testAgent"');
       expect(dotGraph).toContain('label = "🔧 testTool"');
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
    expect(dotGraph).toContain('digraph "sequentialAgent"');
    expect(dotGraph).toContain('cluster_sequentialAgent');
    expect(dotGraph).toContain('"agent1" -> "agent2"');
    expect(dotGraph).toContain('"agent1" -> "tool1"');
    expect(dotGraph).toContain('"agent2" -> "tool2"');
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

    expect(dotGraph).toContain(`"agent1" -> "agent2"`);
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

    expect(dotGraph).toMatch(
        /\"agent1\"\s*\[[^\]]*style = \"filled,rounded\",[^\]]*fillcolor = \"#0F5223\",[^\]]*\];/s,
    );
    expect(dotGraph).not.toMatch(
        /\"agent2\"\s*\[[^\]]*style = \"filled,rounded\",[^\]]*fillcolor = \"#0F5223\",[^\]]*\];/s,
    );
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
    expect(dotGraph).toContain('digraph "loopAgent"');
    expect(dotGraph).toContain('cluster_loopAgent');
    expect(dotGraph).toContain('"agent1" -> "agent2"');
    expect(dotGraph).toContain('"agent2" -> "agent1"');
    expect(dotGraph).toContain('"agent1" -> "tool1"');
    expect(dotGraph).toContain('"agent2" -> "tool2"');
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
    expect(dotGraph).toContain('digraph "parallelAgent"');
    expect(dotGraph).toContain('cluster_parallelAgent');
    expect(dotGraph).toContain('"agent1" -> "tool1"');
    expect(dotGraph).toContain('"agent2" -> "tool2"');
  });
});
