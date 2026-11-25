/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Flows (`BaseLlmRequestProcessor`, `BaseLlmResponseProcessor`, concurrent tool execution, `handleFunctionCallsLive`, `sessionResumption`, `supportCfc`, `SetModelResponseTool`, and `Aclosing`)
 * ../../docs/guides/flows/index.md
 *
 * Demonstrates five core parts of the ADK LLM flow subsystem without requiring
 * an API key:
 * 1. An `LlmAgent` (`rootAgent`) configured with a custom
 *    `BaseLlmRequestProcessor` (`RequestAuditProcessor`),
 *    `CONTENT_REQUEST_PROCESSOR` (excluding foreign-agent `thought` parts), a
 *    custom `BaseLlmResponseProcessor` (`ResponseStampProcessor`), and
 *    concurrent parallel execution of multiple `lookupServiceStatus` calls that
 *    update `toolContext.state` out of call order.
 * 2. Live streaming tool execution and cancellation via
 *    `handleFunctionCallsLive`, an async-generator `FunctionTool`
 *    (`monitorMetric`), `LiveRequestQueue`, and `stop_streaming`.
 * 3. Live session resumption in `Runner.runLive` via
 *    `createRunConfig({sessionResumption: {transparent: true}})`, capturing
 *    `liveSessionResumptionUpdate.newHandle` and reconnecting on `goAway`
 *    without replaying history.
 * 4. Compositional Function Calling (`runConfig.supportCfc: true`), routing
 *    `LlmAgent.runAsync` through `runLiveFlow` with `StreamingMode.NONE`.
 * 5. Structured output alongside tools (`outputSchema` + `FunctionTool` +
 *    `outputKey`) via auto-injected `SetModelResponseTool` (`set_model_response`)
 *    and deterministic generator cleanup via `Aclosing`.
 *
 * Run (offline, no API key):
 *   npm run build
 *   npx tsx samples/flows/agent.ts
 *   npm run sample -- samples/flows/agent.ts
 */

import {
  Aclosing,
  AsyncQueue,
  BaseLlm,
  BaseLlmConnection,
  BaseLlmRequestProcessor,
  BaseLlmResponseProcessor,
  CONTENT_REQUEST_PROCESSOR,
  Event,
  FunctionTool,
  InMemoryRunner,
  InMemorySessionService,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  Runner,
  SET_MODEL_RESPONSE_TOOL_NAME,
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
    const rawChannel = invocationContext.session.state['channel'];
    const channel = typeof rawChannel === 'string' ? rawChannel : 'cli';
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
  lastCapturedContents: Content[] = [];

  constructor() {
    super({model: 'flow-demo-llm'});
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.lastCapturedContents = llmRequest.contents;
    const lastContent = llmRequest.contents[llmRequest.contents.length - 1];
    const functionResponses =
      lastContent?.parts
        ?.map((part) => part.functionResponse)
        .filter((response) => response !== undefined) ?? [];

    const rawResponse = new GenerateContentResponse();
    if (functionResponses.length === 0) {
      rawResponse.candidates = [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call-status-1',
                  name: 'lookupServiceStatus',
                  args: {serviceName: 'payments'},
                },
              },
              {
                functionCall: {
                  id: 'call-status-2',
                  name: 'lookupServiceStatus',
                  args: {serviceName: 'checkout'},
                },
              },
            ],
          },
          finishReason: FinishReason.STOP,
        },
      ];
    } else {
      const summaries = functionResponses.map((response) => {
        const payload = response.response ?? {};
        const serviceName =
          typeof payload['serviceName'] === 'string'
            ? payload['serviceName']
            : 'service';
        const status =
          typeof payload['status'] === 'string' ? payload['status'] : 'UNKNOWN';
        return `${serviceName}=${status}`;
      });
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
                text: `Services checked: ${summaries.join(', ')} (${systemInstruction.trim()})`,
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
  name: 'lookupServiceStatus',
  description: 'Returns the health status of a backend service.',
  parameters: z.object({
    serviceName: z.string().describe('The service name to inspect.'),
  }),
  execute: async ({serviceName}, toolContext) => {
    if (serviceName === 'payments') {
      await Promise.resolve();
      await Promise.resolve();
    }
    const checked = toolContext?.state.get<string[]>('checkedServices') ?? [];
    toolContext?.state.set('checkedServices', [...checked, serviceName]);
    return {
      serviceName,
      status: 'HEALTHY',
    };
  },
});

