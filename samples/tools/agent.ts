/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tools (`FunctionTool`, `AuthenticatedFunctionTool`, `BaseAuthenticatedTool`, `LongRunningFunctionTool`, `GoogleTool`, `BaseGoogleCredentialsConfig`, `BaseToolset`, `SetModelResponseTool`, `AgentTool`, `ExitLoopTool`, `CrewaiTool`, `LangchainTool`, `ToolboxToolset`, and `ToolContext`)
 * ../../docs/guides/tools/index.md
 *
 * A deterministic `BaseAgent` that exercises the `tools` subsystem end-to-end:
 * - `FunctionTool` with a `response` schema and bidirectional live streaming via
 *   `_callLive` with an `AsyncQueue` registered on `ctx.activeStreamingTools`
 * - `AuthenticatedFunctionTool` and `BaseAuthenticatedTool` resolving
 *   `AuthCredential` values through `CredentialManager`
 * - `LongRunningFunctionTool` with `isLongRunning: true`
 * - `GoogleTool` with `BaseGoogleCredentialsConfig` (`externalAccessTokenKey`)
 *   and `toolSettings`, stripping `credentials` and `settings` from declarations
 * - `BaseToolset` with `toolNamePrefix`, `getToolsWithPrefix()`, and default `close()`
 * - `SetModelResponseTool` validating structured output alongside tools with
 *   retry feedback and `EventActions.setModelResponse`
 * - `AgentTool` wrapping a child `LlmAgent` configured with `inputSchema` and
 *   `outputSchema` (removing nullish fields on both input and output)
 * - `ExitLoopTool` (`EXIT_LOOP`) setting `escalate` and `skipSummarization`
 * - `CrewaiTool`, `LangchainTool`, and `ToolboxToolset` ecosystem adapters
 * - `ToolContext` state updates and session-bound `ctx.artifactService`
 *   persistence recorded in `EventActions.artifactDelta`
 *
 * This sample exports `rootAgent` for `adk web` and `npm run sample`, and also
 * includes a direct `InMemoryRunner` driver (`main()`) because the CLI only
 * prints conversational text — running directly lets `main()` inspect the
 * structured `functionCalls`, `functionResponses`, `artifactDelta`, and
 * declaration schemas emitted across the tool invocations.
 *
 * Run (offline, no API key):
 *   npx tsx samples/tools/agent.ts
 *   npm run sample -- samples/tools/agent.ts
 */

import {
  ActiveStreamingTool,
  AgentTool,
  AuthCredentialTypes,
  AuthenticatedFunctionTool,
  AuthSchemeType,
  BaseAgent,
  BaseAuthenticatedTool,
  BaseGoogleCredentialsConfig,
  BaseLlm,
  BaseLlmConnection,
  BaseTool,
  BaseToolset,
  Context,
  createEvent,
  createEventActions,
  createSession,
  Event,
  EXIT_LOOP,
  FunctionTool,
  getFunctionCalls,
  getFunctionResponses,
  GoogleTool,
  InMemoryRunner,
  InvocationContext,
  isFinalResponse,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  LongRunningFunctionTool,
  PluginManager,
  RunAsyncAuthenticatedToolRequest,
  SET_MODEL_RESPONSE_TOOL_NAME,
  SetModelResponseTool,
  stringifyContent,
  ToolboxToolset,
  ToolContext,
} from '@google/adk';
import {CrewaiTool, LangchainTool} from '@google/adk-integrations';
import {FunctionDeclaration, Type} from '@google/genai';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';

const TOOLS_DIGEST_FILENAME = 'tools_execution_digest.json';

class OfflineQuoteLlm extends BaseLlm {
  constructor() {
    super({model: 'offline-quote-llm'});
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const promptText =
      llmRequest.contents
        .flatMap((content) => content.parts ?? [])
        .map((part) => part.text ?? '')
        .join(' ') || '{}';
    const parsed = JSON.parse(promptText) as {
      sku: string;
      quantity: number;
      coupon?: string;
    };
    yield {
      content: {
        role: 'model',
        parts: [
          {
            text: JSON.stringify({
              sku: parsed.sku,
              totalUsd: parsed.quantity * 25,
              appliedCoupon: parsed.coupon ?? null,
            }),
          },
        ],
      },
    };
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('Live connection is not used in OfflineQuoteLlm.');
  }
}

