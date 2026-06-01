/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentRegistry,
  AgentRegistrySingleMCPToolset,
  Event,
  GCP_MCP_SERVER_DESTINATION_ID,
  LlmAgent,
  ReadonlyContext,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  createRunner,
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

// Mock google-auth-library
vi.mock('google-auth-library', () => {
  return {
    GoogleAuth: vi.fn().mockImplementation(() => {
      return {
        getClient: vi.fn().mockResolvedValue({
          getRequestHeaders: vi.fn().mockResolvedValue({
            'Authorization': 'Bearer fake-token',
          }),
          quotaProjectId: 'quota-project-123',
        }),
        quotaProjectId: 'quota-project-123',
      };
    }),
  };
});

const mockMcpClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  listTools: vi.fn().mockResolvedValue({
    tools: [
      {
        name: 'retrieve_billing_data',
        description: 'Retrieves GCP billing info',
        inputSchema: {type: 'object', properties: {}},
      },
    ],
  }),
};

// Mock MCP Client
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn().mockImplementation(() => mockMcpClient),
  };
});

describe('AgentRegistry Integration E2E', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
    registry = new AgentRegistry({
      projectId: 'gcp-integration-project',
      location: 'us-central1',
    });
  });

  it('performs a complete Agent Registry tool loading and execution workflow inside LlmAgent', async () => {
    const serverDetails = {
      displayName: 'Billing_Server',
      mcpServerId: 'urn:mcp:gcp:billing-server',
      interfaces: [
        {
          url: 'https://billing-mcp.googleapis.com/v1',
          protocolBinding: 'JSONRPC',
        },
      ],
    };

    // 1. Stub the REST fetch responses from Google Cloud Agent Registry API
    (
      global.fetch as unknown as {
        mockImplementation: (impl: (url: string) => Promise<unknown>) => void;
      }
    ).mockImplementation(async (url: string) => {
      if (url.includes('mcpServers/billing')) {
        return {
          ok: true,
          json: async () => serverDetails,
        };
      }
      if (url.includes('bindings')) {
        return {
          ok: true,
          json: async () => ({
            bindings: [
              {
                target: {identifier: 'urn:mcp:gcp:billing-server'},
                authProviderBinding: {
                  authProvider: 'projects/p/locations/l/authProviders/ap-1',
                },
              },
            ],
          }),
        };
      }
      return {ok: false, status: 404};
    });

    // 2. Resolve the MCP Toolset from registry dynamically
    const toolset = await registry.getMcpToolset('mcpServers/billing');
    expect(toolset).toBeInstanceOf(AgentRegistrySingleMCPToolset);
    expect(toolset.prefix).toBe('Billing_Server');
    expect(toolset.destinationResourceId).toBe('urn:mcp:gcp:billing-server');

    // 3. Retrieve tool wrappers and verify they have the telemetry destination key attached
    const context = {} as ReadonlyContext;
    const tools = await toolset.getTools(context);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('Billing_Server_retrieve_billing_data');

    const toolWrapper = tools[0] as unknown as {
      customMetadata: Record<string, unknown>;
    };
    expect(toolWrapper.customMetadata).toBeDefined();
    expect(toolWrapper.customMetadata[GCP_MCP_SERVER_DESTINATION_ID]).toBe(
      'urn:mcp:gcp:billing-server',
    );

    // 4. Integrate resolved tools into LlmAgent and construct a runner to execute
    const mockLlmResponses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              parts: [{text: 'Retrieved GCP billing info: $0.00'}],
              role: 'model',
            },
          },
        ],
      },
    ];

    const mockLlmModel = new GeminiWithMockResponses(mockLlmResponses);

    const agent = new LlmAgent({
      model: mockLlmModel,
      name: 'billingAssistant',
      description: 'Assistant with registry-loaded billing tools',
      instruction: 'Use Billing_Server tools to answer user queries',
      tools: [toolset],
    });

    const {run} = await createRunner(agent);

    // 5. Execute the integrated workflow session
    const events: Event[] = [];
    for await (const event of run('Check my billing status')) {
      events.push(event);
    }

    // Verify the flow executed and terminated cleanly
    expect(events.length).toBeGreaterThan(0);
    const finalEvent = events[events.length - 1];
    expect(finalEvent.content?.parts?.[0]?.text).toBe(
      'Retrieved GCP billing info: $0.00',
    );
  });
});
