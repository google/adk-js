/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type BaseTool,
  isAgentTool,
  isFunctionTool,
  isToolboxTool,
  ListSkillsTool,
  LoadSkillResourceTool,
  LoadSkillTool,
  MCPTool,
  RemoteA2AAgent,
  RunSkillInlineScriptTool,
  RunSkillScriptTool,
  SearchSkillsTool,
  WebMCPTool,
} from '@google/adk';
import {isRecord, read} from './content_parser.js';
import {
  CIRCULAR_REFERENCE,
  MAX_DEPTH_EXCEEDED,
  MAX_SANITIZE_DEPTH,
  recursiveSmartTruncate,
  safeGet,
} from './sanitize.js';
import {camelToSnake} from './snake_case.js';
import {type JsonObject, type JsonValue} from './types.js';

const TRANSFER_TO_AGENT_TOOL_NAME = 'transfer_to_agent';

function isRemoteAgent(agent: unknown): boolean {
  return agent instanceof RemoteA2AAgent;
}

/**
 * The part of a tool context transfer classification reads; ADK's `Context`
 * satisfies it.
 */
export interface ToolOriginContext {
  readonly invocationContext: {readonly agent: unknown};
}

function subAgentsOf(agent: unknown): Array<unknown> {
  const subAgents = read(agent, 'subAgents');
  return Array.isArray(subAgents) ? subAgents : [];
}

/**
 * Port of `_find_transfer_target`: searches sub-agents, the parent, then peers.
 */
function findTransferTarget({
  agent,
  agentName,
}: {
  agent: unknown;
  agentName: string;
}) {
  const sub = subAgentsOf(agent).find(
    (candidate) => read(candidate, 'name') === agentName,
  );
  if (sub !== undefined) {
    return sub;
  }
  const parent = read(agent, 'parentAgent');
  if (parent === undefined || parent === null) {
    return null;
  }
  if (read(parent, 'name') === agentName) {
    return parent;
  }
  const ownName = read(agent, 'name');
  return (
    subAgentsOf(parent).find(
      (peer) =>
        read(peer, 'name') === agentName && read(peer, 'name') !== ownName,
    ) ?? null
  );
}

// The tools SkillToolset itself provides; tools an application adds to a
// toolset keep their own origin.
const SKILL_TOOL_TYPES = [
  ListSkillsTool,
  LoadSkillResourceTool,
  LoadSkillTool,
  RunSkillInlineScriptTool,
  RunSkillScriptTool,
  SearchSkillsTool,
];

/**
 * Port of `_get_tool_origin`: LOCAL, MCP, A2A, SUB_AGENT, TRANSFER_AGENT,
 * TRANSFER_A2A, TOOLBOX, SKILL or UNKNOWN. A transfer is classified per call
 * from the selected `agent_name`.
 */
export function getToolOrigin({
  tool,
  toolArgs,
  toolContext,
}: {
  tool: BaseTool;
  toolArgs?: Record<string, unknown>;
  toolContext?: ToolOriginContext;
}): string {
  if (tool instanceof MCPTool || tool instanceof WebMCPTool) {
    return 'MCP';
  }
  // ADK TS has no TransferToAgentTool class: transfers are a FunctionTool
  // named transfer_to_agent, the name of Python's TransferToAgentTool.
  if (isFunctionTool(tool) && tool.name === TRANSFER_TO_AGENT_TOOL_NAME) {
    const agentName = toolArgs?.['agent_name'];
    if (
      toolContext !== undefined &&
      typeof agentName === 'string' &&
      agentName !== ''
    ) {
      const target = findTransferTarget({
        agent: toolContext.invocationContext.agent,
        agentName,
      });
      if (isRemoteAgent(target)) {
        return 'TRANSFER_A2A';
      }
    }
    return 'TRANSFER_AGENT';
  }
  if (isAgentTool(tool)) {
    // AgentTool keeps its agent in a TypeScript-private field, which is an
    // ordinary property at runtime.
    return isRemoteAgent(safeGet(tool, 'agent')) ? 'A2A' : 'SUB_AGENT';
  }
  if (isToolboxTool(tool)) {
    return 'TOOLBOX';
  }
  if (isFunctionTool(tool)) {
    return 'LOCAL';
  }
  if (SKILL_TOOL_TYPES.some((type) => tool instanceof type)) {
    return 'SKILL';
  }
  return 'UNKNOWN';
}

