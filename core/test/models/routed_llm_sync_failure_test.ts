/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {LlmAgent} from '../../src/agents/llm_agent.js';
import {BaseLlm} from '../../src/models/base_llm.js';
import {BaseLlmConnection} from '../../src/models/base_llm_connection.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';
import {RoutedLlm} from '../../src/models/routed_llm.js';
import {InMemoryRunner} from '../../src/runner/in_memory_runner.js';

function request(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

async function* localResponses(): AsyncGenerator<LlmResponse, void> {
  yield {content: {role: 'model', parts: [{text: 'local response'}]}};
}

function connection(): BaseLlmConnection {
  return {
    async sendHistory() {},
    async sendContent() {},
    async sendRealtime() {},
    receive: localResponses,
    async close() {},
  };
}

class LocalModel extends BaseLlm {
  connectModels: Array<string | undefined> = [];
  generateSignals: Array<AbortSignal | undefined> = [];

  constructor(
    name: string,
    private readonly implementation: {
      connect?: () => Promise<BaseLlmConnection>;
      generate?: () => AsyncGenerator<LlmResponse, void>;
    } = {},
  ) {
    super({model: name});
  }

  generateContentAsync(
    _request: LlmRequest,
    _stream?: boolean,
    signal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    this.generateSignals.push(signal);
    return this.implementation.generate?.() ?? localResponses();
  }

  connect(request: LlmRequest): Promise<BaseLlmConnection> {
    this.connectModels.push(request.model);
    return this.implementation.connect?.() ?? Promise.resolve(connection());
  }
}

function initializationFailure(kind: 'sync' | 'promise', error: Error) {
  return () => {
    if (kind === 'sync') throw error;
    return Promise.reject(error);
  };
}

describe('RoutedLlm connection initialization failures', () => {
  it.each(['sync', 'promise'] as const)(
    'fails over after a %s failure with the original error context',
    async (kind) => {
      const error = new Error('Local initialization failed');
      const backupConnection = connection();
      const primary = new LocalModel('primary-model', {
        connect: initializationFailure(kind, error),
      });
      const backup = new LocalModel('backup-model', {
        connect: () => Promise.resolve(backupConnection),
      });
      const contexts: Array<
        {failedKeys: string[]; lastError: unknown} | undefined
      > = [];
      const routed = new RoutedLlm({
        models: {primary, backup},
        router: (_models, _request, context) => {
          contexts.push(
            context && {
              failedKeys: [...context.failedKeys],
              lastError: context.lastError,
            },
          );
          return context ? 'backup' : 'primary';
        },
      });

      expect(await routed.connect(request())).toBe(backupConnection);
      expect(contexts).toEqual([
        undefined,
        {failedKeys: ['primary'], lastError: error},
      ]);
      expect(contexts[1]?.lastError).toBe(error);
      expect(primary.connectModels).toEqual(['primary-model']);
      expect(backup.connectModels).toEqual(['backup-model']);
    },
  );

  it('does not retry a successful connection', async () => {
    const primaryConnection = connection();
    const primary = new LocalModel('primary-model', {
      connect: () => Promise.resolve(primaryConnection),
    });
    const backup = new LocalModel('backup-model');
    let routerCalls = 0;
    const routed = new RoutedLlm({
      models: {primary, backup},
      router: () => {
        routerCalls++;
        return 'primary';
      },
    });

    expect(await routed.connect(request())).toBe(primaryConnection);
    expect(routerCalls).toBe(1);
    expect(backup.connectModels).toEqual([]);
  });

  it.each(['sync', 'promise'] as const)(
    'propagates the original %s failure when the router declines failover',
    async (kind) => {
      const error = new Error('No fallback available');
      const primary = new LocalModel('primary-model', {
        connect: initializationFailure(kind, error),
      });
      const backup = new LocalModel('backup-model');
      const routed = new RoutedLlm({
        models: {primary, backup},
        router: (_models, _request, context) =>
          context ? undefined : 'primary',
      });

      await expect(routed.connect(request())).rejects.toBe(error);
      expect(backup.connectModels).toEqual([]);
    },
  );

  it('does not retry an already-tried route after a synchronous failure', async () => {
    const error = new Error('Repeated route failed');
    const primary = new LocalModel('primary-model', {
      connect: initializationFailure('sync', error),
    });
    let routerCalls = 0;
    const routed = new RoutedLlm({
      models: {primary},
      router: () => {
        routerCalls++;
        return 'primary';
      },
    });

    await expect(routed.connect(request())).rejects.toBe(error);
    expect(primary.connectModels).toHaveLength(1);
    expect(routerCalls).toBe(2);
  });

  it('handles a synchronous failure on a later attempt without losing tried keys', async () => {
    const firstError = new Error('Primary rejected');
    const secondError = new Error('Secondary initialization failed');
    const finalConnection = connection();
    const primary = new LocalModel('primary-model', {
      connect: initializationFailure('promise', firstError),
    });
    const secondary = new LocalModel('secondary-model', {
      connect: initializationFailure('sync', secondError),
    });
    const backup = new LocalModel('backup-model', {
      connect: () => Promise.resolve(finalConnection),
    });
    const contexts: Array<{failedKeys: string[]; lastError: unknown}> = [];
    const routed = new RoutedLlm({
      models: {primary, secondary, backup},
      router: (_models, _request, context) => {
        if (!context) return 'primary';
        contexts.push({
          failedKeys: [...context.failedKeys],
          lastError: context.lastError,
        });
        return context.failedKeys.has('secondary') ? 'backup' : 'secondary';
      },
    });

    expect(await routed.connect(request())).toBe(finalConnection);
    expect(contexts.map((context) => context.failedKeys)).toEqual([
      ['primary'],
      ['primary', 'secondary'],
    ]);
    expect(contexts[0].lastError).toBe(firstError);
    expect(contexts[1].lastError).toBe(secondError);
    expect(primary.connectModels).toHaveLength(1);
    expect(secondary.connectModels).toHaveLength(1);
    expect(backup.connectModels).toHaveLength(1);
  });

  it('propagates an initial router failure without invoking a model', async () => {
    const error = new Error('Initial router failed');
    const primary = new LocalModel('primary-model');
    const routed = new RoutedLlm({
      models: {primary},
      router: () => {
        throw error;
      },
    });

    await expect(routed.connect(request())).rejects.toBe(error);
    expect(primary.connectModels).toEqual([]);
  });

  it('propagates a fallback router failure without retrying it', async () => {
    const modelError = new Error('Model initialization failed');
    const routerError = new Error('Fallback router failed');
    const primary = new LocalModel('primary-model', {
      connect: initializationFailure('promise', modelError),
    });
    const backup = new LocalModel('backup-model');
    let routerCalls = 0;
    const routed = new RoutedLlm({
      models: {primary, backup},
      router: (_models, _request, context) => {
        routerCalls++;
        if (context) throw routerError;
        return 'primary';
      },
    });

    await expect(routed.connect(request())).rejects.toBe(routerError);
    expect(routerCalls).toBe(2);
    expect(backup.connectModels).toEqual([]);
  });
});

describe('RoutedLlm generation error boundaries', () => {
  it('fails over a synchronous generator initialization error through a real Runner', async () => {
    const error = new Error('Local generation initialization failed');
    const primary = new LocalModel('primary-model', {
      generate: () => {
        throw error;
      },
    });
    const backup = new LocalModel('backup-model');
    const errors: unknown[] = [];
    const routed = new RoutedLlm({
      models: {primary, backup},
      router: (_models, _request, context) => {
        if (!context) return 'primary';
        errors.push(context.lastError);
        expect([...context.failedKeys]).toEqual(['primary']);
        return 'backup';
      },
    });
    const runner = new InMemoryRunner({
      appName: 'routing-test',
      agent: new LlmAgent({name: 'agent', model: routed}),
    });
    const session = await runner.sessionService.createSession({
      appName: 'routing-test',
      userId: 'user',
    });
    const signal = new AbortController().signal;
    const parts = [];
    for await (const event of runner.runAsync({
      userId: 'user',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'hello'}]},
      abortSignal: signal,
    })) {
      parts.push(...(event.content?.parts ?? []));
    }
    expect(parts.map((part) => part.text)).toContain('local response');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(error);
    expect(primary.generateSignals).toEqual([signal]);
    expect(backup.generateSignals).toEqual([signal]);
  });

  it('does not fail over after generation has yielded output', async () => {
    const error = new Error('Failure after output');
    const primary = new LocalModel('primary-model', {
      generate: async function* () {
        yield {
          content: {role: 'model', parts: [{text: 'partial'}]},
          partial: true,
        };
        throw error;
      },
    });
    const backup = new LocalModel('backup-model');
    let routerCalls = 0;
    const routed = new RoutedLlm({
      models: {primary, backup},
      router: (_models, _request, context) => {
        routerCalls++;
        return context ? 'backup' : 'primary';
      },
    });
    const iterator = routed.generateContentAsync(request());

    expect((await iterator.next()).value?.content?.parts?.[0].text).toBe(
      'partial',
    );
    await expect(iterator.next()).rejects.toBe(error);
    expect(routerCalls).toBe(1);
    expect(backup.generateSignals).toEqual([]);
  });

  it('closes the delegate when the consumer returns without starting a fallback', async () => {
    let closed = false;
    const primary = new LocalModel('primary-model', {
      generate: async function* () {
        try {
          yield {content: {parts: [{text: 'partial'}]}, partial: true};
        } finally {
          closed = true;
        }
      },
    });
    const backup = new LocalModel('backup-model');
    const routed = new RoutedLlm({
      models: {primary, backup},
      router: (_models, _request, context) => (context ? 'backup' : 'primary'),
    });
    const iterator = routed.generateContentAsync(request());

    await iterator.next();
    await iterator.return();
    expect(closed).toBe(true);
    expect(backup.generateSignals).toEqual([]);
  });

  it('preserves an abort failure when the router declines retry', async () => {
    const abortError = new DOMException(
      'Local generation aborted',
      'AbortError',
    );
    // Use the same explicit abort reason in the signal and expected rejection.
    const aborted = AbortSignal.abort(abortError);
    const aborting = new LocalModel('aborting-model', {
      generate: async function* () {
        aborted.throwIfAborted();
        yield {};
      },
    });
    const backup = new LocalModel('backup-model');
    const routed = new RoutedLlm({
      models: {primary: aborting, backup},
      router: (_models, _request, context) => (context ? undefined : 'primary'),
    });

    await expect(
      routed.generateContentAsync(request(), false, aborted).next(),
    ).rejects.toBe(abortError);
    expect(aborting.generateSignals).toEqual([aborted]);
    expect(backup.generateSignals).toEqual([]);
  });
});
