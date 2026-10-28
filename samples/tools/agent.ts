/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tools (`FunctionTool`, `LongRunningFunctionTool`, `AgentTool`, `ExitLoopTool`, `CrewaiTool`, `LangchainTool`, `ToolboxToolset`, and `ToolContext`)
 * ../../docs/guides/tools/index.md
 *
 * A deterministic `BaseAgent` that exercises the `tools` subsystem end-to-end:
 * - `FunctionTool` with a `response` schema and bidirectional live streaming via
 *   `_callLive` with an `AsyncQueue` registered on `ctx.activeStreamingTools`
 * - `LongRunningFunctionTool` with `isLongRunning: true`
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
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  Context,
  createEvent,
  createEventActions,
  Event,
  EXIT_LOOP,
  FunctionTool,
  getFunctionCalls,
  getFunctionResponses,
  InMemoryRunner,
  InvocationContext,
  isFinalResponse,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  LongRunningFunctionTool,
  stringifyContent,
  ToolboxToolset,
  ToolContext,
} from '@google/adk';
import {CrewaiTool, LangchainTool} from '@google/adk-integrations';
import {Type} from '@google/genai';
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
      isLongRunningTicket: approvalTicketTool.isLongRunning,
      quoteResult,
      conversionResult,
      streamedSnapshots,
      approvalResult,
      stockResult,
      taxResult,
      shippingResult,
      customsResult,
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
