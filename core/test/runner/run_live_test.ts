/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AsyncQueue,
  BaseLlm,
  BaseLlmConnection,
  BasePlugin,
  BaseTool,
  Event,
  FunctionTool,
  getFunctionCalls,
  getFunctionResponses,
  InMemoryArtifactService,
  InMemoryCredentialService,
  InMemorySessionService,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  RunAsyncToolRequest,
  Runner,
  SequentialAgent,
} from '@google/adk';
import {
  Blob,
  Content,
  FunctionDeclaration,
  Modality,
  RealtimeInputConfig,
} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

const TEST_APP_ID = 'test_app_id';
const TEST_USER_ID = 'test_user_id';
const TEST_SESSION_ID = 'test_session_id';

class RecordingConnection implements BaseLlmConnection {
  readonly historyCalls: Content[][] = [];
  readonly contentCalls: Content[] = [];
  readonly realtimeCalls: Blob[] = [];
  activityStartCalls = 0;
  activityEndCalls = 0;
  closed = false;
  sendContentError?: Error;
  sendRealtimeError?: Error;
  rejectOnClose = false;
  rejectionsOnClosedConnection = 0;
  sendDelayMs = 0;
  private readonly queue = new AsyncQueue<LlmResponse | Error>();

  constructor(responses: Array<LlmResponse | Error>) {
    for (const r of responses) {
      this.queue.push(r);
    }
  }

  async sendHistory(history: Content[]): Promise<void> {
    this.historyCalls.push(history);
  }
  async sendContent(content: Content): Promise<void> {
    if (this.sendDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.sendDelayMs));
    }
    if (this.closed && this.rejectOnClose) {
      this.rejectionsOnClosedConnection += 1;
      throw new Error('Connection closed while sending content');
    }
    if (this.sendContentError) {
      throw this.sendContentError;
    }
    this.contentCalls.push(content);
  }
  async sendRealtime(blob: Blob): Promise<void> {
    if (this.sendDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.sendDelayMs));
    }
    if (this.closed && this.rejectOnClose) {
      this.rejectionsOnClosedConnection += 1;
      throw new Error('Connection closed while sending realtime');
    }
    if (this.sendRealtimeError) {
      throw this.sendRealtimeError;
    }
    this.realtimeCalls.push(blob);
  }
  async sendActivityStart(): Promise<void> {
    this.activityStartCalls += 1;
  }
  async sendActivityEnd(): Promise<void> {
    this.activityEndCalls += 1;
  }
  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    for await (const response of this.queue) {
      if (response instanceof Error) {
        throw response;
      }
      yield response;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.queue.close();
  }
}

class FakeLiveLlm extends BaseLlm {
  sendContentError?: Error;
  sendRealtimeError?: Error;
  rejectOnClose = false;
  sendDelayMs = 0;

  get connection(): RecordingConnection | undefined {
    return this.connections.at(-1);
  }
  get llmRequestSeen(): LlmRequest | undefined {
    return this.llmRequestsSeen.at(-1);
  }
  readonly connections: RecordingConnection[] = [];
  readonly llmRequestsSeen: LlmRequest[] = [];

  constructor(
    private readonly responses:
      Array<LlmResponse | Error> | Array<Array<LlmResponse | Error>>,
    model = 'fake-live-llm',
  ) {
    super({model});
  }

  // eslint-disable-next-line require-yield
  override async *generateContentAsync(): AsyncGenerator<
    LlmResponse,
    void,
    void
  > {
    throw new Error('generateContentAsync not used in live tests');
  }

  override async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    // Snapshot the request as the caller may mutate `liveConnectConfig`
    // across reconnect attempts (e.g. setting `sessionResumption.handle`).
    this.llmRequestsSeen.push(
      JSON.parse(JSON.stringify(llmRequest)) as LlmRequest,
    );
    const isSequence =
      Array.isArray(this.responses) && Array.isArray(this.responses[0]);
    const responses = isSequence
      ? ((this.responses as Array<Array<LlmResponse | Error>>)[
          this.connections.length
        ] ?? [])
      : (this.responses as Array<LlmResponse | Error>);
    const connection = new RecordingConnection(responses);
    connection.sendContentError = this.sendContentError;
    connection.sendRealtimeError = this.sendRealtimeError;
    connection.rejectOnClose = this.rejectOnClose;
    connection.sendDelayMs = this.sendDelayMs;
    this.connections.push(connection);
    return connection;
  }
}

class EchoTool extends BaseTool {
  constructor() {
    super({name: 'echo', description: 'Echoes back its input.'});
  }
  override _getDeclaration(): FunctionDeclaration | undefined {
    return {name: this.name, description: this.description};
  }
  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    return {echoed: request.args};
  }
}

