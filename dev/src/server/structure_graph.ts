/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Color, Digraph, Edge, Node, toDot} from 'ts-graphviz';

import {SerializedAgent, SerializedEdge} from './app_info.js';

/**
 * Renders ONE level of an app's structure, for the dev UI's graph tab.
 *
 * This is deliberately not `agent_graph.ts`, which draws the whole tree with
 * nested workflows as recursive clusters — the right picture for the per-event
 * graph, where the point is to highlight a path through everything at once.
 * The graph tab instead shows a single level and lets the user click into a
 * sub-workflow, so a sub-workflow has to be one node here rather than an
 * expanded cluster. adk-python splits the same two jobs across `agent_graph.py`
 * and `graph_visualization.py`; this mirrors the latter.
 *
 * The node ids matter: the UI binds its click handler to `g.node` elements and
 * matches each one's `<title>` against a bare child name, so nodes are keyed by
 * name — a qualified `parent.child` id would render but never be clickable.
 */

const START_NODE_NAME = '__START__';
const END_NODE_NAME = '__END__';

interface Palette {
  background: Color;
  nodeFill: Color;
  nodeBorder: Color;
  nodeText: Color;
  edge: Color;
  edgeText: Color;
  startFill: Color;
  startBorder: Color;
  endFill: Color;
  endBorder: Color;
}

const DARK_PALETTE: Palette = {
  background: '#0F172A',
  nodeFill: '#1E293B',
  nodeBorder: '#475569',
  nodeText: '#F8FAFC',
  edge: '#94A3B8',
  edgeText: '#CBD5E1',
  startFill: '#059669',
  startBorder: '#047857',
  endFill: '#DC2626',
  endBorder: '#B91C1C',
};

const LIGHT_PALETTE: Palette = {
  background: '#F8FAFC',
  nodeFill: '#FFFFFF',
  nodeBorder: '#94A3B8',
  nodeText: '#0F172A',
  edge: '#64748B',
  edgeText: '#475569',
  startFill: '#10B981',
  startBorder: '#059669',
  endFill: '#EF4444',
  endBorder: '#DC2626',
};