const flowDemoLlm = new FlowDemoLlm();

export const rootAgent = new LlmAgent({
  name: 'flowsShowcaseAgent',
  model: flowDemoLlm,
  instruction: 'Check service health with lookupServiceStatus.',
  tools: [lookupServiceStatus],
  requestProcessors: [new RequestAuditProcessor(), CONTENT_REQUEST_PROCESSOR],
  responseProcessors: [new ResponseStampProcessor()],
});

async function runProcessorAndParallelToolsDemo(): Promise<void> {
  process.stdout.write(
    '=== 1. Processors, Thought Filtering & Concurrent Parallel Tools ===\n',
  );
  const appName = 'flows-sample-app';
  const userId = 'user-1';
  const runner = new InMemoryRunner({agent: rootAgent, appName});
  const session = await runner.sessionService.createSession({
    appName,
    userId,
    state: {channel: 'console'},
  });

  // Seed a foreign-agent event with a private thought part to verify CONTENT_REQUEST_PROCESSOR excludes it.
  await runner.sessionService.appendEvent({
    session,
    event: createEvent({
      invocationId: 'inv-seed',
      author: 'triageAgent',
      content: {
        role: 'model',
        parts: [
          {text: 'Internal triage reasoning', thought: true},
          {text: 'Escalating service check to flowsShowcaseAgent.'},
        ],
      },
    }),
  });

  for await (const event of runner.runAsync({
    userId,
    sessionId: session.id,
    newMessage: {
      role: 'user',
      parts: [{text: 'Check the payments and checkout services.'}],
    },
  })) {
    const calls = getFunctionCalls(event);
    const responses = getFunctionResponses(event);
    if (calls.length > 0) {
      process.stdout.write(
        `[${event.author}] parallel tool calls: ${calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(', ')}\n`,
      );
    } else if (responses.length > 0) {
      process.stdout.write(
        `[${event.author}] merged tool responses: ${responses.map((r) => `${r.name} -> ${JSON.stringify(r.response)}`).join(', ')}\n`,
      );
      process.stdout.write(
        `[${event.author}] merged stateDelta.checkedServices: ${JSON.stringify(event.actions.stateDelta['checkedServices'])}\n`,
      );
    } else {
      process.stdout.write(
        `[${event.author}] text: ${stringifyContent(event)}\n`,
      );
    }
  }

  const forwardedText = flowDemoLlm.lastCapturedContents
    .flatMap((c) => c.parts ?? [])
    .map((p) => p.text ?? '')
    .join(' | ');
  process.stdout.write(
    `Foreign thought excluded from request contents: ${!forwardedText.includes('Internal triage reasoning')}\n`,
  );
}

async function runLiveStreamingToolsDemo(): Promise<void> {
  process.stdout.write(
    '\n=== 2. Live Streaming Tools & stop_streaming (handleFunctionCallsLive) ===\n',
  );
  let releaseNextTick: (() => void) | undefined;
  const monitorMetric = new FunctionTool({
    name: 'monitorMetric',
    description: 'Streams live metric samples until stopped.',
    parameters: z.object({metricName: z.string()}),
    execute: async function* ({metricName}) {
      yield `${metricName}=42ms`;
      yield `${metricName}=39ms`;
      await new Promise<void>((resolve) => {
        releaseNextTick = resolve;
      });
      yield `${metricName}=99ms`;
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
      appName: 'flows-sample-app',
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
              name: 'monitorMetric',
              args: {metricName: 'p95Latency'},
            },
          },
        ],
      },
    }),
    toolsDict: {
      monitorMetric,
      stop_streaming: stopStreaming,
    },
    beforeToolCallbacks: [],
    afterToolCallbacks: [],
  });

  if (startResponse) {
    process.stdout.write(
      `Initial response: ${JSON.stringify(getFunctionResponses(startResponse)[0]?.response)}\n`,
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
              args: {function_name: 'monitorMetric'},
            },
          },
        ],
      },
    }),
    toolsDict: {
      monitorMetric,
      stop_streaming: stopStreaming,
    },
    beforeToolCallbacks: [],
    afterToolCallbacks: [],
  });
  releaseNextTick?.();

  if (stopResponse) {
    process.stdout.write(
      `Stop response: ${JSON.stringify(getFunctionResponses(stopResponse)[0]?.response)}\n`,
    );
  }
  liveRequestQueue.close();
}