describe('Runner.runLive', () => {
  let sessionService: InMemorySessionService;
  let artifactService: InMemoryArtifactService;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    artifactService = new InMemoryArtifactService();
    await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
  });

  it('throws when liveRequestQueue is missing', async () => {
    const llm = new FakeLiveLlm([]);
    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    await expect(async () => {
      // @ts-expect-error - intentionally omit required argument
      for await (const _ of runner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
      })) {
        // no-op
      }
    }).rejects.toThrow('liveRequestQueue is required');
  });

  it('creates the session when it does not exist', async () => {
    const llm = new FakeLiveLlm([]);
    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });
    const queue = new LiveRequestQueue();
    queue.close();
    for await (const _ of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: 'missing',
      liveRequestQueue: queue,
    })) {
      // no-op
    }

    const session = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: 'missing',
    });
    expect(session).toBeDefined();
  });

  it('forwards realtime blobs to the connection and yields model events', async () => {
    const audioPart: Content = {
      role: 'model',
      parts: [{inlineData: {data: 'AAA=', mimeType: 'audio/pcm'}}],
    };
    const textPart: Content = {role: 'model', parts: [{text: 'hello'}]};
    const llm = new FakeLiveLlm([
      {content: audioPart},
      {content: textPart},
      {turnComplete: true},
    ]);
    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    const blob: Blob = {data: 'AAA=', mimeType: 'audio/pcm'};
    queue.sendRealtime(blob);
    queue.close();

    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      events.push(event);
    }

    expect(llm.connection).toBeDefined();
    expect(llm.connection!.realtimeCalls).toEqual([blob]);
    expect(llm.connection!.closed).toBe(true);

    expect(events.some((e) => e.content === audioPart)).toBe(true);
    expect(events.some((e) => e.content === textPart)).toBe(true);
    expect(events.some((e) => e.turnComplete)).toBe(true);
  });

  it('defaults responseModalities to AUDIO and applies live config', async () => {
    const llm = new FakeLiveLlm([{turnComplete: true}]);
    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    queue.close();
    for await (const _ of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      // drain
    }

    expect(llm.llmRequestSeen?.liveConnectConfig?.responseModalities).toEqual([
      Modality.AUDIO,
    ]);
  });

  it('does not persist live audio events but persists transcription events', async () => {
    const audioPart: Content = {
      role: 'model',
      parts: [{inlineData: {data: 'AAA=', mimeType: 'audio/pcm'}}],
    };
    const llm = new FakeLiveLlm([
      {content: audioPart},
      {
        outputTranscription: {text: 'hello world', finished: true},
        partial: false,
      },
      {turnComplete: true},
    ]);
    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    queue.close();
    for await (const _ of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      // drain
    }

    const session = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    const persisted = session!.events;
    const hasAudioInline = persisted.some((event) =>
      event.content?.parts?.some((part) =>
        part.inlineData?.mimeType?.startsWith('audio/'),
      ),
    );
    expect(hasAudioInline).toBe(false);
    const hasTranscription = persisted.some(
      (event) => event.outputTranscription !== undefined,
    );
    expect(hasTranscription).toBe(true);
  });

  it('skips inline video/image media and media in non-first parts', async () => {
    const videoPart: Content = {
      role: 'model',
      parts: [{inlineData: {data: 'AAA=', mimeType: 'video/mp4'}}],
    };
    const imagePart: Content = {
      role: 'model',
      parts: [{inlineData: {data: 'AAA=', mimeType: 'image/png'}}],
    };
    const mixedPart: Content = {
      role: 'model',
      parts: [
        {text: 'ignored'},
        {inlineData: {data: 'AAA=', mimeType: 'audio/pcm'}},
      ],
    };
    const textPart: Content = {role: 'model', parts: [{text: 'persist me'}]};
    const llm = new FakeLiveLlm([
      {content: videoPart},
      {content: imagePart},
      {content: mixedPart},
      {content: textPart, partial: false},
      {turnComplete: true},
    ]);
    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    queue.close();
    for await (const _ of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      // drain
    }

    const session = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    const persisted = session!.events;
    const hasInlineMedia = persisted.some((event) =>
      event.content?.parts?.some((part) => part.inlineData !== undefined),
    );
    expect(hasInlineMedia).toBe(false);
    const hasText = persisted.some((event) =>
      event.content?.parts?.some((part) => part.text === 'persist me'),
    );
    expect(hasText).toBe(true);
  });

  it('runs tool calls and sends function responses back to the model', async () => {
    const functionCall: Content = {
      role: 'model',
      parts: [{functionCall: {name: 'echo', args: {value: 1}}}],
    };
    const llm = new FakeLiveLlm([
      {content: functionCall},
      {turnComplete: true},
    ]);
    const agent = new LlmAgent({
      name: 'agent',
      model: llm,
      tools: [new EchoTool()],
    });
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    queue.close();
    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      events.push(event);
    }

    const responseEvents = events.filter((event) =>
      event.content?.parts?.some((part) => part.functionResponse),
    );
    expect(responseEvents.length).toBe(1);

    expect(llm.connection!.contentCalls.length).toBe(1);
    const sentBack = llm.connection!.contentCalls[0];
    expect(sentBack.parts?.[0]?.functionResponse?.name).toBe('echo');
  });

  it('captures sessionResumptionUpdate handles into invocation context', async () => {
    const llm = new FakeLiveLlm([
      {liveSessionResumptionUpdate: {newHandle: 'handle-1'}},
      {liveSessionResumptionUpdate: {newHandle: 'handle-2'}},
      {turnComplete: true},
    ]);
    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    queue.close();
    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      events.push(event);
    }

    const resumeEvents = events.filter((e) => e.liveSessionResumptionUpdate);
    expect(resumeEvents.length).toBe(2);
    expect(resumeEvents[1].liveSessionResumptionUpdate?.newHandle).toBe(
      'handle-2',
    );
  });

  it('reconnects with session handle on goAway and skips history replay', async () => {
    const llm = new FakeLiveLlm([
      [
        {liveSessionResumptionUpdate: {newHandle: 'handle-1'}},
        {goAway: {timeLeft: '1s'}},
      ],
      [{turnComplete: true}],
    ]);
    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    // Seed a content event so contents is non-empty on the first connect.
    const session = (await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    }))!;
    await sessionService.appendEvent({
      session,
      event: {
        invocationId: 'seed',
        author: 'user',
        id: 'seed-evt',
        actions: {
          stateDelta: {},
          artifactDelta: {},
          requestedAuthConfigs: {},
          requestedToolConfirmations: {},
        },
        longRunningToolIds: [],
        timestamp: Date.now(),
        content: {role: 'user', parts: [{text: 'hello'}]},
      } as Event,
    });

    const queue = new LiveRequestQueue();
    queue.close();
    for await (const _ of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      // drain
    }

    expect(llm.connections.length).toBe(2);
    // First connection received history, second skipped it.
    expect(llm.connections[0].historyCalls.length).toBe(1);
    expect(llm.connections[1].historyCalls.length).toBe(0);
    // Second connect carried the captured resumption handle.
    expect(
      llm.llmRequestsSeen[1].liveConnectConfig?.sessionResumption?.handle,
    ).toBe('handle-1');
    expect(
      llm.llmRequestsSeen[1].liveConnectConfig?.sessionResumption?.transparent,
    ).toBe(true);
    // First connect had no resumption handle set.
    expect(
      llm.llmRequestsSeen[0].liveConnectConfig?.sessionResumption?.handle,
    ).toBeUndefined();
  });

  it('uses an externally provided session resumption handle on first connect', async () => {
    const llm = new FakeLiveLlm([{turnComplete: true}]);
    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    // Seed contents so without a handle the runner would call sendHistory.
    const session = (await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    }))!;
    await sessionService.appendEvent({
      session,
      event: {
        invocationId: 'seed',
        author: 'user',
        id: 'seed-evt',
        actions: {
          stateDelta: {},
          artifactDelta: {},
          requestedAuthConfigs: {},
          requestedToolConfirmations: {},
        },
        longRunningToolIds: [],
        timestamp: Date.now(),
        content: {role: 'user', parts: [{text: 'hello'}]},
      } as Event,
    });

    const queue = new LiveRequestQueue();
    queue.close();
    for await (const _ of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
      liveSessionResumptionHandle: 'external-handle',
    })) {
      // drain
    }

    // History was skipped because the caller supplied a handle.
    expect(llm.connections[0].historyCalls.length).toBe(0);
    expect(
      llm.llmRequestsSeen[0].liveConnectConfig?.sessionResumption?.handle,
    ).toBe('external-handle');
  });

  it('does not reconnect when no resumption handle has been captured', async () => {
    const llm = new FakeLiveLlm([
      [{goAway: {timeLeft: '1s'}}],
      [{turnComplete: true}],
    ]);
    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    queue.close();
    await expect(async () => {
      for await (const _ of runner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue: queue,
      })) {
        // drain
      }
    }).rejects.toThrow(/live reconnect requested/);

    expect(llm.connections.length).toBe(1);
  });

  it('forwards activity-start and activity-end signals to the connection', async () => {
    const llm = new FakeLiveLlm([{turnComplete: true}]);
    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    queue.sendActivityStart();
    queue.sendActivityEnd();
    queue.close();
    for await (const _ of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      // drain
    }

    expect(llm.connection!.activityStartCalls).toBe(1);
    expect(llm.connection!.activityEndCalls).toBe(1);
  });

  it('surfaces control-signal responses and attributes user-authored content', async () => {
    const userContent: Content = {
      role: 'user',
      parts: [{text: 'echoed back'}],
    };
    const llm = new FakeLiveLlm([
      {},
      {interrupted: true},
      {usageMetadata: {totalTokenCount: 5}},
      {content: userContent},
      {turnComplete: true},
    ]);
    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    queue.close();
    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      events.push(event);
    }

    expect(events.some((e) => e.interrupted)).toBe(true);
    expect(events.some((e) => e.usageMetadata)).toBe(true);
    const userEvent = events.find((e) => e.content === userContent);
    expect(userEvent?.author).toBe('user');
  });

  it('forwards turn-by-turn content to the connection', async () => {
    const llm = new FakeLiveLlm([{turnComplete: true}]);
    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    const content: Content = {role: 'user', parts: [{text: 'hi there'}]};
    queue.sendContent(content);
    queue.close();
    for await (const _ of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      // drain
    }

    expect(llm.connection!.contentCalls).toEqual([content]);
    expect(llm.connection!.realtimeCalls).toEqual([]);
  });

  it.each<{name: string; realtimeInputConfig: RealtimeInputConfig}>([
    {
      name: 'automatic activity detection is disabled',
      realtimeInputConfig: {automaticActivityDetection: {disabled: true}},
    },
    {
      name: 'automatic activity detection is enabled',
      realtimeInputConfig: {automaticActivityDetection: {disabled: false}},
    },
    {
      name: 'the input config has no automatic activity detection',
      realtimeInputConfig: {},
    },
  ])(
    'forwards realtime blobs unchanged when $name',
    async ({realtimeInputConfig}) => {
      const llm = new FakeLiveLlm([{turnComplete: true}]);
      const agent = new LlmAgent({name: 'agent', model: llm});
      const runner = new Runner({
        appName: TEST_APP_ID,
        agent,
        sessionService,
        artifactService,
      });

      const queue = new LiveRequestQueue();
      const blob: Blob = {data: 'AP8A/w==', mimeType: 'audio/pcm'};
      queue.sendRealtime(blob);
      queue.close();
      for await (const _ of runner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue: queue,
        runConfig: {realtimeInputConfig},
      })) {
        // drain
      }

      expect(llm.connection!.realtimeCalls).toEqual([blob]);
      expect(llm.connection!.contentCalls).toEqual([]);
      expect(
        llm.llmRequestSeen?.liveConnectConfig?.realtimeInputConfig,
      ).toEqual(realtimeInputConfig);
    },
  );

  it('passes the runner credential service into the invocation context', async () => {
    const llm = new FakeLiveLlm([{turnComplete: true}]);
    const agent = new LlmAgent({name: 'agent', model: llm});
    const credentialService = new InMemoryCredentialService();
    let capturedContext: InvocationContext | undefined;
    const plugin = new (class extends BasePlugin {
      constructor() {
        super('capture_context_plugin');
      }
      override async beforeRunCallback({
        invocationContext,
      }: {
        invocationContext: InvocationContext;
      }) {
        capturedContext = invocationContext;
        return undefined;
      }
    })();
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
      credentialService,
      plugins: [plugin],
    });

    const queue = new LiveRequestQueue();
    queue.close();
    for await (const _ of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      // drain
    }

    expect(capturedContext).toBeDefined();
    expect(capturedContext?.credentialService).toBe(credentialService);
  });

  it('stops early when the abort signal is already aborted', async () => {
    const llm = new FakeLiveLlm([{turnComplete: true}]);
    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    queue.close();
    const controller = new AbortController();
    controller.abort();
    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
      abortSignal: controller.signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([]);
  });

  it('stops during execution when the abort signal is aborted', async () => {
    const textContent: Content = {
      role: 'model',
      parts: [{text: 'first event'}],
    };
    const llm = new FakeLiveLlm([
      {content: textContent},
      {content: {role: 'model', parts: [{text: 'second event'}]}},
      {turnComplete: true},
    ]);
    const agent = new LlmAgent({name: 'agent', model: llm});
    class RecordingPlugin extends BasePlugin {}
    const plugin = new RecordingPlugin('lifecycle');
    const afterRun = vi.spyOn(plugin, 'afterRunCallback');
    const onAgentError = vi.spyOn(plugin, 'onAgentErrorCallback');
    const onRunError = vi.spyOn(plugin, 'onRunErrorCallback');
    const runner = new Runner({
      plugins: [plugin],
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    const controller = new AbortController();
    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
      abortSignal: controller.signal,
    })) {
      events.push(event);
      controller.abort();
    }

    expect(events.length).toBeLessThan(3);
    expect(
      events.some((e) => e.content?.parts?.[0]?.text === 'first event'),
    ).toBe(true);
    expect(
      events.some((e) => e.content?.parts?.[0]?.text === 'second event'),
    ).toBe(false);
    expect(llm.connection!.closed).toBe(true);
    expect(afterRun).toHaveBeenCalledTimes(1);
    expect(onAgentError).not.toHaveBeenCalled();
    expect(onRunError).not.toHaveBeenCalled();
  });

  it('does not throw when aborted while an outbound send rejects on closed connection', async () => {
    const llm = new FakeLiveLlm([
      {content: {role: 'model', parts: [{text: 'first'}]}},
      {turnComplete: true},
    ]);
    llm.rejectOnClose = true;
    llm.sendDelayMs = 10;

    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    const controller = new AbortController();
    const events: Event[] = [];

    // Push requests into queue that will be processed during/after close
    queue.sendContent({role: 'user', parts: [{text: 'msg1'}]});
    queue.sendContent({role: 'user', parts: [{text: 'msg2'}]});

    for await (const event of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
      abortSignal: controller.signal,
    })) {
      events.push(event);
      controller.abort();
    }

    expect(llm.connection!.closed).toBe(true);
    expect(llm.connection!.rejectionsOnClosedConnection).toBeGreaterThan(0);
  });

  it('reconnects with session handle on goAway when outbound send rejects on closed connection', async () => {
    const llm = new FakeLiveLlm([
      [
        {liveSessionResumptionUpdate: {newHandle: 'handle-goaway'}},
        {goAway: {timeLeft: '1s'}},
      ],
      [{turnComplete: true}],
    ]);
    llm.rejectOnClose = true;
    llm.sendDelayMs = 10;

    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    // Queue up requests that will be dispatched as connection is closing
    queue.sendContent({role: 'user', parts: [{text: 'msg1'}]});
    queue.sendContent({role: 'user', parts: [{text: 'msg2'}]});
    queue.close();

    for await (const _ of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      // drain
    }

    expect(llm.connections.length).toBe(2);
    expect(llm.connections[0].rejectionsOnClosedConnection).toBeGreaterThan(0);
    expect(
      llm.llmRequestsSeen[1].liveConnectConfig?.sessionResumption?.handle,
    ).toBe('handle-goaway');
  });

  it('transfers to a sub-agent on transfer_to_agent and yields its events', async () => {
    const transferCall: Content = {
      role: 'model',
      parts: [
        {
          functionCall: {
            name: 'transfer_to_agent',
            args: {agent_name: 'child'},
          },
        },
      ],
    };
    const childText: Content = {
      role: 'model',
      parts: [{text: 'child speaking'}],
    };
    const childLlm = new FakeLiveLlm([
      {content: childText},
      {turnComplete: true},
    ]);
    const child = new LlmAgent({name: 'child', model: childLlm});
    const parentLlm = new FakeLiveLlm([
      {content: transferCall},
      {turnComplete: true},
    ]);
    const parent = new LlmAgent({
      name: 'parent',
      model: parentLlm,
      subAgents: [child],
    });
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent: parent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    queue.close();
    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      events.push(event);
    }

    expect(parentLlm.connection!.closed).toBe(true);
    expect(childLlm.connection).toBeDefined();
    expect(events.some((e) => e.content === childText)).toBe(true);
  });

  it('applies speech, transcription, and compression config from the run config', async () => {
    const llm = new FakeLiveLlm([{turnComplete: true}]);
    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    queue.close();
    for await (const _ of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
      runConfig: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {languageCode: 'en-US'},
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: {},
        contextWindowCompression: {slidingWindow: {}},
        proactivity: {proactiveAudio: true},
        enableAffectiveDialog: true,
      },
    })) {
      // drain
    }

    const liveConfig = llm.llmRequestSeen?.liveConnectConfig;
    expect(liveConfig?.speechConfig).toEqual({languageCode: 'en-US'});
    expect(liveConfig?.inputAudioTranscription).toBeDefined();
    expect(liveConfig?.outputAudioTranscription).toBeDefined();
    expect(liveConfig?.realtimeInputConfig).toEqual({});
    expect(liveConfig?.contextWindowCompression).toEqual({slidingWindow: {}});
    expect(liveConfig?.proactivity).toEqual({proactiveAudio: true});
    expect(liveConfig?.enableAffectiveDialog).toBe(true);
  });

  it.each([
    {
      name: 'outputAudioTranscription only',
      runConfig: {outputAudioTranscription: {}},
      expected: {outputAudioTranscription: {}},
    },
    {
      name: 'inputAudioTranscription only',
      runConfig: {inputAudioTranscription: {}},
      expected: {inputAudioTranscription: {}},
    },
    {
      name: 'enableAffectiveDialog set to true',
      runConfig: {enableAffectiveDialog: true},
      expected: {enableAffectiveDialog: true},
    },
    {
      name: 'enableAffectiveDialog set to false',
      runConfig: {enableAffectiveDialog: false},
      expected: {enableAffectiveDialog: false},
    },
    {
      name: 'proactivity configuration',
      runConfig: {proactivity: {proactiveAudio: true}},
      expected: {proactivity: {proactiveAudio: true}},
    },
  ])(
    'forwards $name from RunConfig onto liveConnectConfig',
    async ({runConfig, expected}) => {
      const llm = new FakeLiveLlm([{turnComplete: true}]);
      const agent = new LlmAgent({name: 'agent', model: llm});
      const runner = new Runner({
        appName: TEST_APP_ID,
        agent,
        sessionService,
        artifactService,
      });

      const queue = new LiveRequestQueue();
      queue.sendRealtime({data: 'AP8=', mimeType: 'audio/pcm'});
      queue.close();
      const events: Event[] = [];
      for await (const event of runner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue: queue,
        runConfig,
      })) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(llm.llmRequestSeen?.liveConnectConfig).toEqual(
        expect.objectContaining(expected),
      );
    },
  );

  it.each([1006, 1011, 1012])(
    'reconnects with session handle on websocket close code %i with non-matching message',
    async (code) => {
      const closeError = new Error(`boom ${code}`);
      (closeError as {code?: number}).code = code;

      const llm = new FakeLiveLlm([
        [
          {liveSessionResumptionUpdate: {newHandle: `handle-${code}`}},
          closeError,
        ],
        [{turnComplete: true}],
      ]);
      const agent = new LlmAgent({name: 'agent', model: llm});
      const runner = new Runner({
        appName: TEST_APP_ID,
        agent,
        sessionService,
        artifactService,
      });

      const queue = new LiveRequestQueue();
      queue.close();
      for await (const _ of runner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue: queue,
      })) {
        // drain
      }

      expect(llm.connections.length).toBe(2);
      expect(
        llm.llmRequestsSeen[1].liveConnectConfig?.sessionResumption?.handle,
      ).toBe(`handle-${code}`);
    },
  );

  it.each([
    'read ECONNRESET',
    'socket hang up',
    'ConnectionClosed',
    'connection closed',
  ])(
    'reconnects with session handle on error message matching regex: %s',
    async (message) => {
      const regexError = new Error(message);

      const llm = new FakeLiveLlm([
        [
          {liveSessionResumptionUpdate: {newHandle: 'handle-regex'}},
          regexError,
        ],
        [{turnComplete: true}],
      ]);
      const agent = new LlmAgent({name: 'agent', model: llm});
      const runner = new Runner({
        appName: TEST_APP_ID,
        agent,
        sessionService,
        artifactService,
      });

      const queue = new LiveRequestQueue();
      queue.close();
      for await (const _ of runner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue: queue,
      })) {
        // drain
      }

      expect(llm.connections.length).toBe(2);
      expect(
        llm.llmRequestsSeen[1].liveConnectConfig?.sessionResumption?.handle,
      ).toBe('handle-regex');
    },
  );

  it('throws when max reconnection attempts is exceeded', async () => {
    const sequence = Array.from({length: 7}, (_, i) => [
      {liveSessionResumptionUpdate: {newHandle: `handle-${i}`}},
      {goAway: {timeLeft: '1s'}},
    ]);
    const llm = new FakeLiveLlm(sequence);
    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    queue.close();

    await expect(async () => {
      for await (const _ of runner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue: queue,
      })) {
        // drain
      }
    }).rejects.toThrow(/Max live reconnection attempts reached/);

    expect(llm.connections.length).toBe(6);
  });

  it('propagates the send-loop error and stops execution when the send loop fails', async () => {
    const llm = new FakeLiveLlm([
      {content: {role: 'model', parts: [{text: 'model response'}]}},
      {turnComplete: true},
    ]);
    llm.sendContentError = new Error('Simulated outbound connection error');

    const agent = new LlmAgent({name: 'agent', model: llm});
    class RecordingPlugin extends BasePlugin {}
    const plugin = new RecordingPlugin('lifecycle');
    const afterRun = vi.spyOn(plugin, 'afterRunCallback');
    const onAgentError = vi.spyOn(plugin, 'onAgentErrorCallback');
    const onRunError = vi.spyOn(plugin, 'onRunErrorCallback');
    const runner = new Runner({
      plugins: [plugin],
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    // Send some content to force connection.sendContent to run and fail
    queue.sendContent({role: 'user', parts: [{text: 'hello'}]});

    await expect(async () => {
      for await (const _ of runner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue: queue,
      })) {
        // drain
      }
    }).rejects.toThrow('Simulated outbound connection error');

    expect(llm.connection!.closed).toBe(true);
    expect(afterRun).not.toHaveBeenCalled();
    expect(onAgentError).toHaveBeenCalledTimes(1);
    expect(onRunError).toHaveBeenCalledTimes(1);
    expect(onAgentError.mock.calls[0][0].error).toBe(llm.sendContentError);
    expect(onRunError.mock.calls[0][0].error).toBe(llm.sendContentError);
  });

  it('propagates the send-loop error when the receive loop is empty', async () => {
    const llm = new FakeLiveLlm([]);
    llm.sendContentError = new Error(
      'Simulated outbound connection error on empty receive',
    );

    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    queue.sendContent({role: 'user', parts: [{text: 'hello'}]});

    await expect(async () => {
      for await (const _ of runner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue: queue,
      })) {
        // drain
      }
    }).rejects.toThrow('Simulated outbound connection error on empty receive');

    expect(llm.connection!.closed).toBe(true);
  });

  it('executes a SequentialAgent root agent across sub-agents in live mode', async () => {
    const sub1Content: Content = {
      role: 'model',
      parts: [{text: 'step 1 done'}],
    };
    const sub2Content: Content = {
      role: 'model',
      parts: [{text: 'step 2 done'}],
    };
    const sub1Llm = new FakeLiveLlm([
      {content: sub1Content},
      {turnComplete: true},
    ]);
    const sub2Llm = new FakeLiveLlm([
      {content: sub2Content},
      {turnComplete: true},
    ]);
    const sub1 = new LlmAgent({
      name: 'sub1',
      model: sub1Llm,
      instruction: 'First step.',
    });
    const sub2 = new LlmAgent({
      name: 'sub2',
      model: sub2Llm,
      instruction: 'Second step.',
    });
    const sequentialAgent = new SequentialAgent({
      name: 'seq_root',
      subAgents: [sub1, sub2],
    });
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent: sequentialAgent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    queue.close();
    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      events.push(event);
    }

    const contentEvents = events.filter((e) => e.content);
    expect(contentEvents.map((e) => e.author)).toEqual(['sub1', 'sub2']);
    expect(contentEvents.map((e) => e.content)).toEqual([
      sub1Content,
      sub2Content,
    ]);
    expect(sub1Llm.connection?.closed).toBe(true);
    expect(sub2Llm.connection?.closed).toBe(true);
  });

  it('defaults inputAudioTranscription and outputAudioTranscription to empty objects when the root agent has sub-agents', async () => {
    const parentLlm = new FakeLiveLlm([{turnComplete: true}]);
    const childLlm = new FakeLiveLlm([{turnComplete: true}]);
    const child = new LlmAgent({name: 'child', model: childLlm});
    const parent = new LlmAgent({
      name: 'parent',
      model: parentLlm,
      subAgents: [child],
    });
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent: parent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    queue.close();
    for await (const _ of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      // drain
    }

    const liveConfig = parentLlm.llmRequestSeen?.liveConnectConfig;
    expect(liveConfig?.inputAudioTranscription).toEqual({});
    expect(liveConfig?.outputAudioTranscription).toEqual({});
  });

  it('forwards content when combined with activityStart, activityEnd, or blob on the same LiveRequest', async () => {
    const llm = new FakeLiveLlm([{turnComplete: true}]);
    const agent = new LlmAgent({name: 'agent', model: llm});
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const firstContent: Content = {
      role: 'user',
      parts: [{text: 'alongside activity start'}],
    };
    const secondContent: Content = {
      role: 'user',
      parts: [{text: 'alongside blob'}],
    };
    const thirdContent: Content = {
      role: 'user',
      parts: [{text: 'alongside activity end'}],
    };
    const blob: Blob = {data: 'AP8=', mimeType: 'audio/pcm'};

    const queue = new LiveRequestQueue();
    queue.send({activityStart: {}, content: firstContent});
    queue.send({blob, content: secondContent});
    queue.send({activityEnd: {}, content: thirdContent});
    queue.close();
    for await (const _ of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      // drain
    }

    expect(llm.connection?.activityStartCalls).toBe(1);
    expect(llm.connection?.activityEndCalls).toBe(1);
    expect(llm.connection?.realtimeCalls).toEqual([blob]);
    expect(llm.connection?.contentCalls).toEqual([
      firstContent,
      secondContent,
      thirdContent,
    ]);
  });

  it('executes multiple sequential tool calls in live mode', async () => {
    const weatherTool = new FunctionTool({
      name: 'get_weather',
      description: 'returns weather for a location',
      parameters: z.object({location: z.string()}),
      execute: async ({location}) => ({
        temperature: 22,
        condition: 'sunny',
        location,
      }),
    });
    const timeTool = new FunctionTool({
      name: 'get_time',
      description: 'returns current time for a timezone',
      parameters: z.object({timezone: z.string()}),
      execute: async ({timezone}) => ({time: '14:30', timezone}),
    });
    const llm = new FakeLiveLlm([
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-weather',
                name: 'get_weather',
                args: {location: 'San Francisco'},
              },
            },
          ],
        },
        turnComplete: false,
      },
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-time',
                name: 'get_time',
                args: {timezone: 'PST'},
              },
            },
          ],
        },
        turnComplete: false,
      },
      {turnComplete: true},
    ]);
    const agent = new LlmAgent({
      name: 'agent',
      model: llm,
      tools: [weatherTool, timeTool],
    });
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    queue.close();
    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      events.push(event);
    }

    const calledNames = events.flatMap((e) =>
      getFunctionCalls(e).map((fc) => fc.name),
    );
    const responses = events.flatMap((e) => getFunctionResponses(e));
    expect(calledNames).toEqual(['get_weather', 'get_time']);
    expect(responses).toEqual([
      {
        id: 'fc-weather',
        name: 'get_weather',
        response: {
          temperature: 22,
          condition: 'sunny',
          location: 'San Francisco',
        },
      },
      {
        id: 'fc-time',
        name: 'get_time',
        response: {time: '14:30', timezone: 'PST'},
      },
    ]);
    expect(llm.connection?.contentCalls).toHaveLength(2);
  });

  it('forwards error objects returned by a live tool call', async () => {
    const weatherTool = new FunctionTool({
      name: 'get_weather',
      description: 'returns weather or error',
      parameters: z.object({location: z.string()}),
      execute: async ({location}) => {
        if (location === 'Invalid Location') {
          return {error: 'Location not found'};
        }
        return {temperature: 22, location};
      },
    });
    const llm = new FakeLiveLlm([
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-err',
                name: 'get_weather',
                args: {location: 'Invalid Location'},
              },
            },
          ],
        },
        turnComplete: false,
      },
      {turnComplete: true},
    ]);
    const agent = new LlmAgent({
      name: 'agent',
      model: llm,
      tools: [weatherTool],
    });
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    queue.close();
    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      events.push(event);
    }

    const responses = events.flatMap((e) => getFunctionResponses(e));
    expect(responses).toEqual([
      {
        id: 'fc-err',
        name: 'get_weather',
        response: {error: 'Location not found'},
      },
    ]);
    expect(
      llm.connection?.contentCalls[0]?.parts?.[0]?.functionResponse?.response,
    ).toEqual({
      error: 'Location not found',
    });
  });

  it('launches multiple distinct streaming tools in parallel and forwards their outputs before closing', async () => {
    const monitorStock = new FunctionTool({
      name: 'monitor_stock_price',
      description: 'streams stock updates',
      parameters: z.object({stock_symbol: z.string()}),
      execute: async function* ({stock_symbol}) {
        yield `Stock ${stock_symbol} price: $800`;
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield `Stock ${stock_symbol} price: $805`;
      },
    });
    const monitorMetrics = new FunctionTool({
      name: 'monitor_video_stream',
      description: 'streams video detection updates',
      parameters: z.object({}),
      execute: async function* () {
        yield 'Video monitoring started';
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield 'Detected motion in video stream';
      },
    });

    let capturedContext: InvocationContext | undefined;
    const contextPlugin = new (class extends BasePlugin {
      constructor() {
        super('capture_live_context');
      }
      override async beforeRunCallback({
        invocationContext,
      }: {
        invocationContext: InvocationContext;
      }) {
        capturedContext = invocationContext;
        return undefined;
      }
    })();

    const llm = new FakeLiveLlm([
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-stock',
                name: 'monitor_stock_price',
                args: {stock_symbol: 'NVDA'},
              },
            },
            {
              functionCall: {
                id: 'fc-video',
                name: 'monitor_video_stream',
                args: {},
              },
            },
          ],
        },
        turnComplete: false,
      },
      {turnComplete: true},
    ]);
    const agent = new LlmAgent({
      name: 'agent',
      model: llm,
      tools: [monitorStock, monitorMetrics],
    });
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
      plugins: [contextPlugin],
    });

    const queue = new LiveRequestQueue();
    const events: Event[] = [];
    try {
      const stream = runner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue: queue,
      });
      for await (const event of stream) {
        events.push(event);
        if (events.some((e) => e.turnComplete)) {
          const activeTools = Object.values(
            capturedContext?.activeStreamingTools ?? {},
          );
          await Promise.allSettled(
            activeTools.map((entry) => entry.task?.promise),
          );
          // Allow the send loop to flush all queued streaming tool messages.
          await new Promise((resolve) => setTimeout(resolve, 20));
          queue.close();
        }
      }
    } finally {
      queue.close();
      const activeTools = Object.values(
        capturedContext?.activeStreamingTools ?? {},
      );
      for (const entry of activeTools) {
        entry.task?.cancel();
        entry.stream?.close();
      }
      await Promise.allSettled(activeTools.map((entry) => entry.task?.promise));
    }

    const calledNames = events.flatMap((e) =>
      getFunctionCalls(e).map((fc) => fc.name),
    );
    expect(calledNames).toEqual([
      'monitor_stock_price',
      'monitor_video_stream',
    ]);
    const responses = events.flatMap((e) => getFunctionResponses(e));
    expect(responses).toHaveLength(2);
    expect(
      responses.every(
        (r) =>
          (r.response as Record<string, unknown>)['status'] ===
          'The function is running asynchronously and the results are pending.',
      ),
    ).toBe(true);

    const forwardedTexts =
      llm.connection?.contentCalls.flatMap(
        (c) => c.parts?.map((p) => p.text).filter(Boolean) ?? [],
      ) ?? [];
    expect(forwardedTexts).toEqual(
      expect.arrayContaining([
        'Function monitor_stock_price returned: Stock NVDA price: $800',
        'Function monitor_stock_price returned: Stock NVDA price: $805',
        'Function monitor_video_stream returned: Video monitoring started',
        'Function monitor_video_stream returned: Detected motion in video stream',
      ]),
    );
  });

  it('executes parallel function calls from a single model response in live mode', async () => {
    const weatherTool = new FunctionTool({
      name: 'get_weather',
      description: 'returns weather for a location',
      parameters: z.object({location: z.string()}),
      execute: async ({location}) => {
        const temperatures: Record<string, number> = {
          'San Francisco': 22,
          'New York': 15,
        };
        return {temperature: temperatures[location] ?? 20, location};
      },
    });
    const llm = new FakeLiveLlm([
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-sf',
                name: 'get_weather',
                args: {location: 'San Francisco'},
              },
            },
            {
              functionCall: {
                id: 'fc-nyc',
                name: 'get_weather',
                args: {location: 'New York'},
              },
            },
          ],
        },
        turnComplete: false,
      },
      {turnComplete: true},
    ]);
    const agent = new LlmAgent({
      name: 'agent',
      model: llm,
      tools: [weatherTool],
    });
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });

    const queue = new LiveRequestQueue();
    queue.close();
    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      events.push(event);
    }

    const calls = events.flatMap((e) => getFunctionCalls(e));
    expect(calls).toEqual([
      {
        id: 'fc-sf',
        name: 'get_weather',
        args: {location: 'San Francisco'},
      },
      {
        id: 'fc-nyc',
        name: 'get_weather',
        args: {location: 'New York'},
      },
    ]);
    const responses = events.flatMap((e) => getFunctionResponses(e));
    expect(responses).toEqual([
      {
        id: 'fc-sf',
        name: 'get_weather',
        response: {temperature: 22, location: 'San Francisco'},
      },
      {
        id: 'fc-nyc',
        name: 'get_weather',
        response: {temperature: 15, location: 'New York'},
      },
    ]);
    expect(llm.connection?.contentCalls).toHaveLength(1);
    expect(llm.connection?.contentCalls[0]?.parts).toHaveLength(2);
  });

  it('stops an active streaming tool when stop_streaming is called in live mode', async () => {
    const monitorStock = new FunctionTool({
      name: 'monitor_stock_price',
      description: 'streams stock updates until cancelled',
      parameters: z.object({ticker: z.string()}),
      execute: async function* ({ticker}) {
        yield `Started monitoring ${ticker}`;
        while (true) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          yield `Stock ${ticker} price update`;
        }
      },
    });
    const stopStreaming = new FunctionTool({
      name: 'stop_streaming',
      description: 'stops an active streaming tool',
      parameters: z.object({functionName: z.string()}),
      execute: async ({functionName}) => ({
        stopped: functionName,
      }),
    });

    let capturedContext: InvocationContext | undefined;
    const contextPlugin = new (class extends BasePlugin {
      constructor() {
        super('capture_stop_streaming_context');
      }
      override async beforeRunCallback({
        invocationContext,
      }: {
        invocationContext: InvocationContext;
      }) {
        capturedContext = invocationContext;
        return undefined;
      }
    })();

    const llm = new FakeLiveLlm([
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-start-stream',
                name: 'monitor_stock_price',
                args: {ticker: 'TSLA'},
              },
            },
          ],
        },
        turnComplete: false,
      },
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-stop-stream',
                name: 'stop_streaming',
                args: {functionName: 'monitor_stock_price'},
              },
            },
          ],
        },
        turnComplete: false,
      },
      {turnComplete: true},
    ]);
    const agent = new LlmAgent({
      name: 'agent',
      model: llm,
      tools: [monitorStock, stopStreaming],
    });
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
      plugins: [contextPlugin],
    });

    const queue = new LiveRequestQueue();
    const events: Event[] = [];
    try {
      for await (const event of runner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue: queue,
      })) {
        events.push(event);
        if (event.turnComplete) {
          queue.close();
        }
      }
    } finally {
      queue.close();
      const activeTools = Object.values(
        capturedContext?.activeStreamingTools ?? {},
      );
      for (const entry of activeTools) {
        entry.task?.cancel();
        entry.stream?.close();
      }
      await Promise.allSettled(activeTools.map((entry) => entry.task?.promise));
    }

    const calledNames = events.flatMap((e) =>
      getFunctionCalls(e).map((fc) => fc.name),
    );
    expect(calledNames).toEqual(['monitor_stock_price', 'stop_streaming']);
    const responses = events.flatMap((e) => getFunctionResponses(e));
    expect(responses).toEqual([
      {
        id: 'fc-start-stream',
        name: 'monitor_stock_price',
        response: {
          status:
            'The function is running asynchronously and the results are pending.',
        },
      },
      {
        id: 'fc-stop-stream',
        name: 'stop_streaming',
        response: {
          status: 'Successfully stopped streaming function monitor_stock_price',
        },
      },
    ]);
    expect(
      capturedContext?.activeStreamingTools?.['monitor_stock_price']?.task,
    ).toBeUndefined();
  });
});