/** Glyph and accent per node type, matching the legend the dev UI draws. */
const ICONS: Record<string, {icon: string; color: string}> = {
  agent: {icon: '✦', color: '#42A5F5'},
  workflow: {icon: '⊷', color: '#9333EA'},
  function: {icon: 'ƒ', color: '#10B981'},
  join: {icon: '⌵', color: '#F59E0B'},
  tool: {icon: '🔧', color: '#6B7280'},
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A tool edge is synthesized here, so it is marked rather than serialized. */
interface LevelEdge extends SerializedEdge {
  isToolEdge?: boolean;
}

/**
 * Flattens a plain agent tree into nodes and edges. A level that owns no
 * workflow graph — an `LlmAgent` and its sub-agents — has no `graph` to draw,
 * so its hierarchy becomes the graph.
 */
function agentTreeAsGraph(level: SerializedAgent): {
  nodes: SerializedAgent[];
  edges: LevelEdge[];
} {
  // A dynamic workflow reaches here too: it builds its nodes as it runs, so it
  // has no static graph and stands alone as a single node of its own type.
  const nodes: SerializedAgent[] = [
    {name: level.name, type: level.type || 'agent', tools: level.tools},
  ];
  const edges: LevelEdge[] = [];

  const walk = (agent: SerializedAgent, parentName: string) => {
    for (const sub of agent.sub_agents ?? []) {
      if (!sub.name) {
        continue;
      }

      nodes.push({name: sub.name, type: sub.type || 'agent', tools: sub.tools});
      edges.push({
        from_node: {name: parentName, type: 'agent'},
        to_node: {name: sub.name, type: sub.type || 'agent'},
      });
      walk(sub, sub.name);
    }
  };

  walk(level, level.name);

  return {nodes, edges};
}

/** Adds one node per tool, plus a dashed edge from its owner. */
function injectTools(nodes: SerializedAgent[], edges: LevelEdge[]) {
  const toolNodes = new Map<string, SerializedAgent>();

  for (const node of nodes) {
    if (!node.name || node.name === START_NODE_NAME) {
      continue;
    }

    for (const tool of node.tools ?? []) {
      if (!tool.name) {
        continue;
      }

      if (!toolNodes.has(tool.name)) {
        toolNodes.set(tool.name, {name: tool.name, type: tool.type || 'tool'});
      }

      edges.push({
        from_node: {name: node.name, type: node.type},
        to_node: {name: tool.name, type: tool.type || 'tool'},
        isToolEdge: true,
      });
    }
  }

  for (const tool of toolNodes.values()) {
    if (!nodes.some((node) => node.name === tool.name)) {
      nodes.push(tool);
    }
  }
}

function nodeLabel(name: string, type: string, noDefault: boolean): string {
  const iconData = ICONS[type];
  if (!iconData) {
    return name;
  }

  const {icon, color} = iconData;
  const label =
    `<FONT COLOR="${color}" POINT-SIZE="14">${icon}</FONT> ` + escapeHtml(name);

  // A router with no fallback route silently drops every input that matches
  // none of its branches, so the drawn node says so.
  return noDefault
    ? `<${label}<br/><br/><FONT POINT-SIZE="10">⚠️ [NO DEFAULT]</FONT>>`
    : `<${label}>`;
}

/**
 * Renders a level to DOT.
 *
 * @param level The agent or workflow to draw, as serialized by `app_info`.
 * @param darkMode Whether to draw with the dark palette.
 */
export function renderStructureGraphAsDot(
  level: SerializedAgent,
  darkMode = false,
): string {
  const palette = darkMode ? DARK_PALETTE : LIGHT_PALETTE;
  const isWorkflow = !!level.graph;
  const {nodes, edges} = isWorkflow
    ? {
        nodes: [...(level.graph?.nodes ?? [])],
        edges: [...(level.graph?.edges ?? [])] as LevelEdge[],
      }
    : agentTreeAsGraph(level);

  injectTools(nodes, edges);

  const dot = new Digraph(level.name, {
    bgcolor: palette.background,
    pad: 0.5,
    nodesep: 0.5,
    ranksep: 0.8,
    fontname: 'Helvetica',
    splines: 'spline',
  });

  dot.attributes.node.apply({
    shape: 'rect',
    style: 'rounded,filled',
    fillcolor: palette.nodeFill,
    color: palette.nodeBorder,
    penwidth: 1.5,
    fontname: 'Helvetica',
    fontcolor: palette.nodeText,
    fontsize: 12,
    margin: '0.25,0.15',
  });

  dot.attributes.edge.apply({
    color: palette.edge,
    penwidth: 1.2,
    fontname: 'Helvetica',
    fontcolor: palette.edgeText,
    fontsize: 10,
    arrowhead: 'vee',
    arrowsize: 0.7,
  });

  const flowEdges = edges.filter((edge) => !edge.isToolEdge);

  for (const node of nodes) {
    const name = node.name;
    // START is drawn from the edge that leaves it, so it keeps its own style.
    if (!name || name === START_NODE_NAME) {
      continue;
    }

    const outgoing = flowEdges.filter((edge) => edge.from_node?.name === name);
    const isConditional = outgoing.some((edge) => !!edge.route);
    const hasDefault = outgoing.some(
      (edge) => !edge.route || edge.route === 'default',
    );
    const type = node.type || 'node';
    const label = nodeLabel(name, type, isConditional && !hasDefault);
    const tooltip = type.charAt(0).toUpperCase() + type.slice(1);

    if (isConditional) {
      dot.addNode(
        new Node(name, {
          label,
          tooltip,
          shape: 'diamond',
          style: 'filled',
          height: 1.2,
          width: 0.8,
          margin: '0.0,0.0',
        }),
      );
    } else if (type === 'join') {
      dot.addNode(
        new Node(name, {
          label,
          tooltip,
          shape: 'oval',
          style: 'filled',
          margin: '0.05,0.05',
        }),
      );
    } else if (type === 'tool') {
      dot.addNode(
        new Node(name, {label, tooltip, style: 'rounded,filled,dashed'}),
      );
    } else {
      dot.addNode(new Node(name, {label, tooltip, style: 'rounded,filled'}));
    }
  }

  let startDrawn = false;
  for (const edge of edges) {
    const from = edge.from_node?.name;
    const to = edge.to_node?.name;
    if (!from || !to) {
      continue;
    }

    if (from === START_NODE_NAME && !startDrawn) {
      startDrawn = true;
      dot.addNode(
        new Node(START_NODE_NAME, {
          label: 'START',
          shape: 'oval',
          style: 'filled',
          fillcolor: palette.startFill,
          color: palette.startBorder,
          fontcolor: palette.nodeText,
          fontname: 'Helvetica-Bold',
          width: 0.9,
          fixedsize: true,
        }),
      );
    }

    if (edge.isToolEdge) {
      dot.addEdge(
        new Edge([new Node(from), new Node(to)], {
          style: 'dashed',
          color: palette.edge,
        }),
      );

      continue;
    }

    const route = Array.isArray(edge.route)
      ? edge.route.join(', ')
      : edge.route;
    dot.addEdge(
      new Edge([new Node(from), new Node(to)], {
        ...(route ? {label: `  ${route}`} : {}),
      }),
    );
  }

  // A workflow's terminal nodes are joined to an END marker so the exits of a
  // branching graph are visible; an agent tree has no such notion.
  const terminals = nodes
    .map((node) => node.name)
    .filter(
      (name) =>
        !!name &&
        name !== START_NODE_NAME &&
        name !== END_NODE_NAME &&
        nodes.find((node) => node.name === name)?.type !== 'tool' &&
        !flowEdges.some((edge) => edge.from_node?.name === name),
    );

  if (isWorkflow && terminals.length) {
    dot.addNode(
      new Node(END_NODE_NAME, {
        label: 'END',
        shape: 'oval',
        style: 'filled',
        fillcolor: palette.endFill,
        color: palette.endBorder,
        fontcolor: palette.nodeText,
        fontname: 'Helvetica-Bold',
        width: 0.9,
        fixedsize: true,
      }),
    );

    for (const terminal of terminals) {
      dot.addEdge(new Edge([new Node(terminal), new Node(END_NODE_NAME)]));
    }
  }

  return toDot(dot);
}
