/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseNode,
  DEFAULT_ROUTE,
  RouteValue,
  Workflow,
  Graph as WorkflowGraph,
  isBaseAgent,
  isBaseTool,
  isLlmAgent,
} from '@google/adk';

/**
 * Anything the dev UI's structure graph can sit on: an agent, or a node of a
 * workflow graph. The two are interchangeable at every level — a workflow node
 * can wrap an agent, and an agent can be a workflow — so navigation and
 * serialization both work over the union rather than over `BaseAgent` alone.
 */
export type GraphTarget = BaseAgent | BaseNode;

/** A workflow graph edge, as the dev UI's live workflow view reads it. */
export interface SerializedEdge {
  from_node: SerializedNodeRef;
  to_node: SerializedNodeRef;
  route?: string | string[];
}

/**
 * Edge endpoints are shallow on purpose: the UI reads only `name`/`type` off
 * them, and serializing them in full would repeat every nested subtree once per
 * incident edge.
 */
export interface SerializedNodeRef {
  name: string;
  type: string;
}

/**
 * An agent or node in the form the dev UI consumes. Keys are snake_case to
 * match adk-python's `serialize_agent`, which is the contract the shared
 * adk-web bundle was built against.
 *
 * Runtime Contract "Ask 1" additions (`instruction`, `tools` schema): these
 * are additive fields the dev UI ignores today but that rubric-based eval
 * metrics need to score correctly over HTTP. adk-web is unaffected because
 * new fields are optional.
 */
export interface SerializedAgent {
  name: string;
  type: string;
  description?: string;
  model?: string;
  rerun_on_resume?: boolean;
  /**
   * The agent's system instruction, as delivered to the LLM at definition
   * time. When it's an `InstructionProvider` function (resolved dynamically
   * per turn), emitted as the marker string `"<dynamic>"` — the actual
   * per-call text is available via v1.1 LlmRequest capture instead.
   */
  instruction?: string;
  agent?: SerializedAgent;
  sub_agents?: SerializedAgent[];
  tools?: SerializedTool[];
  graph?: {nodes: SerializedAgent[]; edges: SerializedEdge[]};
}

/**
 * One function tool with its full JSON Schema, as the LLM sees it. Replaces
 * the pre-v1 `SerializedNodeRef` (name-only) shape. Consumers that only need
 * the name continue to work — every SerializedTool is a superset.
 */
export interface SerializedTool {
  /** Tool name — mandatory. Matches `SerializedNodeRef.name` for compat. */
  name: string;
  /** Backward-compat marker so tools sit in the same UI position as before. */
  type?: string;
  description?: string;
  /** JSON Schema of the tool's parameters, if the tool declares one. */
  parameters?: Record<string, unknown>;
}

/** The `build_graph` payload — adk-python's `serialize_app_info`. */
export interface AppInfo {
  name: string;
  root_agent: SerializedAgent;
  readme?: string;
}

const WORKFLOW_START_NODE_NAME = '__START__';

/**
 * Reads a field off a node structurally. The dev server loads the user's agent
 * module, which may resolve its own copy of `@google/adk`, so `instanceof` is
 * not dependable here — the same reason `agent_graph.ts` classifies nodes by
 * shape.
 */
function getField(target: GraphTarget, field: string): unknown {
  return (target as unknown as Record<string, unknown>)[field];
}

function isWorkflowGraph(value: unknown): value is WorkflowGraph {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as WorkflowGraph).nodes) &&
    Array.isArray((value as WorkflowGraph).edges)
  );
}

/**
 * The {@link Workflow} a target is, if it is one — as a root or as a node of an
 * enclosing graph. Mirrors `agent_graph.ts`'s `asWorkflow` so the JSON tree and
 * the DOT agree on what counts as a workflow.
 */
function asWorkflow(target: GraphTarget): Workflow | undefined {
  const isWorkflowShaped =
    isWorkflowGraph(getField(target, 'graph')) ||
    typeof getField(target, 'dynamicEntry') === 'function';

  return isWorkflowShaped ? (target as Workflow) : undefined;
}

