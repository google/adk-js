/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BasePlugin,
  BaseTool,
  Event,
  InMemoryArtifactService,
  InMemorySessionService,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  RunAsyncToolRequest,
  Runner,
  SequentialAgent,
} from '@google/adk';
import {Blob, Content, FunctionDeclaration, Modality} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';

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

  constructor(private readonly responses: LlmResponse[]) {}

  async sendHistory(history: Content[]): Promise<void> {
    this.historyCalls.push(history);
  }
  async sendContent(content: Content): Promise<void> {
    this.contentCalls.push(content);
  }
  async sendRealtime(blob: Blob): Promise<void> {
    this.realtimeCalls.push(blob);
  }
  async sendActivityStart(): Promise<void> {
    this.activityStartCalls += 1;
  }
  async sendActivityEnd(): Promise<void> {
    this.activityEndCalls += 1;
  }
  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    for (const response of this.responses) {
      yield response;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeLiveLlm extends BaseLlm {
  connection?: RecordingConnection;
  llmRequestSeen?: LlmRequest;
  readonly connections: RecordingConnection[] = [];
  readonly llmRequestsSeen: LlmRequest[] = [];

  constructor(
    private readonly responses: LlmResponse[] | LlmResponse[][],
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
    this.llmRequestSeen = llmRequest;
    this.llmRequestsSeen.push(
      JSON.parse(JSON.stringify(llmRequest)) as LlmRequest,
    );
    const isSequence =
      Array.isArray(this.responses) && Array.isArray(this.responses[0]);
    const responses = isSequence
      ? ((this.responses as LlmResponse[][])[this.connections.length] ?? [])
      : (this.responses as LlmResponse[]);
    this.connection = new RecordingConnection(responses);
    this.connections.push(this.connection);
    return this.connection;
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

  it('stops and tears down the connection when aborted mid-execution', async () => {
    const first: Content = {role: 'model', parts: [{text: 'first'}]};
    const second: Content = {role: 'model', parts: [{text: 'second'}]};
    const llm = new FakeLiveLlm([
      {content: first},
      {content: second},
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
    const controller = new AbortController();
    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
      abortSignal: controller.signal,
    })) {
      events.push(event);
      // Abort once the first event is out, while the model still has more
      // queued and the send loop is parked on the (still open) queue.
      controller.abort();
    }

    expect(events).toHaveLength(1);
    expect(events[0].content).toBe(first);
    // Aborting must not strand the connection or the send loop.
    expect(llm.connection!.closed).toBe(true);
    queue.close();

    const session = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    expect(
      session!.events.some((e) => e.content?.parts?.[0]?.text === 'second'),
    ).toBe(false);
  });

  it('closes the connection when the caller stops consuming early', async () => {
    const llm = new FakeLiveLlm([
      {content: {role: 'model', parts: [{text: 'first'}]}},
      {content: {role: 'model', parts: [{text: 'second'}]}},
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
    for await (const _ of runner.runLive({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      liveRequestQueue: queue,
    })) {
      // Abandoning the generator unwinds runLiveFlow through a return
      // completion rather than the normal or error path; teardown must still
      // run so the connection and send loop are not stranded.
      break;
    }

    expect(llm.connection!.closed).toBe(true);
    queue.close();
  });

  it('ends the live turn when a sub-agent signals task_completed', async () => {
    const taskCompletedCall: Content = {
      role: 'model',
      parts: [{functionCall: {name: 'task_completed', args: {}}}],
    };
    const afterCompletion: Content = {
      role: 'model',
      parts: [{text: 'should not be yielded'}],
    };
    const llm = new FakeLiveLlm([
      {content: taskCompletedCall},
      {content: afterCompletion},
      {turnComplete: true},
    ]);
    const child = new LlmAgent({name: 'child', model: llm});
    const sequential = new SequentialAgent({
      name: 'sequential',
      subAgents: [child],
    });
    const runner = new Runner({
      appName: TEST_APP_ID,
      agent: sequential,
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

    // The task_completed response ends the turn: nothing the model sent after
    // it is surfaced, and the connection is torn down.
    expect(
      events.some(
        (e) => e.content?.parts?.[0]?.text === 'should not be yielded',
      ),
    ).toBe(false);
    expect(llm.connection!.closed).toBe(true);
  });

  it('persists the plugin-modified event, not the original', async () => {
    const original: Content = {role: 'model', parts: [{text: 'original'}]};
    const llm = new FakeLiveLlm([{content: original}, {turnComplete: true}]);
    const agent = new LlmAgent({name: 'agent', model: llm});

    class RewritingPlugin extends BasePlugin {
      constructor() {
        super('rewriting-plugin');
      }
      // Returns a distinct event rather than mutating in place, so persisting
      // before the callback would store the original object and be caught.
      override async onEventCallback(request: {event: Event}) {
        if (request.event.content?.parts?.[0]?.text !== 'original') {
          return undefined;
        }
        return {
          ...request.event,
          content: {role: 'model', parts: [{text: 'rewritten'}]},
        } as Event;
      }
    }

    const runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
      plugins: [new RewritingPlugin()],
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

    expect(
      events.some((e) => e.content?.parts?.[0]?.text === 'rewritten'),
    ).toBe(true);
    const session = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    // The session must hold what the plugin produced and what the caller saw.
    expect(
      session!.events.some((e) => e.content?.parts?.[0]?.text === 'rewritten'),
    ).toBe(true);
    expect(
      session!.events.some((e) => e.content?.parts?.[0]?.text === 'original'),
    ).toBe(false);
  });

  it('transfers to a sub-agent on transfer_to_agent and yields its events', async () => {
    const transferCall: Content = {
      role: 'model',
      parts: [
        {functionCall: {name: 'transfer_to_agent', args: {agentName: 'child'}}},
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
    expect(liveConfig?.contextWindowCompression).toEqual({slidingWindow: {}});
    expect(liveConfig?.proactivity).toEqual({proactiveAudio: true});
    expect(liveConfig?.enableAffectiveDialog).toBe(true);
  });
});