class OfflineStructuredRetryLlm extends BaseLlm {
  private turn = 0;

  constructor() {
    super({model: 'offline-structured-retry-llm'});
  }

  override async *generateContentAsync(): AsyncGenerator<
    LlmResponse,
    void,
    void
  > {
    this.turn += 1;
    if (this.turn === 1) {
      yield {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-structured-invalid',
                name: SET_MODEL_RESPONSE_TOOL_NAME,
                args: {sku: 'ADK-PRO-100', approvedCount: -1},
              },
            },
          ],
        },
      };
      return;
    }
    yield {
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call-structured-valid',
              name: SET_MODEL_RESPONSE_TOOL_NAME,
              args: {sku: 'ADK-PRO-100', approvedCount: 4, note: null},
            },
          },
        ],
      },
    };
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error(
      'Live connection is not used in OfflineStructuredRetryLlm.',
    );
  }
}

const convertCurrencyTool = new FunctionTool({
  name: 'convert_currency',
  description: 'Converts USD to EUR with an explicit response schema.',
  parameters: z.object({
    amountUsd: z.number(),
  }),
  response: {
    type: Type.OBJECT,
    properties: {
      amountEur: {type: Type.NUMBER},
      currency: {type: Type.STRING},
    },
    required: ['amountEur', 'currency'],
  },
  customMetadata: {
    domain: 'billing',
    version: '1.0',
  },
  execute: async ({amountUsd}, toolContext?: ToolContext) => {
    const amountEur = Number((amountUsd * 0.92).toFixed(2));
    toolContext?.state.set('lastConvertedEur', amountEur);
    return {amountEur, currency: 'EUR'};
  },
});

const streamMetricsTool = new FunctionTool({
  name: 'stream_metrics',
  description:
    'Streams running totals from a live LiveRequestQueue inputStream.',
  parameters: z.object({
    metricName: z.string(),
  }),
  execute: async function* (args: Record<string, unknown>) {
    const metricName = String(args.metricName ?? '');
    const inputStream = args.inputStream as LiveRequestQueue | undefined;
    let runningTotal = 0;
    if (!inputStream) {
      return;
    }
    for await (const req of inputStream) {
      const text = req.content?.parts?.[0]?.text;
      if (text !== undefined) {
        runningTotal += Number(text);
        yield {metricName, runningTotal};
      }
    }
  },
});

const approvalTicketTool = new LongRunningFunctionTool({
  name: 'submit_approval_ticket',
  description: 'Submits a purchase approval ticket.',
  parameters: z.object({
    ticketId: z.string(),
  }),
  execute: async ({ticketId}) => ({
    ticketId,
    status: 'PENDING_APPROVAL',
  }),
});

const authenticatedDiscountTool = new AuthenticatedFunctionTool({
  name: 'lookup_partner_discount',
  description:
    'Looks up a partner discount tier using an authenticated API key.',
  parameters: z.object({
    sku: z.string(),
  }),
  authConfig: {
    authScheme: {
      type: AuthSchemeType.API_KEY,
      in: 'header',
      name: 'X-Partner-Key',
    },
    rawAuthCredential: {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'sample-partner-key',
    },
    credentialKey: 'partner_discount_key',
  },
  execute: async ({sku}, _toolContext, credential) => ({
    sku,
    authenticatedWith: credential?.authType ?? 'none',
    discountPercent: credential?.apiKey ? 10 : 0,
  }),
});

/**
 * A `BaseAuthenticatedTool` subclass: the base class resolves the HTTP bearer
 * credential before `runAsyncImpl` runs.
 */
class LoyaltyBalanceTool extends BaseAuthenticatedTool {
  constructor() {
    super({
      name: 'lookup_loyalty_balance',
      description: 'Looks up a loyalty point balance using a bearer token.',
      authConfig: {
        authScheme: {type: AuthSchemeType.HTTP, scheme: 'bearer'},
        rawAuthCredential: {
          authType: AuthCredentialTypes.HTTP,
          http: {
            scheme: 'bearer',
            credentials: {token: 'sample-loyalty-token'},
          },
        },
        credentialKey: 'loyalty_balance_token',
      },
    });
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {customerId: {type: Type.STRING}},
        required: ['customerId'],
      },
    };
  }

  protected override async runAsyncImpl({
    args,
    credential,
  }: RunAsyncAuthenticatedToolRequest): Promise<unknown> {
    return {
      customerId: args['customerId'],
      authenticatedWith: credential?.authType ?? 'none',
      points: credential?.http?.credentials.token ? 1200 : 0,
    };
  }
}

