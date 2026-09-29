/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives `Runner.runLive` with a real tracer, so the `send_data` span the live
 * flow opens around history replay is asserted on the exported span.
 */

import {
  AsyncQueue,
  BaseLlm,
  BaseLlmConnection,
  createEvent,
  InMemorySessionService,
  LiveRequestQueue,
  LlmAgent,
  LlmResponse,
  Runner,
} from '@google/adk';
import {Blob, Content} from '@google/genai';
import {context, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

const APP_NAME = 'test_app';
const USER_ID = 'test_user';
const SESSION_ID = 'test_session';

const exporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

class TurnCompleteConnection implements BaseLlmConnection {
  readonly historyCalls: Content[][] = [];
  private readonly queue = new AsyncQueue<LlmResponse>();

  constructor() {
    this.queue.push({turnComplete: true});
  }

  async sendHistory(history: Content[]): Promise<void> {
    this.historyCalls.push(history);
  }
  async sendContent(_content: Content): Promise<void> {}
  async sendRealtime(_blob: Blob): Promise<void> {}
  async sendActivityStart(): Promise<void> {}
  async sendActivityEnd(): Promise<void> {}
  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    yield* this.queue;
  }
  async close(): Promise<void> {
    this.queue.close();
  }
}

class FakeLiveLlm extends BaseLlm {
  readonly connections: TurnCompleteConnection[] = [];

  constructor() {
    super({model: 'fake-live-llm'});
  }

  // eslint-disable-next-line require-yield -- BaseLlm mandates the generator signature; live tests never call it.
  override async *generateContentAsync(): AsyncGenerator<
    LlmResponse,
    void,
    void
  > {
    throw new Error('generateContentAsync is not used in live tests');
  }

  override async connect(): Promise<BaseLlmConnection> {
    const connection = new TurnCompleteConnection();
    this.connections.push(connection);
    return connection;
  }
}

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  contextManager.disable();
});

beforeEach(() => {
  exporter.reset();
});

interface LiveRun {
  llm: FakeLiveLlm;
  invocationIds: string[];
}

async function runLive(seedHistory: boolean): Promise<LiveRun> {
  const llm = new FakeLiveLlm();
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
  if (seedHistory) {
    await sessionService.appendEvent({
      session,
      event: createEvent({
        invocationId: 'seed',
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello'}]},
      }),
    });
  }
  const runner = new Runner({
    appName: APP_NAME,
    agent: new LlmAgent({name: 'live_agent', model: llm}),
    sessionService,
  });

  const queue = new LiveRequestQueue();
  queue.close();
  const invocationIds: string[] = [];
  for await (const event of runner.runLive({
    userId: USER_ID,
    sessionId: SESSION_ID,
    liveRequestQueue: queue,
  })) {
    invocationIds.push(event.invocationId);
  }
  return {llm, invocationIds};
}

describe('live flow send_data span', () => {
  it('records the replayed history on a send_data span', async () => {
    const {llm, invocationIds} = await runLive(true);

    expect(llm.connections[0].historyCalls).toHaveLength(1);
    const spans = exporter
      .getFinishedSpans()
      .filter((s) => s.name === 'send_data');
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(invocationIds.length).toBeGreaterThan(0);
    expect(span.attributes['gcp.vertex.agent.invocation_id']).toBe(
      invocationIds[0],
    );
    expect(typeof span.attributes['gcp.vertex.agent.event_id']).toBe('string');
    const data = span.attributes['gcp.vertex.agent.data'];
    if (typeof data !== 'string') {
      expect.fail('data attribute is not a string');
    }
    expect(JSON.parse(data)).toEqual(llm.connections[0].historyCalls[0]);
  });

  it('opens no send_data span when there is no history to replay', async () => {
    const {llm} = await runLive(false);

    expect(llm.connections[0].historyCalls).toHaveLength(0);
    expect(
      exporter.getFinishedSpans().filter((s) => s.name === 'send_data'),
    ).toEqual([]);
  });
});