/** The agent a node wraps, if it wraps one (e.g. an `LLMAgentWrapper`). */
function wrappedAgent(target: GraphTarget): BaseAgent | undefined {
  const agent = getField(target, 'agent');

  return isBaseAgent(agent) ? agent : undefined;
}

/**
 * Classifies a target for the UI's icon and label switch.
 *
 * Only the vocabulary the UI knows is emitted — `start`, `workflow`, `agent`,
 * `tool`, `join`, `function`. A composite agent (sequential, loop, parallel) is
 * an `agent`: the UI has no glyph of its own for those, and a type it does not
 * recognize draws with no icon at all.
 */
function targetType(target: GraphTarget): string {
  if (target.name === WORKFLOW_START_NODE_NAME) {
    return 'start';
  }
  if (asWorkflow(target)) {
    return 'workflow';
  }
  if (wrappedAgent(target) || isBaseAgent(target)) {
    return 'agent';
  }
  if (isBaseTool(getField(target, 'tool'))) {
    return 'tool';
  }
  if ((target as BaseNode).requiresAllPredecessors) {
    return 'join';
  }

  return 'function';
}

/**
 * The children of a target, in the order the UI resolves a path segment
 * against them (`graph.nodes`, then `sub_agents`).
 *
 * Exported because `build_graph_image` navigates the *live* tree rather than
 * the serialized one — the DOT is produced from real agents and workflows —
 * and both walks have to agree on which names exist at which path.
 */
export function childTargets(target: GraphTarget): GraphTarget[] {
  const workflow = asWorkflow(target);
  if (workflow) {
    return [...(workflow.graph?.nodes ?? [])];
  }

  const agent =
    wrappedAgent(target) ?? (isBaseAgent(target) ? target : undefined);

  return agent ? [...agent.subAgents] : [];
}

function serializeRoute(
  route: RouteValue | RouteValue[] | null | undefined,
): string | string[] | undefined {
  if (route == null) {
    return undefined;
  }

  const labels = (Array.isArray(route) ? route : [route]).map((value) =>
    value === DEFAULT_ROUTE ? 'default' : String(value),
  );

  return labels.length === 1 ? labels[0] : labels;
}

function serializeNodeRef(node: BaseNode): SerializedNodeRef {
  return {name: node.name, type: targetType(node)};
}

function serializeGraph(graph: WorkflowGraph): {
  nodes: SerializedAgent[];
  edges: SerializedEdge[];
} {
  return {
    nodes: graph.nodes.map((node) => serializeAgent(node)),
    edges: graph.edges.map((edge) => {
      const route = serializeRoute(edge.route);

      return {
        from_node: serializeNodeRef(edge.fromNode),
        to_node: serializeNodeRef(edge.toNode),
        ...(route !== undefined ? {route} : {}),
      };
    }),
  };
}

/**
 * Serializes an agent or workflow node into the dev UI's JSON tree.
 *
 * A workflow keeps its structure in `graph.edges`, not in `subAgents` — a naive
 * `sub_agents` walk reports an empty tree for every workflow — so a workflow is
 * emitted under `graph` and everything else under `sub_agents`.
 */