const loyaltyBalanceTool = new LoyaltyBalanceTool();

const quoteSpecialistAgent = new LlmAgent({
  name: 'quote_specialist',
  description: 'Computes a validated price quote for a SKU and quantity.',
  model: new OfflineQuoteLlm(),
  inputSchema: z.object({
    sku: z.string(),
    quantity: z.number(),
    coupon: z.string().nullable().optional(),
  }),
  outputSchema: z.object({
    sku: z.string(),
    totalUsd: z.number(),
    appliedCoupon: z.string().nullable().optional(),
  }),
});

const quoteAgentTool = new AgentTool({
  agent: quoteSpecialistAgent,
});

interface CalendarSettings {
  maxEvents: number;
}

const googleCalendarLookupTool = new GoogleTool<
  z.ZodObject<{calendarId: z.ZodString}>,
  CalendarSettings
>({
  name: 'listCalendarEvents',
  description: 'Lists calendar events using managed Google credentials.',
  parameters: z.object({
    calendarId: z.string(),
  }),
  credentialsConfig: new BaseGoogleCredentialsConfig({
    externalAccessTokenKey: 'googleCalendarToken',
  }),
  toolSettings: {maxEvents: 5},
  execute: async ({calendarId, credentials, settings}) => ({
    calendarId,
    authenticated: credentials !== undefined,
    maxEvents: settings?.maxEvents,
  }),
});

class CatalogToolset extends BaseToolset {
  private readonly baseTool = new FunctionTool({
    name: 'findItem',
    description: 'Finds an item in the product catalog.',
    parameters: z.object({sku: z.string()}),
    execute: async ({sku}) => ({sku, available: true}),
  });

  constructor() {
    super({toolNamePrefix: 'catalog'});
  }

  override async getTools(): Promise<BaseTool[]> {
    return [this.baseTool];
  }
}

const catalogToolset = new CatalogToolset();

const structuredOutputSchema = z.object({
  sku: z.string(),
  approvedCount: z.number().int().min(1),
  note: z.string().nullable().optional(),
});

const structuredOrderAgent = new LlmAgent({
  name: 'structuredOrderAgent',
  model: new OfflineStructuredRetryLlm(),
  tools: [
    new FunctionTool({
      name: 'pingWarehouse',
      description: 'Checks warehouse availability.',
      execute: () => ({ok: true}),
    }),
  ],
  outputSchema: structuredOutputSchema,
  outputKey: 'orderSummary',
});

const standaloneSetResponseTool = new SetModelResponseTool(
  structuredOutputSchema,
);

const crewInventoryTool = new CrewaiTool(
  {
    name: 'crew_inventory_lookup',
    description: 'Looks up warehouse stock via a CrewAI tool.',
    argsSchema: z.object({
      sku: z.string(),
      warehouse: z.string(),
    }),
    run: async ({sku, warehouse}: {sku: string; warehouse: string}) => ({
      sku,
      warehouse,
      inStock: true,
    }),
  },
  {
    name: 'warehouse_stock_lookup',
    description: 'Checks whether a SKU is in stock at a given warehouse.',
  },
);

const langchainTaxTool = new LangchainTool({
  tool: {
    name: 'calculate_tax',
    description: 'Calculates tax for a subtotal and rate.',
    argsSchema: z.object({
      subtotal: z.number(),
      rate: z.number(),
    }),
    invoke: async ({subtotal, rate}: {subtotal: number; rate: number}) => ({
      taxUsd: Number((subtotal * rate).toFixed(2)),
    }),
  },
});

