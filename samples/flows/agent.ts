/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Flows (`BaseLlmRequestProcessor`, `BaseLlmResponseProcessor`, `handleFunctionCallsLive`, and `supportCfc`)
 * ../../docs/guides/flows/index.md
 *
 * Demonstrates the three core parts of the ADK LLM flow subsystem without
 * requiring an API key:
 * 1. An `LlmAgent` (`rootAgent`) configured with a custom
 *    `BaseLlmRequestProcessor` (`RequestAuditProcessor`) and a custom
 *    `BaseLlmResponseProcessor` (`ResponseStampProcessor`) backed by a
 *    deterministic offline `BaseLlm` (`FlowDemoLlm`).
 * 2. Live streaming tool execution and cancellation via
 *    `handleFunctionCallsLive`, an async-generator `FunctionTool`
 *    (`monitor_metric`), `LiveRequestQueue`, and `stop_streaming`.
 * 3. Compositional Function Calling (`runConfig.supportCfc: true`), routing
 *    `LlmAgent.runAsync` through `runLiveFlow` with single tool execution and
 *    `StreamingMode.SSE`.
 *
 * This sample exports `rootAgent` for `adk web` and `npm run sample`, and also
 * includes a direct `main()` driver so you can inspect the processor effects,
 * live streaming tool queue messages, `stop_streaming` cancellation status, and
 * `supportCfc` events in one self-contained run.
 *
 * Run (offline, no API key):
 *   npm run build
 *   npx tsx samples/flows/agent.ts
 *   npm run sample -- samples/flows/agent.ts
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BaseLlmRequestProcessor,
  BaseLlmResponseProcessor,
  CONTENT_REQUEST_PROCESSOR,
  Event,
  FunctionTool,
  InMemoryRunner,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  StreamingMode,
  appendInstructions,
  createEvent,
  createLlmResponse,
  createRunConfig,
  createSession,
  getFunctionCalls,
  getFunctionResponses,
  handleFunctionCallsLive,
  stringifyContent,
} from '@google/adk';
import {
  Blob,
  Content,
  FinishReason,
  GenerateContentResponse,
} from '@google/genai';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';

class RequestAuditProcessor extends BaseLlmRequestProcessor {
  async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const channel =
      (invocationContext.session.state['channel'] as string | undefined) ??
      'cli';
    appendInstructions(llmRequest, [`Active channel: ${channel}.`]);
    yield* [];
  }
}

class ResponseStampProcessor extends BaseLlmResponseProcessor {
  async *runAsync(
    _invocationContext: InvocationContext,
    llmResponse: LlmResponse,
  ): AsyncGenerator<Event, void, void> {
    const content = llmResponse.content;
    const parts = content?.parts;
    if (!content || !parts?.length) {
      return;
    }
    const firstTextPart = parts[0];
    if (firstTextPart.text) {
      content.parts = [
        {...firstTextPart, text: `[flow-processed] ${firstTextPart.text}`},
        ...parts.slice(1),
      ];
    }
    yield* [];
  }
}

class FlowDemoLlm extends BaseLlm {
  constructor() {
    super({model: 'flow-demo-llm'});
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const lastContent = llmRequest.contents[llmRequest.contents.length - 1];
    const functionResponse = lastContent?.parts?.find(
      (part) => part.functionResponse !== undefined,
    )?.functionResponse;

    const rawResponse = new GenerateContentResponse();
    if (!functionResponse) {
      rawResponse.candidates = [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call-status-1',
                  name: 'lookup_service_status',
                  args: {service: 'payments'},
                },
              },
            ],
          },
          finishReason: FinishReason.STOP,
        },
      ];
    } else {
      const status =
        (functionResponse.response as Record<string, unknown>)['status'] ??
        'UNKNOWN';
      const systemInstruction =
        typeof llmRequest.config?.systemInstruction === 'string'
          ? llmRequest.config.systemInstruction
          : '';
      rawResponse.candidates = [
        {
          content: {
            role: 'model',
            parts: [
              {
                text: `Service payments is ${String(status)} (${systemInstruction.trim()})`,
              },
            ],
          },
          finishReason: FinishReason.STOP,
        },
      ];
    }
    yield createLlmResponse(rawResponse);
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connection is not used by FlowDemoLlm.');
  }
}