/**
 * A connection whose `receive()` ends after each `turnComplete` response and
 * continues with the next turn on the following call.
 */
class TurnByTurnConnection implements BaseLlmConnection {
  closed = false;
  receiveCalls = 0;
  private readonly queue = new AsyncQueue<LlmResponse>();
  private readonly iterator = this.queue[Symbol.asyncIterator]();

  constructor(responses: LlmResponse[]) {
    for (const response of responses) {
      this.queue.push(response);
    }
  }

  async sendHistory(_history: Content[]): Promise<void> {}
  async sendContent(_content: Content): Promise<void> {}
  async sendRealtime(_blob: Blob): Promise<void> {}

  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    this.receiveCalls += 1;
    while (true) {
      const next = await this.iterator.next();
      if (next.done) {
        return;
      }
      yield next.value;
      if (next.value.turnComplete) {
        return;
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queue.close();
  }
}

class TurnByTurnLiveLlm extends FakeLiveLlm {
  turnConnection?: TurnByTurnConnection;

  constructor(private readonly turnResponses: LlmResponse[]) {
    super([], 'turn-by-turn-live-llm');
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    this.turnConnection = new TurnByTurnConnection(this.turnResponses);
    return this.turnConnection;
  }
}

describe('Runner.runLive with a connection that ends receive() per turn', () => {
  let sessionService: InMemorySessionService;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
  });