const toolboxShippingToolset = new ToolboxToolset({
  serverUrl: 'http://127.0.0.1:8080',
  toolsetName: 'shipping_tools',
  client: {
    loadTool: async (name: string) => ({
      name,
      description: `Loads shipping tool ${name}`,
      parameters: z.object({region: z.string()}),
      execute: async ({region}: {region: string}) => ({
        region,
        carrier: 'ExpressFreight',
      }),
    }),
    loadToolset: async () => [
      {
        name: 'estimate_shipping',
        description: 'Estimates shipping carrier for a target region.',
        parameters: z.object({region: z.string()}),
        execute: async ({region}: {region: string}) => ({
          region,
          carrier: 'ExpressFreight',
        }),
      },
    ],
  },
});

const asyncToolboxCustomsToolset = new ToolboxToolset({
  serverUrl: 'http://127.0.0.1:8080',
  toolNames: ['check_customs_duty'],
  authTokenGetters: {
    customs_service: () => 'sample-token',
  },
  boundParams: {
    originCountry: 'US',
  },
  client: {
    loadTool: async (name: string) => ({
      name,
      description: 'Computes customs duty status for a destination region.',
      execute: async (input: unknown) => {
        const args = input as {region?: string};
        return {
          region: String(args.region ?? 'GLOBAL'),
          dutyCleared: true,
        };
      },
    }),
  },
});