const lookupServiceStatus = new FunctionTool({
  name: 'lookup_service_status',
  description: 'Returns the health status of a backend service.',
  parameters: z.object({
    service: z.string().describe('The service name to inspect.'),
  }),
  execute: async ({service}) => ({
    service,
    status: 'HEALTHY',
  }),
});

export const rootAgent = new LlmAgent({
  name: 'flows_showcase_agent',
  model: new FlowDemoLlm(),
  instruction: 'Check service health with lookup_service_status.',
  tools: [lookupServiceStatus],
  requestProcessors: [new RequestAuditProcessor(), CONTENT_REQUEST_PROCESSOR],
  responseProcessors: [new ResponseStampProcessor()],
});

async function runProcessorFlowDemo(): Promise<void> {
  process.stdout.write('=== 1. LlmAgent Request & Response Processors ===\n');
  const appName = 'flows_sample_app';
  const userId = 'user-1';
  const runner = new InMemoryRunner({agent: rootAgent, appName});
  const session = await runner.sessionService.createSession({
    appName,
    userId,
    state: {channel: 'console'},
  });

  for await (const event of runner.runAsync({
    userId,
    sessionId: session.id,
    newMessage: {
      role: 'user',
      parts: [{text: 'Check the payments service.'}],
    },
  })) {
    const calls = getFunctionCalls(event);
    const responses = getFunctionResponses(event);
    if (calls.length > 0) {
      process.stdout.write(
        `[${event.author}] tool call: ${calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(', ')}\n`,
      );
    } else if (responses.length > 0) {
      process.stdout.write(
        `[${event.author}] tool response: ${responses.map((r) => `${r.name} -> ${JSON.stringify(r.response)}`).join(', ')}\n`,
      );
    } else {
      process.stdout.write(
        `[${event.author}] text: ${stringifyContent(event)}\n`,
      );
    }
  }
}

async function runLiveStreamingToolsDemo(): Promise<void> {
  process.stdout.write(
    '\n=== 2. Live Streaming Tools & stop_streaming (handleFunctionCallsLive) ===\n',
  );
  let releaseNextTick: (() => void) | undefined;
  const monitorMetric = new FunctionTool({
    name: 'monitor_metric',
    description: 'Streams live metric samples until stopped.',
    parameters: z.object({metric: z.string()}),
    execute: async function* ({metric}) {
      yield `${metric}=42ms`;
      yield `${metric}=39ms`;
      await new Promise<void>((resolve) => {
        releaseNextTick = resolve;
      });
      yield `${metric}=99ms`;
    },
  });

  const stopStreaming = new FunctionTool({
    name: 'stop_streaming',
    description: 'Stops an active streaming function by name.',
    parameters: z.object({function_name: z.string()}),
    execute: async () => ({}),
  });

  const liveRequestQueue = new LiveRequestQueue();
  const ctx = new InvocationContext({
    invocationId: 'inv-live-demo',
    agent: rootAgent,
    session: createSession({
      id: 'sess-live-demo',
      appName: 'flows_sample_app',
      userId: 'user-1',
    }),
    liveRequestQueue,
    pluginManager: new PluginManager(),
  });

  const startResponse = await handleFunctionCallsLive({
    invocationContext: ctx,
    functionCallEvent: createEvent({
      invocationId: ctx.invocationId,
      author: rootAgent.name,
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call-stream-1',
              name: 'monitor_metric',
              args: {metric: 'p95_latency'},
            },
          },
        ],
      },
    }),
    toolsDict: {
      monitor_metric: monitorMetric,
      stop_streaming: stopStreaming,
    },
    beforeToolCallbacks: [],
    afterToolCallbacks: [],
  });

  if (startResponse) {
    process.stdout.write(
      `Initial response: ${JSON.stringify(getFunctionResponses(startResponse)[0].response)}\n`,
    );
  }

  const sample1 = await liveRequestQueue.get();
  const sample2 = await liveRequestQueue.get();
  process.stdout.write(
    `Queued stream item 1: ${sample1.content?.parts?.[0]?.text}\n`,
  );
  process.stdout.write(
    `Queued stream item 2: ${sample2.content?.parts?.[0]?.text}\n`,
  );

  const stopResponse = await handleFunctionCallsLive({
    invocationContext: ctx,
    functionCallEvent: createEvent({
      invocationId: ctx.invocationId,
      author: rootAgent.name,
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call-stop-1',
              name: 'stop_streaming',
              args: {function_name: 'monitor_metric'},
            },
          },
        ],
      },
    }),
    toolsDict: {
      monitor_metric: monitorMetric,
      stop_streaming: stopStreaming,
    },
    beforeToolCallbacks: [],
    afterToolCallbacks: [],
  });
  releaseNextTick?.();

  if (stopResponse) {
    process.stdout.write(
      `Stop response: ${JSON.stringify(getFunctionResponses(stopResponse)[0].response)}\n`,
    );
  }
}