export function serializeAgent(target: GraphTarget): SerializedAgent {
  const type = targetType(target);
  const description = target.description || undefined;
  const serialized: SerializedAgent = {
    name: target.name,
    type,
    ...(description ? {description} : {}),
  };

  if (isLlmAgent(target)) {
    if (typeof target.model === 'string' && target.model) {
      serialized.model = target.model;
    }

    // Instruction: emit the string form directly; for the `InstructionProvider`
    // function form (resolved dynamically per turn) emit a `"<dynamic>"`
    // marker — the actual per-call text is available via v1.1 LlmRequest
    // capture. Empty string is treated the same as no instruction.
    const instruction = (target as {instruction?: unknown}).instruction;
    if (typeof instruction === 'string' && instruction) {
      serialized.instruction = instruction;
    } else if (typeof instruction === 'function') {
      serialized.instruction = '<dynamic>';
    }

    // `tools`, not `canonicalTools()`: the async form resolves toolsets by
    // calling out to their providers, which a structure request should not do.
    // A toolset therefore contributes nothing here — it has no name until it is
    // resolved into the tools it holds.
    const tools: SerializedTool[] = [];
    for (const tool of target.tools) {
      const name = (tool as {name?: unknown})?.name;
      if (typeof name !== 'string' || !name) {
        continue;
      }

      const serializedTool: SerializedTool = {name, type: 'tool'};

      const description = (tool as {description?: unknown}).description;
      if (typeof description === 'string' && description) {
        serializedTool.description = description;
      }

      // `_getDeclaration()` is the same call the LLM request processor makes
      // to hand tools to the model, so what we serialize here is exactly what
      // the LLM sees — the point of Ask 1. A tool that declines to declare
      // (returns undefined) shows up as name-only, matching pre-Ask-1
      // behaviour for that tool.
      const getDeclaration = (
        tool as {_getDeclaration?: () => {parameters?: unknown} | undefined}
      )._getDeclaration;
      if (typeof getDeclaration === 'function') {
        try {
          const declaration = getDeclaration.call(tool);
          const parameters = declaration?.parameters;
          if (parameters && typeof parameters === 'object') {
            serializedTool.parameters = parameters as Record<string, unknown>;
          }
        } catch {
          // A misbehaving tool should not break structure serialization —
          // fall back to name/description only.
        }
      }

      tools.push(serializedTool);
    }
    if (tools.length) {
      serialized.tools = tools;
    }
  }

  const rerunOnResume = getField(target, 'rerunOnResume');
  if (typeof rerunOnResume === 'boolean') {
    serialized.rerun_on_resume = rerunOnResume;
  }

  const workflow = asWorkflow(target);
  if (workflow) {
    // A dynamic workflow (`dynamicEntry`) has no static graph to expand, so it
    // is left as a leaf rather than given an empty `graph` the UI would offer
    // as navigable.
    if (workflow.graph) {
      serialized.graph = serializeGraph(workflow.graph);
    }

    return serialized;
  }

  const agent = wrappedAgent(target);
  if (agent) {
    serialized.agent = serializeAgent(agent);
  }

  const subAgents = (agent ?? (isBaseAgent(target) ? target : undefined))
    ?.subAgents;
  if (subAgents?.length) {
    serialized.sub_agents = subAgents.map((sub) => serializeAgent(sub));
  }

  return serialized;
}

/** Builds the `build_graph` payload for an app. */
export function serializeAppInfo(
  name: string,
  root: GraphTarget,
  readme?: string,
): AppInfo {
  return {
    name,
    root_agent: serializeAgent(root),
    ...(readme ? {readme} : {}),
  };
}

/**
 * Resolves a `parent/child/grandchild` path against the live tree.
 *
 * Paths the UI sends are relative to the root agent and exclude its name, but a
 * leading root name is tolerated because the UI builds some paths from
 * breadcrumbs that include it — the same allowance adk-python's
 * `_navigate_to_node` makes.
 */
export function navigateToNode(
  root: GraphTarget,
  nodePath: string,
): GraphTarget | undefined {
  const parts = nodePath.split('/').filter((part) => part !== '');
  let current: GraphTarget = root;

  const startIndex = parts[0] === root.name ? 1 : 0;
  for (const part of parts.slice(startIndex)) {
    const child = childTargets(current).find((candidate) => {
      const agent = wrappedAgent(candidate);

      return candidate.name === part || agent?.name === part;
    });

    if (!child) {
      return undefined;
    }

    current = child;
  }

  return current;
}

/**
 * Every workflow at or below `root`, keyed by its path relative to `basePath`.
 *
 * The dev UI preloads one DOT per level in a single request and then renders
 * whichever level the user has navigated to, so only targets that own a graph
 * are worth an entry; plain agent trees are drawn whole at their root.
 */
export function collectSubWorkflows(
  root: GraphTarget,
  basePath = '',
): Map<string, GraphTarget> {
  const workflows = new Map<string, GraphTarget>();

  const visit = (target: GraphTarget, path: string) => {
    if (asWorkflow(target)?.graph) {
      workflows.set(path, target);
    }

    for (const child of childTargets(target)) {
      if (child.name === WORKFLOW_START_NODE_NAME) {
        continue;
      }

      visit(child, path ? `${path}/${child.name}` : child.name);
    }
  };

  visit(root, basePath);

  return workflows;
}
