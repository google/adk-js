/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP tool: toolset discovery, filtered sub-agent tools, and server resources
 * ../../../docs/guides/tools/mcp_tool/index.md
 *
 * `MCPToolset` connects to a Model Context Protocol server, discovers the tools
 * it advertises, and wraps each one in an `MCPTool`. This sample runs against
 * `mcp_server.mjs` in the same directory over stdio by default, against a
 * Streamable HTTP MCP server when `MCP_STREAMABLE_HTTP_URL` is set, or against
 * an HTTP+SSE MCP server when `MCP_SSE_URL` is set:
 *
 *   - `mcp_server.mjs` defines an ADK `FunctionTool` (`lookup_service_status`)
 *     and converts its declaration parameters with `genaiSchemaToJsonSchema`,
 *     alongside a `list_incidents` tool and an `oncall_runbook` resource.
 *   - `tools: [mcpToolset, loadMcpResource]` gives `rootAgent` every tool on the
 *     server plus `LoadMcpResourceTool` to read `oncall_runbook` into the prompt.
 *   - `statusToolset` applies `prefix: 'ops'` and `toolFilter:
 *     ['ops_lookup_service_status']` so `status_agent` can call only the prefixed
 *     status tool.
 *
 * When combining `prefix` with a string-array `toolFilter`, the filter matches
 * the prefixed name (`ops_lookup_service_status`) because `MCPToolset` applies
 * `prefix` before filtering.
 *
 * REQUIRES an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/tools/mcp_tool/agent.ts
 * Try "is the search service healthy, and what does the oncall runbook say to do?".
 */

import {
  LlmAgent,
  LoadMcpResourceTool,
  MCPToolset,
  type MCPConnectionParams,
  type SseConnectionParams,
  type StdioConnectionParams,
  type StreamableHTTPConnectionParams,
} from '@google/adk';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const SERVER_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  'mcp_server.mjs',
);

const stdioParams: StdioConnectionParams = {
  type: 'StdioConnectionParams',
  serverParams: {
    command: process.execPath,
    args: [SERVER_SCRIPT],
  },
};

const streamableHttpParams: StreamableHTTPConnectionParams | undefined = process
  .env.MCP_STREAMABLE_HTTP_URL
  ? {
      type: 'StreamableHTTPConnectionParams',
      url: process.env.MCP_STREAMABLE_HTTP_URL,
      headers: process.env.MCP_STREAMABLE_HTTP_TOKEN
        ? {Authorization: `Bearer ${process.env.MCP_STREAMABLE_HTTP_TOKEN}`}
        : undefined,
    }
  : undefined;

const sseParams: SseConnectionParams | undefined = process.env.MCP_SSE_URL
  ? {
      type: 'SseConnectionParams',
      url: process.env.MCP_SSE_URL,
      headers: process.env.MCP_SSE_TOKEN
        ? {Authorization: `Bearer ${process.env.MCP_SSE_TOKEN}`}
        : undefined,
    }
  : undefined;

const connectionParams: MCPConnectionParams =
  streamableHttpParams ?? sseParams ?? stdioParams;

const mcpToolset = new MCPToolset(connectionParams);
const loadMcpResource = new LoadMcpResourceTool(mcpToolset);

/**
 * A second toolset over the same transport, restricted to the status tool under
 * the `ops_` namespace.
 */
const statusToolset = new MCPToolset(
  connectionParams,
  ['ops_lookup_service_status'],
  'ops',
);

const statusAgent = new LlmAgent({
  name: 'status_agent',
  model: 'gemini-flash-latest',
  description:
    'Checks whether a single backend service (checkout, search, or billing) is healthy.',
  instruction:
    'Always call ops_lookup_service_status for the requested service and report its status and latency.',
  tools: [statusToolset],
});

export const rootAgent = new LlmAgent({
  name: 'mcp_oncall_agent',
  model: 'gemini-flash-latest',
  description:
    'Triages backend services using MCP tools and the MCP oncall runbook resource.',
  instruction:
    'Use lookup_service_status and list_incidents to inspect backend services ' +
    'and active incidents, or transfer single-service health checks to ' +
    'status_agent. When the user asks about triage steps or the runbook, call ' +
    'load_mcp_resource to read oncall_runbook before answering.',
  tools: [mcpToolset, loadMcpResource],
  subAgents: [statusAgent],
});
