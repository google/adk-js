/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  LlmAgent,
  MCPToolset,
  type StreamableHTTPConnectionParams,
} from '@google/adk';

import {
  AGENT_DESCRIPTION,
  AGENT_NAME,
  BASE_INSTRUCTION,
  buildToolCallingTurns,
  EXPERIMENTAL_OPT_IN,
  ScriptedModel,
  type TelemetryTestCase,
  TOOL_NAME,
  TOOL_RESULT_PREFIX,
} from '../telemetry_test_utils.js';

export const MCP_TOOL_DESCRIPTION = 'Echoes back its input.';
export const MCP_SERVER_URL = 'https://mcp.example.com/mcp';
export const MCP_SESSION_ID = 'mcp-session-1';
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_AUTHORIZATION = 'Bearer some-secret-token';

export const MCP_TEST_CASES: readonly TelemetryTestCase[] = [
  {
    testId: 'experimental-span-and-event',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'span_and_event',
  },
  {
    testId: 'http-exchange',
    semconvOptIn: EXPERIMENTAL_OPT_IN,
    captureContent: 'span_and_event',
    experimentalTelemetry: true,
    env: {
      ADK_CAPTURE_MCP_HTTP_BODIES: 'true',
      ADK_CAPTURE_MCP_HTTP_EXCHANGE: 'true',
      OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_REQUEST: 'authorization',
      OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_RESPONSE: 'content-type',
    },
  },
];

interface JsonRpcRequestPayload {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: {
    readonly name?: string;
    readonly arguments?: Record<string, unknown>;
  };
}

function createInMemoryMcpFetch(): typeof fetch {
  const responseHeaders = {
    'content-type': 'application/json',
    'mcp-session-id': MCP_SESSION_ID,
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
  };

  return async (
    _input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      return new Response(null, {status: 405});
    }
    if (method === 'DELETE') {
      return new Response(null, {status: 200});
    }

    const rawBody = typeof init?.body === 'string' ? init.body : '{}';
    const rpc = JSON.parse(rawBody) as JsonRpcRequestPayload;

    if (rpc.method === 'initialize') {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id ?? 1,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {tools: {}},
            serverInfo: {name: 'test-mcp-server', version: '1.0.0'},
          },
        }),
        {status: 200, headers: responseHeaders},
      );
    }

    if (rpc.method === 'notifications/initialized') {
      return new Response(null, {status: 202, headers: responseHeaders});
    }

    if (rpc.method === 'tools/list') {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id ?? 2,
          result: {
            tools: [
              {
                name: TOOL_NAME,
                description: MCP_TOOL_DESCRIPTION,
                inputSchema: {
                  type: 'object',
                  properties: {arg1: {type: 'string'}},
                  required: ['arg1'],
                },
              },
            ],
          },
        }),
        {status: 200, headers: responseHeaders},
      );
    }

    if (rpc.method === 'tools/call') {
      const arg1 = String(rpc.params?.arguments?.['arg1'] ?? '');
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id ?? 3,
          result: {
            content: [{type: 'text', text: `${TOOL_RESULT_PREFIX}${arg1}`}],
            isError: false,
          },
        }),
        {status: 200, headers: responseHeaders},
      );
    }

    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id ?? 0,
        result: {},
      }),
      {status: 200, headers: responseHeaders},
    );
  };
}

/**
 * Builds `some_root_agent` equipped with an in-memory HTTP {@link MCPToolset}.
 */
export function createMcpAgent(): LlmAgent {
  const model = new ScriptedModel(buildToolCallingTurns());
  const connectionParams: StreamableHTTPConnectionParams = {
    type: 'StreamableHTTPConnectionParams',
    url: MCP_SERVER_URL,
    header: {Authorization: MCP_AUTHORIZATION},
    terminateOnClose: false,
    transportOptions: {
      fetch: createInMemoryMcpFetch(),
    },
  };
  return new LlmAgent({
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
    tools: [new MCPToolset(connectionParams)],
  });
}
