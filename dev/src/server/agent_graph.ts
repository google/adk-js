/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  BaseAgent,
  BaseNode,
  BaseTool,
  DEFAULT_ROUTE,
  Event,
  RouteValue,
  RunnableRoot,
  Workflow,
  Graph as WorkflowGraph,
  isAgentTool,
  isBaseAgent,
  isBaseTool,
  isFunctionTool,
  isLlmAgent,
  isLoopAgent,
  isParallelAgent,
  isSequentialAgent,
  isWorkflow,
} from '@google/adk';
import {
  Digraph,
  Edge,
  Node,
  NodeAttributesObject,
  RootGraph,
  Subgraph,
  toDot,
} from 'ts-graphviz';

const DARK_GREEN = '#0F5223';
const LIGHT_GREEN = '#69CB87';
const LIGHT_GRAY = '#cccccc';
const WHITE = '#ffffff';

const WORKFLOW_START_NODE_NAME = '__START__';

const DEFAULT_ROUTE_LABEL = 'default';

export async function buildGraph(
  graph: RootGraph | Subgraph,
  root: RunnableRoot,
  highlightsPairs: Array<[string, string]>,
  parentAgent?: BaseAgent,
) {
  if (isWorkflow(root)) {
    drawWorkflowCluster(graph, root, root.name, highlightsPairs);
    return;
  }

  // Past the guard this is an agent. Bound to a const so the closures below
  // keep the narrowing, which a parameter would lose.
  const rootAgent: BaseAgent = root;

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

        const adjAgent =
          currLength === length - 1
            ? agent.subAgents[0]
            : agent.subAgents[currLength + 1];

        drawEdge(agent.subAgents[currLength].name, adjAgent.name);
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

  async function drawNode(toolOrAgent: BaseAgent | BaseTool) {
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
            graph.addNode(
              new Node(name, {
                label: caption,
                style: 'filled,rounded',
                fillcolor: DARK_GREEN,
                color: DARK_GREEN,
                shape,
                fontcolor: LIGHT_GRAY,
              }),
            );
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

    graph.addNode(
      new Node(name, {
        label: caption,
        style: 'rounded',
        fillcolor: WHITE,
        color: LIGHT_GRAY,
        shape,
        fontcolor: LIGHT_GRAY,
      }),
    );
  }

  function drawEdge(fromName: string, toName: string) {
    if (highlightsPairs) {
      for (const [highlightFrom, highlightTo] of highlightsPairs) {
        if (fromName === highlightFrom && toName === highlightTo) {
          graph.addEdge(
            new Edge([graph.node(fromName), graph.node(toName)], {
              color: LIGHT_GREEN,
            }),
          );
          return;
        }

        if (fromName === highlightTo && toName === highlightFrom) {
          graph.addEdge(
            new Edge([graph.node(fromName), graph.node(toName)], {
              color: LIGHT_GREEN,
              dir: 'back',
            }),
          );
          return;
        }
      }
    }

    if (shouldBuildAgentCluster(rootAgent)) {
      graph.addEdge(
        new Edge([new Node(fromName), new Node(toName)], {
          color: LIGHT_GREEN,
        }),
      );

      return;
    }

    graph.addEdge(
      new Edge([new Node(fromName), new Node(toName)], {
        arrowhead: 'none',
        color: LIGHT_GRAY,
      }),
    );
  }

  await drawNode(rootAgent);

  for (const subAgent of rootAgent.subAgents) {
    await buildGraph(graph, subAgent, highlightsPairs, rootAgent);

    if (
      !shouldBuildAgentCluster(subAgent) &&
      !shouldBuildAgentCluster(rootAgent)
    ) {
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

function drawWorkflowCluster(
  container: RootGraph | Subgraph,
  workflow: Workflow,
  path: string,
  highlightsPairs: Array<[string, string]>,
) {
  const cluster = new Subgraph(`cluster_${path}`, {
    label: `🧩 ${workflow.name}`,
    style: 'rounded',
    bgcolor: WHITE,
    fontcolor: LIGHT_GRAY,
  });
  container.addSubgraph(cluster);

  const graph = workflow.graph;
  if (!graph) {
    cluster.addNode(
      new Node(path, {
        label: `⚡ ${workflow.name} (dynamic)`,
        ...workflowNodeStyle('box', isHighlightedWithin(path, highlightsPairs)),
      }),
    );

    return;
  }

  for (const node of graph.nodes) {
    drawWorkflowNode(cluster, node, path, highlightsPairs);
  }

  drawWorkflowEdges(cluster, graph, path, highlightsPairs);
}

function drawWorkflowNode(
  cluster: Subgraph,
  node: BaseNode,
  path: string,
  highlightsPairs: Array<[string, string]>,
) {
  const id = workflowNodeId(node, path);

  if (node.name === WORKFLOW_START_NODE_NAME) {
    cluster.addNode(
      new Node(id, {
        label: '',
        shape: 'point',
        width: 0.15,
        style: 'filled',
        color: LIGHT_GRAY,
        fillcolor: LIGHT_GRAY,
      }),
    );

    return;
  }

  const nested = asWorkflow(node);
  if (nested) {
    drawWorkflowCluster(cluster, nested, id, highlightsPairs);

    return;
  }

  const {icon, shape} = classifyWorkflowNode(node);
  cluster.addNode(
    new Node(id, {
      label: `${icon} ${node.name}`,
      // Prefix, not exact: a `ParallelWorker` item runs at
      // `<node path>.<inner name>@<i>`, so its events land below the drawn box.
      ...workflowNodeStyle(shape, isHighlightedWithin(id, highlightsPairs)),
    }),
  );
}

function drawWorkflowEdges(
  cluster: Subgraph,
  graph: WorkflowGraph,
  path: string,
  highlightsPairs: Array<[string, string]>,
) {
  // Edges are grouped by anchor pair before being emitted into the `strict`
  // root graph, which merges same-endpoint statements and would keep only the
  // last one's label. Two route keys can legitimately point at one node
  // (`{approve: shared, escalate: shared}`), so their routes are joined into a
  // single label exactly as a multi-route `Edge`'s are.
  const merged = new Map<
    string,
    {tail: string; head: string; routes: string[]; highlighted: boolean}
  >();

  for (const edge of graph.edges) {
    const from = workflowNodeId(edge.fromNode, path);
    const to = workflowNodeId(edge.toNode, path);
    const tail = workflowExitAnchorId(edge.fromNode, path);
    const head = workflowEntryAnchorId(edge.toNode, path);
    const key = `${tail}\u0000${head}`;
    const entry = merged.get(key) ?? {
      tail,
      head,
      routes: [],
      highlighted: false,
    };
    for (const label of getRouteLabels(edge.route)) {
      if (!entry.routes.includes(label)) {
        entry.routes.push(label);
      }
    }
    entry.highlighted ||= isHighlightedEdge(from, to, highlightsPairs);
    merged.set(key, entry);
  }

  for (const {tail, head, routes, highlighted} of merged.values()) {
    const color = highlighted ? LIGHT_GREEN : LIGHT_GRAY;
    cluster.addEdge(
      new Edge([new Node(tail), new Node(head)], {
        color,
        fontcolor: color,
        ...(routes.length > 0 ? {label: routes.join(', ')} : {}),
      }),
    );
  }
}

function workflowNodeId(node: BaseNode, path: string): string {
  return `${path}.${node.name}`;
}

function workflowEntryAnchorId(node: BaseNode, path: string): string {
  const id = workflowNodeId(node, path);
  const nested = asWorkflow(node);
  if (nested?.graph) {
    return `${id}.${WORKFLOW_START_NODE_NAME}`;
  }

  return id;
}

function workflowExitAnchorId(node: BaseNode, path: string): string {
  const nested = asWorkflow(node);
  const nestedGraph = nested?.graph;
  if (nestedGraph) {
    const id = workflowNodeId(node, path);
    const terminal = nestedGraph.nodes.find((n) =>
      nestedGraph.terminalNodeNames.has(n.name),
    );

    // Recurse: a terminal node can itself be a nested workflow, and its id is a
    // cluster id that no drawn node carries.
    return terminal
      ? workflowExitAnchorId(terminal, id)
      : workflowEntryAnchorId(node, path);
  }

  return workflowNodeId(node, path);
}

function getRouteLabels(route: RouteValue | RouteValue[] | null): string[] {
  if (route == null) {
    return [];
  }

  const routes = Array.isArray(route) ? route : [route];

  return routes.map((value) =>
    value === DEFAULT_ROUTE ? DEFAULT_ROUTE_LABEL : String(value),
  );
}

function workflowNodeStyle(
  shape: string,
  highlighted: boolean,
): NodeAttributesObject {
  return {
    shape,
    style: highlighted ? 'filled,rounded' : 'rounded',
    fillcolor: highlighted ? DARK_GREEN : WHITE,
    color: highlighted ? DARK_GREEN : LIGHT_GRAY,
    fontcolor: LIGHT_GRAY,
  };
}

/**
 * Whether an event highlights `path` itself or anything running below it.
 * Sibling names differ at every level, so the `.` guard cannot over-match.
 */
function isHighlightedWithin(
  path: string,
  highlightsPairs: Array<[string, string]>,
): boolean {
  return highlightsPairs.some((pair) =>
    pair.some((name) => name === path || name.startsWith(`${path}.`)),
  );
}

function isHighlightedEdge(
  fromName: string,
  toName: string,
  highlightsPairs: Array<[string, string]>,
): boolean {
  return highlightsPairs.some(
    ([from, to]) => from === fromName && to === toName,
  );
}

function asWorkflow(node: BaseNode): Workflow | undefined {
  const graph = getNodeField(node, 'graph');
  const isWorkflow =
    isWorkflowGraph(graph) ||
    typeof getNodeField(node, 'dynamicEntry') === 'function';

  return isWorkflow ? (node as Workflow) : undefined;
}

function isWorkflowGraph(value: unknown): value is WorkflowGraph {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as WorkflowGraph).nodes) &&
    Array.isArray((value as WorkflowGraph).edges)
  );
}