class ToolsShowcaseAgent extends BaseAgent {
  constructor() {
    super({
      name: 'tools_showcase_agent',
      description:
        'Demonstrates FunctionTool, LongRunningFunctionTool, AgentTool, ExitLoopTool, CrewaiTool, LangchainTool, ToolboxToolset, and ToolContext.',
    });
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const sku = 'ADK-PRO-100';
    const quantity = 4;

    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call-tools-1',
              name: 'execute_tool_suite',
              args: {sku, quantity},
            },
          },
        ],
      },
    });

    const toolContext = new Context({
      invocationContext: ctx,
      functionCallId: 'call-tools-1',
    });

    const quoteResult = (await quoteAgentTool.runAsync({
      args: {sku, quantity, coupon: null},
      toolContext,
    })) as {sku: string; totalUsd: number; appliedCoupon?: string};

    const conversionResult = (await convertCurrencyTool.runAsync({
      args: {amountUsd: quoteResult.totalUsd},
      toolContext,
    })) as {amountEur: number; currency: string};

    const streamQueue = new LiveRequestQueue();
    streamQueue.sendContent({role: 'user', parts: [{text: '10'}]});
    streamQueue.sendContent({role: 'user', parts: [{text: '15'}]});
    streamQueue.close();
    ctx.activeStreamingTools = {
      [streamMetricsTool.name]: new ActiveStreamingTool({stream: streamQueue}),
    };
    const streamedSnapshots: Array<{metricName: string; runningTotal: number}> =
      [];
    for await (const item of streamMetricsTool._callLive({
      args: {metricName: 'orders_processed'},
      toolContext,
      invocationContext: ctx,
    })) {
      streamedSnapshots.push(
        item as {metricName: string; runningTotal: number},
      );
    }

    const approvalResult = await approvalTicketTool.runAsync({
      args: {ticketId: 'TCK-2026'},
      toolContext,
    });

    const discountResult = await authenticatedDiscountTool.runAsync({
      args: {sku},
      toolContext,
    });

    const loyaltyResult = await loyaltyBalanceTool.runAsync({
      args: {customerId: 'CUST-42'},
      toolContext,
    });

    const stockResult = await crewInventoryTool.runAsync({
      args: {sku, warehouse: 'eu-west'},
      toolContext,
    });

    const taxResult = await langchainTaxTool.runAsync({
      args: {subtotal: quoteResult.totalUsd, rate: 0.08},
      toolContext,
    });

    const [shippingTool] = await toolboxShippingToolset.getTools();
    const shippingResult = await shippingTool.runAsync({
      args: {region: 'EU'},
      toolContext,
    });
    await toolboxShippingToolset.close();

    const [customsTool] = await asyncToolboxCustomsToolset.getTools();
    const customsResult = await customsTool.runAsync({
      args: {region: 'EU'},
      toolContext,
    });
    await asyncToolboxCustomsToolset.close();

    toolContext.state.set('googleCalendarToken', 'sample-google-access-token');
    const calendarResult = await googleCalendarLookupTool.runAsync({
      args: {calendarId: 'primary'},
      toolContext,
    });

    const [prefixedCatalogTool] = await catalogToolset.getToolsWithPrefix();
    const catalogResult = await prefixedCatalogTool.runAsync({
      args: {sku},
      toolContext,
    });
    await catalogToolset.close();

    const directStructuredContext = new Context({
      invocationContext: ctx,
      functionCallId: 'call-set-response-direct',
    });
    const directStructuredResult = await standaloneSetResponseTool.runAsync({
      args: {sku, approvedCount: quantity, note: null},
      toolContext: directStructuredContext,
    });

    const structuredCtx = new InvocationContext({
      invocationId: 'inv-structured-retry',
      agent: structuredOrderAgent,
      session: createSession({
        id: 'sess-structured-retry',
        appName: ctx.appName,
        userId: ctx.userId,
      }),
      pluginManager: new PluginManager(),
    });
    const structuredEvents: Event[] = [];
    for await (const event of structuredOrderAgent.runAsync(structuredCtx)) {
      structuredEvents.push(event);
    }
    const structuredSummary =
      structuredEvents.at(-1)?.actions.stateDelta['orderSummary'];

    const exitLoopContext = new Context({
      invocationContext: ctx,
      functionCallId: 'call-exit-loop',
    });
    await EXIT_LOOP.runAsync({args: {}, toolContext: exitLoopContext});

    const digestPayload = {
      appName: ctx.appName,
      hasResponseSchema: Boolean(
        convertCurrencyTool._getDeclaration().response,
      ),
      toolCustomMetadata: convertCurrencyTool.customMetadata,
      isLongRunningTicket: approvalTicketTool.isLongRunning,
      quoteResult,
      conversionResult,
      streamedSnapshots,
      approvalResult,
      discountResult,
      loyaltyResult,
      stockResult,
      taxResult,
      shippingResult,
      customsResult,
      calendarResult,
      prefixedCatalogToolName: prefixedCatalogTool.name,
      catalogResult,
      directStructuredResult,
      structuredSummary,
      exitLoopActions: {
        escalate: exitLoopContext.actions.escalate,
        skipSummarization: exitLoopContext.actions.skipSummarization,
      },
    };

    const artifactDelta: Record<string, number> = {};
    if (ctx.artifactService) {
      const rev = await ctx.artifactService.saveArtifact({
        filename: TOOLS_DIGEST_FILENAME,
        artifact: {
          text: JSON.stringify(digestPayload, null, 2),
        },
      });
      artifactDelta[TOOLS_DIGEST_FILENAME] = rev;
    }

    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-tools-1',
              name: 'execute_tool_suite',
              response: digestPayload,
            },
          },
        ],
      },
      actions: createEventActions({
        stateDelta: {
          ...toolContext.actions.stateDelta,
          lastQuoteSku: quoteResult.sku,
        },
        artifactDelta,
      }),
    });

    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      content: {
        role: 'model',
        parts: [
          {
            text: `Completed tool suite in ${ctx.appName}: quote=${quoteResult.totalUsd} USD (${conversionResult.amountEur} ${conversionResult.currency}), liveStreamCount=${streamedSnapshots.length}, exitLoopEscalate=${String(exitLoopContext.actions.escalate)}.`,
          },
        ],
      },
    });
  }

  protected override async *runLiveImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(ctx);
  }
}

export const rootAgent = new ToolsShowcaseAgent();

async function main() {
  const appName = 'tools_sample_app';
  const userId = 'user-1';
  const runner = new InMemoryRunner({
    agent: rootAgent,
    appName,
  });

  const session = await runner.sessionService.createSession({
    appName,
    userId,
  });

  for await (const event of runner.runAsync({
    userId,
    sessionId: session.id,
    newMessage: {
      role: 'user',
      parts: [
        {
          text: 'Run the tool showcase suite for SKU ADK-PRO-100.',
        },
      ],
    },
  })) {
    const calls = getFunctionCalls(event);
    const responses = getFunctionResponses(event);
    process.stdout.write(
      `${JSON.stringify({
        id: event.id,
        author: event.author,
        isFinal: isFinalResponse(event),
        functionCalls: calls.map((c) => c.name),
        functionResponses: responses.map((r) => r.name),
        artifactDelta: event.actions.artifactDelta,
        text: stringifyContent(event),
      })}\n`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
