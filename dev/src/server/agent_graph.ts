/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {BaseAgent, BaseTool, isBaseAgent, isParallelAgent, isSequentialAgent, isLlmAgent, isLoopAgent, isBaseTool, isFunctionTool, isAgentTool} from '@google/adk';
import {Digraph, Edge, Node, RootGraph, Subgraph, toDot} from 'ts-graphviz';

const DARK_GREEN = '#0F5223';
const LIGHT_GREEN = '#69CB87';
const LIGHT_GRAY = '#cccccc';
const WHITE = '#ffffff';

export async function buildGraph(
    graph: RootGraph|Subgraph,
    rootAgent: BaseAgent,
    highlightsPairs: Array<[string, string]>,
    parentAgent?: BaseAgent,
) {
  async function buildCluster(
      subgraph: Subgraph,
      agent: BaseAgent,
      ): Promise<Subgraph> {
    if (isLoopAgent(agent)) {
      if (parentAgent) {
        drawEdge(parentAgent.name, agent.subAgents[0].name);
      }

      const length = agent.subAgents.length;
      let currLength = 0;

      for (const subAgent of agent.subAgents) {
        await buildGraph(subgraph, subAgent, highlightsPairs, agent);

        const adjAgent = currLength === length - 1 ?
            agent.subAgents[0] :
            agent.subAgents[currLength + 1];

        drawEdge(
            agent.subAgents[currLength].name,
            adjAgent.name,
        );
        currLength++;
      }
    } else if (isSequentialAgent(agent)) {
      if (parentAgent) {
        drawEdge(parentAgent.name, agent.subAgents[0].name);
      }

      const length = agent.subAgents.length;
      let currLength = 0;

      for (const subAgent of agent.subAgents) {
        await buildGraph(subgraph, subAgent, highlightsPairs, agent);

        if (currLength !== length - 1) {
          drawEdge(
              agent.subAgents[currLength].name,
              agent.subAgents[currLength + 1].name,
          );
        }

        currLength++;
      }
    } else if (isParallelAgent(agent)) {
      for (const subAgent of agent.subAgents) {
        await buildGraph(subgraph, subAgent, highlightsPairs, agent);
        if (parentAgent) {
          drawEdge(parentAgent.name, subAgent.name);
        }
      }
    } else {
      for (const subAgent of agent.subAgents) {
        await buildGraph(subgraph, subAgent, highlightsPairs, agent);
        drawEdge(agent.name, subAgent.name);
      }
    }

    return subgraph;
  }

  async function drawNode(toolOrAgent: BaseAgent|BaseTool) {
    const name = getNodeName(toolOrAgent);
    const shape = getNodeShape(toolOrAgent);
    const caption = getNodeCaption(toolOrAgent);
    const asCluster = shouldBuildAgentCluster(toolOrAgent);

    if (highlightsPairs) {
      for (const highlightsPair of highlightsPairs) {
        if (highlightsPair.includes(name)) {
          if (asCluster) {
            const cluster = new Subgraph(`cluster_${name}`, {
              label: `cluster_${name}`,
              style: 'rounded',
              bgcolor: WHITE,
              fontcolor: LIGHT_GRAY,
            });
            graph.addSubgraph(cluster);

            await buildCluster(cluster, rootAgent);
          } else {
            graph.addNode(new Node(name, {
              label: caption,
              style: 'filled,rounded',
              fillcolor: DARK_GREEN,
              color: DARK_GREEN,
              shape,
              fontcolor: LIGHT_GRAY
            }));
          }
          return;
        }
      }
    }

    if (asCluster) {
      const cluster = new Subgraph(`cluster_${name}`, {
        label: `cluster_${name}`,
        style: 'rounded',
        bgcolor: WHITE,
        fontcolor: LIGHT_GRAY,
      });
      graph.addSubgraph(cluster);

      await buildCluster(cluster, rootAgent);

      return;
    }

    graph.addNode(new Node(name, {
      label: caption,
      style: 'rounded',
      fillcolor: WHITE,
      color: LIGHT_GRAY,
      shape,
      fontcolor: LIGHT_GRAY
    }));
  }

  function drawEdge(fromName: string, toName: string) {
    if (highlightsPairs) {
      for (const [highlightFrom, highlightTo] of highlightsPairs) {
        if (fromName === highlightFrom && toName === highlightTo) {
          graph.addEdge(new Edge(
              [graph.node(fromName), graph.node(toName)],
              {color: LIGHT_GREEN}));
          return
        }

        if (fromName === highlightTo && toName === highlightFrom) {
          graph.addEdge(new Edge(
              [graph.node(fromName), graph.node(toName)],
              {color: LIGHT_GREEN, dir: 'back'}));
          return
        }
      }
    }

    if (shouldBuildAgentCluster(rootAgent)) {
      graph.addEdge(new Edge(
          [new Node(fromName), new Node(toName)], {color: LIGHT_GREEN}));

      return;
    }

    graph.addEdge(new Edge(
        [new Node(fromName), new Node(toName)],
        {arrowhead: 'none', color: LIGHT_GRAY}));
  }

  await drawNode(rootAgent);

  for (const subAgent of rootAgent.subAgents) {
    await buildGraph(graph, subAgent, highlightsPairs, rootAgent);

    if (!shouldBuildAgentCluster(subAgent) &&
        !shouldBuildAgentCluster(rootAgent)) {
      drawEdge(rootAgent.name, subAgent.name);
    }
  }

  if (isLlmAgent(rootAgent)) {
    for (const tool of await rootAgent.canonicalTools()) {
      await drawNode(tool);
      drawEdge(rootAgent.name, getNodeName(tool));
    }
  }
}