function getNodeField(node: BaseNode, field: string): unknown {
  return (node as unknown as Record<string, unknown>)[field];
}

/**
 * Detects what a node is, structurally — the dev server loads the user's agent
 * module, which may resolve its own copy of `@google/adk`, so `instanceof` is
 * not available. Caption and shape come from one pass so they cannot drift.
 */
function classifyWorkflowNode(node: BaseNode): {icon: string; shape: string} {
  if (isBaseAgent(node)) {
    return {icon: '🤖', shape: 'ellipse'};
  }

  if (isBaseTool(getNodeField(node, 'tool'))) {
    return {icon: '🔧', shape: 'box'};
  }

  if ('maxParallelWorkers' in node) {
    return {icon: '🧵', shape: 'box3d'};
  }

  if (node.requiresAllPredecessors) {
    return {icon: '🔗', shape: 'hexagon'};
  }

  return {icon: '⚙️', shape: 'box'};
}

export function getWorkflowHighlights(
  sessionEvents: Event[],
  event: Event,
): Array<[string, string]> | undefined {
  const path = event.nodeInfo?.path;
  if (!path) {
    return undefined;
  }

  const nodeId = toWorkflowNodeId(path);
  const index = sessionEvents.findIndex((e) => e.id === event.id);

  for (let i = index - 1; i >= 0; i--) {
    const previous = sessionEvents[i];
    if (previous.invocationId !== event.invocationId) {
      break;
    }

    const previousPath = previous.nodeInfo?.path;
    if (!previousPath) {
      continue;
    }

    const previousId = toWorkflowNodeId(previousPath);
    if (previousId === nodeId) {
      continue;
    }

    return [[previousId, nodeId]];
  }

  return [[nodeId, '']];
}

