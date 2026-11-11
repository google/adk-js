/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Local stdio MCP server used by `samples/tools/mcp_tool/agent.ts`.
 *
 * Exposes two tools (`lookup_service_status`, defined as an ADK `FunctionTool`
 * whose declaration schema is converted via `genaiSchemaToJsonSchema`, and
 * `list_incidents`) plus one text resource (`oncall_runbook`) so the sample
 * runs end-to-end without an external service.
 */

import {FunctionTool, genaiSchemaToJsonSchema} from '@google/adk';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';

const SERVICE_STATUS = {
  checkout: {service: 'checkout', status: 'healthy', latencyMs: 42},
  search: {service: 'search', status: 'degraded', latencyMs: 310},
  billing: {service: 'billing', status: 'healthy', latencyMs: 28},
};

const INCIDENTS = [
  {
    id: 'INC-1042',
    service: 'search',
    summary: 'Elevated p99 latency on shard-3.',
  },
];

const ONCALL_RUNBOOK = [
  '# Oncall Runbook',
  '',
  '1. Check service health with `lookup_service_status`.',
  '2. If a service is `degraded`, call `list_incidents` for active incident IDs.',
  '3. Escalate any shard latency incident over 250ms to the storage rotation.',
].join('\n');

const lookupServiceStatusTool = new FunctionTool({
  name: 'lookup_service_status',
  description: 'Returns health status and latency for a named backend service.',
  parameters: z.object({
    service: z
      .enum(['checkout', 'search', 'billing'])
      .describe('Name of the backend service to inspect.'),
  }),
  execute: async ({service}) =>
    SERVICE_STATUS[service] ?? {service, status: 'unknown'},
});

const lookupDeclaration = lookupServiceStatusTool._getDeclaration();
const lookupServiceStatusMcpTool = {
  name: lookupServiceStatusTool.name,
  description: lookupServiceStatusTool.description,
  inputSchema: lookupDeclaration?.parameters
    ? genaiSchemaToJsonSchema(lookupDeclaration.parameters)
    : {type: 'object', properties: {}},
};

const listIncidentsTool = {
  name: 'list_incidents',
  description: 'Lists active production incidents across backend services.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

const server = new Server(
  {name: 'adk-sample-mcp-server', version: '1.0.0'},
  {capabilities: {tools: {}, resources: {}}},
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [lookupServiceStatusMcpTool, listIncidentsTool],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const {name, arguments: args = {}} = request.params;
  if (name === lookupServiceStatusTool.name) {
    const service = String(args.service ?? '');
    const payload = SERVICE_STATUS[service] ?? {service, status: 'unknown'};
    return {
      content: [{type: 'text', text: JSON.stringify(payload)}],
    };
  }
  if (name === listIncidentsTool.name) {
    return {
      content: [{type: 'text', text: JSON.stringify({incidents: INCIDENTS})}],
    };
  }
  return {
    isError: true,
    content: [{type: 'text', text: `Unknown tool: ${name}`}],
  };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      name: 'oncall_runbook',
      uri: 'runbook://oncall/triage',
      mimeType: 'text/markdown',
      description: 'Triage steps for degraded backend services.',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri !== 'runbook://oncall/triage') {
    throw new Error(`Unknown resource URI: ${request.params.uri}`);
  }
  return {
    contents: [
      {
        uri: 'runbook://oncall/triage',
        mimeType: 'text/markdown',
        text: ONCALL_RUNBOOK,
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