class ScriptedLiveConnection implements BaseLlmConnection {
  historyCalls = 0;
  private readonly queue = new AsyncQueue<LlmResponse>();

  constructor(responses: LlmResponse[]) {
    for (const response of responses) {
      this.queue.push(response);
    }
    this.queue.close();
  }

  async sendHistory(_history: Content[]): Promise<void> {
    this.historyCalls += 1;
  }
  async sendContent(_content: Content): Promise<void> {}
  async sendRealtime(_blob: Blob): Promise<void> {}

  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    for await (const response of this.queue) {
      yield response;
    }
  }

  async close(): Promise<void> {
    this.queue.close();
  }
}

class ResumableLiveDemoLlm extends BaseLlm {
  readonly connections: ScriptedLiveConnection[] = [];
  readonly seenHandles: Array<string | undefined> = [];

  constructor(private readonly scriptedTurns: LlmResponse[][]) {
    // Numeric 2.x+ version required when shared with supportCfc validation.
    super({model: 'gemini-2.5-flash'});
  }

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void, void> {
    yield* [];
    throw new Error('generateContentAsync is not used in live mode.');
  }

  async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    this.seenHandles.push(
      llmRequest.liveConnectConfig?.sessionResumption?.handle,
    );
    const turnResponses = this.scriptedTurns[this.connections.length] ?? [];
    const connection = new ScriptedLiveConnection(turnResponses);
    this.connections.push(connection);
    return connection;
  }
}

async function runLiveSessionResumptionDemo(): Promise<void> {
  process.stdout.write(
    '\n=== 3. Live Session Resumption (sessionResumption & goAway) ===\n',
  );
  const liveLlm = new ResumableLiveDemoLlm([
    [
      {liveSessionResumptionUpdate: {newHandle: 'resume-token-42'}},
      {goAway: {timeLeft: '1s'}},
    ],
    [
      {
        content: {
          role: 'model',
          parts: [{text: 'Reconnected live session with saved handle.'}],
        },
        turnComplete: true,
      },
    ],
  ]);
  const liveAgent = new LlmAgent({
    name: 'liveResumptionAgent',
    model: liveLlm,
  });
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'flows-sample-app',
    userId: 'user-1',
  });
  await sessionService.appendEvent({
    session,
    event: createEvent({
      invocationId: 'inv-prior',
      author: 'user',
      content: {role: 'user', parts: [{text: 'Prior turn in history.'}]},
    }),
  });

  const runner = new Runner({
    appName: 'flows-sample-app',
    agent: liveAgent,
    sessionService,
  });
  const liveRequestQueue = new LiveRequestQueue();
  liveRequestQueue.close();

  for await (const event of runner.runLive({
    userId: 'user-1',
    sessionId: session.id,
    liveRequestQueue,
    runConfig: createRunConfig({
      sessionResumption: {transparent: true},
    }),
  })) {
    if (event.liveSessionResumptionUpdate?.newHandle) {
      process.stdout.write(
        `Captured resumption handle: ${event.liveSessionResumptionUpdate.newHandle}\n`,
      );
    } else if (event.content) {
      process.stdout.write(
        `[${event.author}] ${stringifyContent(event)} (handles seen=${JSON.stringify(liveLlm.seenHandles)}, historyCalls=${JSON.stringify(liveLlm.connections.map((c) => c.historyCalls))})\n`,
      );
    }
  }
}