  async function runLive(llm: TurnByTurnLiveLlm): Promise<Event[]> {
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent: new LlmAgent({name: 'agent', model: llm}),
      sessionService,
    });
    const queue = new LiveRequestQueue();
    queue.close();
    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      events.push(event);
    }
    return events;
  }

  it('keeps receiving the events of later turns', async () => {
    const firstTurn: Content = {role: 'model', parts: [{text: 'first'}]};
    const secondTurn: Content = {role: 'model', parts: [{text: 'second'}]};
    const llm = new TurnByTurnLiveLlm([
      {content: firstTurn},
      {turnComplete: true},
      {content: secondTurn},
      {turnComplete: true},
    ]);

    const events = await runLive(llm);

    const firstIndex = events.findIndex((e) => e.content === firstTurn);
    const secondIndex = events.findIndex((e) => e.content === secondTurn);
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(events.filter((e) => e.turnComplete)).toHaveLength(2);
  });

  it('ends the flow once the connection closes and receive() yields nothing', async () => {
    const llm = new TurnByTurnLiveLlm([{turnComplete: true}]);

    const events = await runLive(llm);

    expect(events.filter((e) => e.turnComplete)).toHaveLength(1);
    expect(llm.turnConnection?.closed).toBe(true);
    expect(llm.turnConnection?.receiveCalls).toBe(2);
  });
});
