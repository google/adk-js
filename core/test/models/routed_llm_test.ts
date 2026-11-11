/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Gemini,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  RoutedLlm,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class MockLlm extends BaseLlm {
  receivedStream: boolean | undefined;
  receivedModel: string | undefined;
  receivedAbortSignal: AbortSignal | undefined;

  constructor(modelName: string) {
    super({model: modelName});
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    this.receivedStream = stream;
    this.receivedModel = llmRequest.model;
    this.receivedAbortSignal = abortSignal;
    yield {
      content: {
        role: 'model',
        parts: [{text: `Response from ${this.model}`}],
      },
    } as LlmResponse;
  }

  async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    this.receivedModel = llmRequest.model;
    return {} as BaseLlmConnection;
  }
}

describe('RoutedLlm', () => {
  const modelA = new MockLlm('model-a');
  const modelB = new MockLlm('model-b');
  const models = [modelA, modelB];

  it('should route generateContentAsync to the selected model A', async () => {
    let routerCalledWithModels: Readonly<Record<string, BaseLlm>> | null = null;
    let routerCalledWithRequest: LlmRequest | null = null;
    const router = async (
      models: Readonly<Record<string, BaseLlm>>,
      req: LlmRequest,
    ) => {
      routerCalledWithModels = models;
      routerCalledWithRequest = req;
      return 'model-a';
    };

    const routedLlm = new RoutedLlm({models, router});
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const generator = routedLlm.generateContentAsync(request);
    const result = await generator.next();

    expect(result.value?.content?.parts?.[0]?.text).toBe(
      'Response from model-a',
    );
    expect(routerCalledWithRequest).toBe(request);
    expect(routerCalledWithModels).toBeDefined();
  });

  it('should route generateContentAsync to the selected model B', async () => {
    const router = async (
      _models: Readonly<Record<string, BaseLlm>>,
      _req: LlmRequest,
    ) => 'model-b';

    const routedLlm = new RoutedLlm({models, router});
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const generator = routedLlm.generateContentAsync(request);
    const result = await generator.next();

    expect(result.value?.content?.parts?.[0]?.text).toBe(
      'Response from model-b',
    );
  });

  it('should throw error if selected model is not found', async () => {
    const router = async (
      _models: Readonly<Record<string, BaseLlm>>,
      _req: LlmRequest,
    ) => 'unknown-model';

    const routedLlm = new RoutedLlm({models, router});
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const generator = routedLlm.generateContentAsync(request);

    await expect(generator.next()).rejects.toThrow(
      'Item not found for key: unknown-model',
    );
  });

  it('should route connect to the selected model', async () => {
    let routerCalled = false;
    const router = async (
      _models: Readonly<Record<string, BaseLlm>>,
      _req: LlmRequest,
    ) => {
      routerCalled = true;
      return 'model-b';
    };

    const routedLlm = new RoutedLlm({models, router});
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    await routedLlm.connect(request);

    expect(routerCalled).toBe(true);
  });

  it('should failover in generateContentAsync if the first model fails before yielding', async () => {
    class FailingLlm extends BaseLlm {
      constructor(modelName: string) {
        super({model: modelName});
      }

      // eslint-disable-next-line require-yield -- the test double throws before it can yield
      async *generateContentAsync(
        _llmRequest: LlmRequest,
        _stream?: boolean,
      ): AsyncGenerator<LlmResponse, void> {
        throw new Error('Model failed');
      }

      async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
        return {} as BaseLlmConnection;
      }
    }

    const failingModel = new FailingLlm('model-failing');
    const successModel = new MockLlm('model-success');
    const testModels = [failingModel, successModel];

    let routerCalls = 0;
    const router = async (
      models: Readonly<Record<string, BaseLlm>>,
      req: LlmRequest,
      context?: {failedKeys: ReadonlySet<string>; lastError: unknown},
    ) => {
      routerCalls++;
      if (!context) return 'model-failing';
      if (context.failedKeys.has('model-failing')) return 'model-success';
      return undefined;
    };

    const routedLlm = new RoutedLlm({models: testModels, router});
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const generator = routedLlm.generateContentAsync(request);
    const result = await generator.next();

    expect(result.value?.content?.parts?.[0]?.text).toBe(
      'Response from model-success',
    );
    expect(routerCalls).toBe(2);
  });

  it('should not failover in generateContentAsync if failure occurs after yielding content', async () => {
    class PartialLlm extends BaseLlm {
      constructor(modelName: string) {
        super({model: modelName});
      }

      async *generateContentAsync(
        _llmRequest: LlmRequest,
        _stream?: boolean,
      ): AsyncGenerator<LlmResponse, void> {
        yield {
          content: {
            role: 'model',
            parts: [{text: 'Partial response'}],
          },
        } as LlmResponse;
        throw new Error('Mid-stream failure');
      }

      async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
        return {} as BaseLlmConnection;
      }
    }

    const partialModel = new PartialLlm('model-partial');
    const fallbackModel = new MockLlm('model-fallback');
    const testModels = [partialModel, fallbackModel];

    let routerCalls = 0;
    const router = async (
      models: Readonly<Record<string, BaseLlm>>,
      req: LlmRequest,
      context?: {failedKeys: ReadonlySet<string>; lastError: unknown},
    ) => {
      routerCalls++;
      if (!context) return 'model-partial';
      return 'model-fallback';
    };

    const routedLlm = new RoutedLlm({models: testModels, router});
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const generator = routedLlm.generateContentAsync(request);

    const firstResult = await generator.next();
    expect(firstResult.value?.content?.parts?.[0]?.text).toBe(
      'Partial response',
    );

    await expect(generator.next()).rejects.toThrow('Mid-stream failure');
    expect(routerCalls).toBe(1);
  });

  it('should failover in connect if the first model fails to connect', async () => {
    class FailingConnectLlm extends BaseLlm {
      constructor(modelName: string) {
        super({model: modelName});
      }

      async *generateContentAsync(
        _llmRequest: LlmRequest,
        _stream?: boolean,
      ): AsyncGenerator<LlmResponse, void> {
        yield {} as LlmResponse;
      }

      async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
        throw new Error('Connect failed');
      }
    }

    const failingModel = new FailingConnectLlm('model-failing');
    const successModel = new MockLlm('model-success');
    const testModels = [failingModel, successModel];

    let routerCalls = 0;
    const router = async (
      _models: Readonly<Record<string, BaseLlm>>,
      _req: LlmRequest,
      _context?: {failedKeys: ReadonlySet<string>; lastError: unknown},
    ) => {
      routerCalls++;
      if (routerCalls == 1) {
        return 'model-failing';
      }
      return 'model-success';
    };

    const routedLlm = new RoutedLlm({models: testModels, router});
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const connection = await routedLlm.connect(request);
    expect(connection).toBeDefined();
    expect(routerCalls).toBe(2);
  });

  it('should propagate error if router returns undefined (bails out)', async () => {
    class FailingLlm extends BaseLlm {
      constructor(modelName: string) {
        super({model: modelName});
      }

      // eslint-disable-next-line require-yield -- the test double throws before it can yield
      async *generateContentAsync(
        _llmRequest: LlmRequest,
        _stream?: boolean,
      ): AsyncGenerator<LlmResponse, void> {
        throw new Error('Initial fail');
      }

      async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
        throw new Error('Initial fail');
      }
    }

    const failingModel = new FailingLlm('model-failing');
    const testModels = [failingModel];

    const router = async (
      models: Readonly<Record<string, BaseLlm>>,
      req: LlmRequest,
      context?: {failedKeys: ReadonlySet<string>; lastError: unknown},
    ) => {
      if (!context) return 'model-failing';
      return undefined;
    };

    const routedLlm = new RoutedLlm({models: testModels, router});
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const generator = routedLlm.generateContentAsync(request);
    await expect(generator.next()).rejects.toThrow('Initial fail');

    await expect(routedLlm.connect(request)).rejects.toThrow('Initial fail');
  });

  it('should throw error if initial routing fails (returns undefined) in generateContentAsync', async () => {
    const router = async () => undefined;
    const routedLlm = new RoutedLlm({models: [], router});
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const generator = routedLlm.generateContentAsync(request);
    await expect(generator.next()).rejects.toThrow(
      'Initial routing failed, no item selected.',
    );
  });

  it('should throw error if initial routing fails (returns undefined) in connect', async () => {
    const router = async () => undefined;
    const routedLlm = new RoutedLlm({models: [], router});
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    await expect(routedLlm.connect(request)).rejects.toThrow(
      'Initial routing failed, no item selected.',
    );
  });

  it('should propagate stream parameter to selected model', async () => {
    const model = new MockLlm('model-a');
    const router = async () => 'model-a';
    const routedLlm = new RoutedLlm({models: [model], router});
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const generator = routedLlm.generateContentAsync(request, true);
    await generator.next();

    expect(model.receivedStream).toBe(true);
  });

  it('should set llmRequest.model to the selected route model in generateContentAsync and connect, including on failover', async () => {
    const seenByFailingGenerate: Array<string | undefined> = [];
    const seenByFailingConnect: Array<string | undefined> = [];

    class FailingRouteLlm extends BaseLlm {
      constructor(modelName: string) {
        super({model: modelName});
      }

      // eslint-disable-next-line require-yield -- the test double throws before it can yield
      async *generateContentAsync(
        llmRequest: LlmRequest,
      ): AsyncGenerator<LlmResponse, void> {
        seenByFailingGenerate.push(llmRequest.model);
        throw new Error('primary failed');
      }

      async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
        seenByFailingConnect.push(llmRequest.model);
        throw new Error('primary connect failed');
      }
    }

    const primary = new FailingRouteLlm('gemini-2.5-flash');
    const backup = new MockLlm('gemini-2.5-pro');
    const routedLlm = new RoutedLlm({
      models: [primary, backup],
      router: (_models, _req, errorContext) =>
        errorContext ? 'gemini-2.5-pro' : 'gemini-2.5-flash',
    });

    const generateRequest: LlmRequest = {
      model: routedLlm.model,
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const gen = routedLlm.generateContentAsync(generateRequest);
    await gen.next();

    expect(seenByFailingGenerate).toEqual(['gemini-2.5-flash']);
    expect(backup.receivedModel).toBe('gemini-2.5-pro');
    expect(generateRequest.model).toBe('gemini-2.5-pro');

    backup.receivedModel = undefined;
    const connectRequest: LlmRequest = {
      model: routedLlm.model,
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    await routedLlm.connect(connectRequest);

    expect(seenByFailingConnect).toEqual(['gemini-2.5-flash']);
    expect(backup.receivedModel).toBe('gemini-2.5-pro');
    expect(connectRequest.model).toBe('gemini-2.5-pro');
  });

  it('calls the selected Gemini route with its own model name when driven through LlmAgent and InMemoryRunner', async () => {
    let calledModel: string | undefined;
    function stubbedGemini(model: string): Gemini {
      const llm = new Gemini({model, apiKey: 'unused'});
      Object.defineProperty(llm, 'apiClient', {
        value: {
          models: {
            generateContent: async (params: {model: string}) => {
              calledModel = params.model;
              return {
                candidates: [{content: {role: 'model', parts: [{text: 'ok'}]}}],
              };
            },
          },
        },
      });
      return llm;
    }

    const routed = new RoutedLlm({
      models: [
        stubbedGemini('gemini-2.5-flash'),
        stubbedGemini('gemini-2.5-pro'),
      ],
      router: (models) => Object.keys(models)[1],
    });
    const agent = new LlmAgent({
      name: 'a',
      model: routed,
      instruction: 'Be brief.',
    });
    const runner = new InMemoryRunner({agent, appName: 'repro'});
    const session = await runner.sessionService.createSession({
      appName: 'repro',
      userId: 'u',
    });
    for await (const _ of runner.runAsync({
      userId: 'u',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'hi'}]},
    })) {
      // consume events
    }

    expect(calledModel).toBe('gemini-2.5-pro');
  });

  it('should propagate abortSignal parameter to selected model, including on failover', async () => {
    let failingReceivedSignal: AbortSignal | undefined;
    class FailingSignalLlm extends BaseLlm {
      constructor() {
        super({model: 'model-failing'});
      }

      // eslint-disable-next-line require-yield -- the test double throws before it can yield
      async *generateContentAsync(
        _llmRequest: LlmRequest,
        _stream?: boolean,
        abortSignal?: AbortSignal,
      ): AsyncGenerator<LlmResponse, void> {
        failingReceivedSignal = abortSignal;
        throw new Error('Primary failed');
      }

      async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
        return {} as BaseLlmConnection;
      }
    }

    const failingModel = new FailingSignalLlm();
    const fallbackModel = new MockLlm('model-fallback');
    const routedLlm = new RoutedLlm({
      models: [failingModel, fallbackModel],
      router: (_models, _req, ctx) =>
        ctx?.failedKeys.has('model-failing')
          ? 'model-fallback'
          : 'model-failing',
    });
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const signal = new AbortController().signal;

    const generator = routedLlm.generateContentAsync(request, false, signal);
    await generator.next();

    expect(failingReceivedSignal).toBe(signal);
    expect(fallbackModel.receivedAbortSignal).toBe(signal);
  });

  it('delivers abortSignal from LlmAgent and InMemoryRunner to a routed Gemini model', async () => {
    let routedSignal: AbortSignal | undefined;
    const gemini = new Gemini({model: 'gemini-2.5-flash', apiKey: 'unused'});
    Object.defineProperty(gemini, 'apiClient', {
      value: {
        models: {
          generateContent: async (params: {
            config?: {abortSignal?: AbortSignal};
          }) => {
            routedSignal = params.config?.abortSignal;
            return {
              candidates: [{content: {role: 'model', parts: [{text: 'ok'}]}}],
            };
          },
        },
      },
    });

    const routed = new RoutedLlm({
      models: [gemini],
      router: (models) => Object.keys(models)[0],
    });
    const agent = new LlmAgent({
      name: 'a',
      model: routed,
      instruction: 'Be brief.',
    });
    const runner = new InMemoryRunner({agent, appName: 'repro'});
    const session = await runner.sessionService.createSession({
      appName: 'repro',
      userId: 'u',
    });
    const signal = new AbortController().signal;

    for await (const _ of runner.runAsync({
      userId: 'u',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'hi'}]},
      abortSignal: signal,
    })) {
      // drain
    }

    expect(routedSignal).toBe(signal);
  });
});
