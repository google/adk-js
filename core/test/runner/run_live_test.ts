/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
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

  constructor(
    private readonly responses: LlmResponse[],
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
    this.llmRequestSeen = llmRequest;
    this.connection = new RecordingConnection(this.responses);
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

  it('throws when session does not exist', async () => {
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
    await expect(async () => {
      for await (const _ of runner.runLive({
        userId: TEST_USER_ID,
        sessionId: 'missing',
        liveRequestQueue: queue,
      })) {
        // no-op
      }
    }).rejects.toThrow('Session not found: missing');
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
});