function toWorkflowNodeId(path: string): string {
  return path
    .split('.')
    .map((segment) => segment.split('@')[0])
    .join('.');
}

function getNodeName(toolOrAgent: BaseAgent | BaseTool): string {
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
function getNodeCaption(toolOrAgent: BaseAgent | BaseTool): string {
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

  console.warn(`Unsupported tool type: ${typeof toolOrAgent}`);

  return `❓ Unsupported tool type: ${typeof toolOrAgent}`;
}

// TODO: Support BaseRetrievalTool
function getNodeShape(toolOrAgent: BaseAgent | BaseTool): string {
  if (isBaseAgent(toolOrAgent)) {
    return 'ellipse';
  }

  if (isFunctionTool(toolOrAgent)) {
    return 'box';
  }

  if (isBaseTool(toolOrAgent)) {
    return 'box';
  }

  console.warn(`Unsupported tool type: ${typeof toolOrAgent}`);

  return 'cylinder';
}

// TODO: Support BaseRetrievalTool
function shouldBuildAgentCluster(toolOrAgent: BaseAgent | BaseTool): boolean {
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
  rootAgent: RunnableRoot,
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
  rootAgent: RunnableRoot,
  highlightsPairs: Array<[string, string]>,
): Promise<string> {
  const graph = await getAgentGraph(rootAgent, highlightsPairs);

  return toDot(graph);
}