function getNodeName(toolOrAgent: BaseAgent|BaseTool): string {
  if (isBaseAgent(toolOrAgent)) {
    if (isSequentialAgent(toolOrAgent)) {
      return `${toolOrAgent.name} (Sequential Agent)`;
    }

    if (isLoopAgent(toolOrAgent)) {
      return `${toolOrAgent.name} (Loop Agent)`;
    }

    if (isParallelAgent(toolOrAgent)) {
      return `${toolOrAgent.name} (Parallel Agent)`;
    }

    return toolOrAgent.name;
  }

  if (isBaseTool(toolOrAgent)) {
    return toolOrAgent.name;
  }

  throw new Error(`Unsupported tool type: ${toolOrAgent}`);
}

// TODO: Support BaseRetrievalTool
function getNodeCaption(toolOrAgent: BaseAgent|BaseTool): string {
  if (isBaseAgent(toolOrAgent)) {
    return `🤖 ${toolOrAgent.name}`;
  }

  if (isFunctionTool(toolOrAgent)) {
    return `🔧 ${toolOrAgent.name}`;
  }

  if (isAgentTool(toolOrAgent)) {
    return `🤖 ${toolOrAgent.name}`;
  }

  if (isBaseTool(toolOrAgent)) {
    return `🔧 ${toolOrAgent.name}`;
  }

  console.warn(
      `Unsupported tool type: ${typeof toolOrAgent}`,
  );

  return `❓ Unsupported tool type: ${typeof toolOrAgent}`;
}

// TODO: Support BaseRetrievalTool
function getNodeShape(toolOrAgent: BaseAgent|BaseTool): string {
  if (isBaseAgent(toolOrAgent)) {
    return 'ellipse';
  }

  if (isFunctionTool(toolOrAgent)) {
    return 'box';
  }

  if (isBaseTool(toolOrAgent)) {
    return 'box';
  }

  console.warn(
      `Unsupported tool type: ${typeof toolOrAgent}`,
  );

  return 'cylinder';
}

// TODO: Support BaseRetrievalTool
function shouldBuildAgentCluster(toolOrAgent: BaseAgent|BaseTool): boolean {
  if (isSequentialAgent(toolOrAgent)) {
    return true;
  }

  if (isLoopAgent(toolOrAgent)) {
    return true;
  }

  if (isParallelAgent(toolOrAgent)) {
    return true;
  }

  return false;
}

/**
 * Returns a graphviz graph of the agent tree.
 *
 * @param rootAgent The root agent of the agent tree.
 * @param highlightsPairs An array of pairs of agent names to highlight.
 * @return A graphviz graph of the agent tree.
 */
export async function getAgentGraph(
    rootAgent: BaseAgent,
    highlightsPairs: Array<[string, string]>,
    ): Promise<Digraph> {
  const graph = new Digraph(rootAgent.name, /* strict= */ true, {
    rankdir: 'LR',
    bgcolor: '#333537',
  });

  await buildGraph(graph, rootAgent, highlightsPairs);

  return graph;
}

/**
 * Returns a graphviz graph in DOT format of the agent tree as a string.
 *
 * @param rootAgent The root agent of the agent tree.
 * @param highlightsPairs An array of pairs of agent names to highlight.
 * @return A graphviz graph in DOT format of the agent tree as a string.
 */
export async function getAgentGraphAsDot(
    rootAgent: BaseAgent,
    highlightsPairs: Array<[string, string]>,
    ): Promise<string> {
  const graph = await getAgentGraph(rootAgent, highlightsPairs);

  return toDot(graph);
}