// Values under these Schema fields are user data (property names, literals), so
// their keys keep their spelling.
export const SCHEMA_VERBATIM_FIELDS: ReadonlySet<string> = new Set([
  'default',
  'example',
  'enum',
  'required',
  'propertyOrdering',
]);

/**
 * A genai `Schema` as Python's `model_dump(exclude_none=True, mode="json")`
 * writes it. A self-referencing or over-deep schema ends in a sentinel.
 */
function schemaToJson(
  schema: unknown,
  inProgress: Set<object> = new Set(),
  depth = 0,
): JsonValue {
  if (typeof schema === 'object' && schema !== null) {
    if (inProgress.has(schema)) {
      return CIRCULAR_REFERENCE;
    }
    if (depth >= MAX_SANITIZE_DEPTH) {
      return MAX_DEPTH_EXCEEDED;
    }
  }
  if (Array.isArray(schema)) {
    inProgress.add(schema);
    try {
      return schema.map((item) => schemaToJson(item, inProgress, depth + 1));
    } finally {
      inProgress.delete(schema);
    }
  }
  if (!isRecord(schema)) {
    return recursiveSmartTruncate({value: schema, maxLen: -1}).value;
  }
  inProgress.add(schema);
  try {
    const entries = Object.entries(schema).flatMap(
      ([key, value]): Array<[string, JsonValue]> => {
        if (value === undefined || value === null) {
          return [];
        }
        if (key === 'properties' && isRecord(value)) {
          return [
            [
              key,
              Object.fromEntries(
                Object.entries(value).map(([name, property]) => [
                  name,
                  schemaToJson(property, inProgress, depth + 2),
                ]),
              ),
            ],
          ];
        }
        if (SCHEMA_VERBATIM_FIELDS.has(key)) {
          return [
            [
              camelToSnake(key),
              recursiveSmartTruncate({value, maxLen: -1}).value,
            ],
          ];
        }
        return [
          [camelToSnake(key), schemaToJson(value, inProgress, depth + 1)],
        ];
      },
    );
    return Object.fromEntries(entries);
  } finally {
    inProgress.delete(schema);
  }
}

function declarationEntry(name: string, tool: BaseTool): JsonObject {
  const entry: JsonObject = {name: tool.name || name};
  if (tool.description) {
    entry.description = tool.description;
  }
  let declaration: ReturnType<BaseTool['_getDeclaration']>;
  try {
    declaration = tool._getDeclaration();
  } catch {
    return entry;
  }
  if (declaration === undefined) {
    return entry;
  }
  if (entry.description === undefined && declaration.description) {
    entry.description = declaration.description;
  }
  // MCP, OpenAPI and skill tools populate only the raw JSON schema, which model
  // adapters prefer too.
  if (
    declaration.parametersJsonSchema !== undefined &&
    declaration.parametersJsonSchema !== null
  ) {
    entry.parameters = recursiveSmartTruncate({
      value: declaration.parametersJsonSchema,
      maxLen: -1,
    }).value;
    return entry;
  }
  if (declaration.parameters !== undefined) {
    try {
      entry.parameters = schemaToJson(declaration.parameters);
    } catch {
      // An unserializable schema leaves parameters off rather than dropping the
      // tool.
    }
  }
  return entry;
}

/**
 * Port of `_extract_tool_declarations`: name, description and parameter schema
 * per tool, best-effort per tool.
 */
export function extractToolDeclarations(
  tools: Readonly<Record<string, BaseTool>>,
): Array<JsonObject> {
  return Object.entries(tools).map(([name, tool]) =>
    declarationEntry(name, tool),
  );
}