class CfcDemoConnection implements BaseLlmConnection {
  private closed = false;
  private yielded = false;

  constructor(private readonly responses: LlmResponse[]) {}

  async sendHistory(_history: Content[]): Promise<void> {}
  async sendContent(_content: Content): Promise<void> {}
  async sendRealtime(_blob: Blob): Promise<void> {}

  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    if (this.closed || this.yielded) {
      return;
    }
    this.yielded = true;
    for (const response of this.responses) {
      if (this.closed) {
        return;
      }
      yield response;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class CfcDemoLlm extends BaseLlm {
  constructor(private readonly connection: CfcDemoConnection) {
    super({model: 'gemini-2.0-flash'});
  }

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void, void> {
    yield* [];
    throw new Error(
      'generateContentAsync is not used when supportCfc is true.',
    );
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return this.connection;
  }
}

async function runSupportCfcDemo(): Promise<void> {
  process.stdout.write(
    '\n=== 3. Compositional Function Calling (runConfig.supportCfc) ===\n',
  );
  const connection = new CfcDemoConnection([
    {
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call-cfc-1',
              name: 'lookup_service_status',
              args: {service: 'billing'},
            },
          },
        ],
      },
    },
    {
      content: {
        role: 'model',
        parts: [{text: 'CFC verified: billing is HEALTHY.'}],
      },
      partial: false,
      turnComplete: true,
    },
  ]);

  const cfcAgent = new LlmAgent({
    name: 'cfc_demo_agent',
    model: new CfcDemoLlm(connection),
    tools: [lookupServiceStatus],
  });

  const session = createSession({
    id: 'sess-cfc-demo',
    appName: 'flows_sample_app',
    userId: 'user-1',
    events: [
      createEvent({
        invocationId: 'inv-cfc-demo',
        author: 'user',
        content: {role: 'user', parts: [{text: 'Verify billing via CFC.'}]},
      }),
    ],
  });

  const ctx = new InvocationContext({
    invocationId: 'inv-cfc-demo',
    agent: cfcAgent,
    session,
    runConfig: createRunConfig({
      supportCfc: true,
      streamingMode: StreamingMode.NONE,
    }),
    pluginManager: new PluginManager(),
  });

  for await (const event of cfcAgent.runAsync(ctx)) {
    const calls = getFunctionCalls(event);
    const responses = getFunctionResponses(event);
    if (calls.length > 0) {
      process.stdout.write(
        `[${event.author}] cfc tool call: ${calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(', ')}\n`,
      );
    } else if (responses.length > 0) {
      process.stdout.write(
        `[${event.author}] cfc tool response: ${responses.map((r) => `${r.name} -> ${JSON.stringify(r.response)}`).join(', ')}\n`,
      );
    } else {
      process.stdout.write(
        `[${event.author}] cfc text: ${stringifyContent(event)}\n`,
      );
    }
  }
}

async function main(): Promise<void> {
  await runProcessorFlowDemo();
  await runLiveStreamingToolsDemo();
  await runSupportCfcDemo();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