async function runSupportCfcDemo(): Promise<void> {
  process.stdout.write(
    '\n=== 4. Compositional Function Calling (runConfig.supportCfc) ===\n',
  );
  const cfcLlm = new ResumableLiveDemoLlm([
    [
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-cfc-1',
                name: 'lookupServiceStatus',
                args: {serviceName: 'billing'},
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
    ],
  ]);

  const cfcAgent = new LlmAgent({
    name: 'cfcDemoAgent',
    model: cfcLlm,
    tools: [lookupServiceStatus],
  });

  const session = createSession({
    id: 'sess-cfc-demo',
    appName: 'flows-sample-app',
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

async function runStructuredToolsDemo(): Promise<void> {
  process.stdout.write(
    '\n=== 5. Structured Output with Tools & Aclosing Cleanup ===\n',
  );

  class StructuredToolsDemoLlm extends BaseLlm {
    readonly registeredToolLists: string[][] = [];

    constructor() {
      super({model: 'structured-tools-demo-llm'});
    }

    async *generateContentAsync(
      llmRequest: LlmRequest,
    ): AsyncGenerator<LlmResponse, void, void> {
      this.registeredToolLists.push(Object.keys(llmRequest.toolsDict).sort());
      const lastContent = llmRequest.contents[llmRequest.contents.length - 1];
      const functionResponses =
        lastContent?.parts
          ?.map((part) => part.functionResponse)
          .filter((response) => response !== undefined) ?? [];

      const rawResponse = new GenerateContentResponse();
      if (functionResponses.length === 0) {
        rawResponse.candidates = [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'call-region-1',
                    name: 'fetchRegionSlo',
                    args: {region: 'us-central1'},
                  },
                },
              ],
            },
            finishReason: FinishReason.STOP,
          },
        ];
      } else {
        const payload = functionResponses[0]?.response ?? {};
        const region =
          typeof payload['region'] === 'string'
            ? payload['region']
            : 'us-central1';
        const availabilityPct =
          typeof payload['availabilityPct'] === 'number'
            ? payload['availabilityPct']
            : 99.95;
        rawResponse.candidates = [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'call-structured-1',
                    name: SET_MODEL_RESPONSE_TOOL_NAME,
                    args: {
                      region,
                      availabilityPct,
                      withinSlo: availabilityPct >= 99.9,
                    },
                  },
                },
              ],
            },
            finishReason: FinishReason.STOP,
          },
        ];
      }
      yield createLlmResponse(rawResponse);
    }

    async connect(): Promise<BaseLlmConnection> {
      throw new Error('Live connection is not used by StructuredToolsDemoLlm.');
    }
  }

  const fetchRegionSlo = new FunctionTool({
    name: 'fetchRegionSlo',
    description: 'Returns availability percentage for a cloud region.',
    parameters: z.object({region: z.string()}),
    execute: async ({region}) => ({region, availabilityPct: 99.98}),
  });

  const sloReportSchema = z.object({
    region: z.string(),
    availabilityPct: z.number(),
    withinSlo: z.boolean(),
  });

  const structuredLlm = new StructuredToolsDemoLlm();
  const structuredAgent = new LlmAgent({
    name: 'structuredSloAgent',
    model: structuredLlm,
    instruction: 'Check availability with fetchRegionSlo and return a report.',
    tools: [fetchRegionSlo],
    outputSchema: sloReportSchema,
    outputKey: 'sloReport',
  });

  const appName = 'flows-sample-app';
  const userId = 'user-1';
  const runner = new InMemoryRunner({agent: structuredAgent, appName});
  const session = await runner.sessionService.createSession({appName, userId});

  for await (const event of new Aclosing(
    runner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [{text: 'Generate the SLO report for us-central1.'}],
      },
    }),
  )) {
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
        `[${event.author}] structured final event: ${stringifyContent(event)} (stateDelta.sloReport=${JSON.stringify(event.actions.stateDelta['sloReport'])})\n`,
      );
    }
  }

  process.stdout.write(
    `Registered tools per turn: ${JSON.stringify(structuredLlm.registeredToolLists)}\n`,
  );
}

async function main(): Promise<void> {
  await runProcessorAndParallelToolsDemo();
  await runLiveStreamingToolsDemo();
  await runLiveSessionResumptionDemo();
  await runSupportCfcDemo();
  await runStructuredToolsDemo();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    const message =
      err instanceof Error ? (err.stack ?? err.message) : JSON.stringify(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
