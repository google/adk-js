/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  BaseAgent,
  BaseLlm,
  createRunConfig,
  Event,
  EventActions,
  Gemini,
  INTERACTIONS_REQUEST_PROCESSOR,
  InteractionsRequestProcessor,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  ServiceTier,
  Session,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {logger} from '../../../src/utils/logger.js';

class MockLlm extends BaseLlm {
  constructor() {
    super({model: 'mock-model'});
  }

  override async *generateContentAsync(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    llmRequest: LlmRequest,
  ): AsyncGenerator<any, void, void> {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async connect(llmRequest: LlmRequest): Promise<any> {
    return {} as any;
  }
}

function createMockEvent(
  id: string,
  author: string,
  branch: string,
  interactionId?: string,
): Event {
  return {
    id,
    invocationId: 'test-invoc',
    author,
    branch,
    interactionId,
    actions: {} as EventActions,
    timestamp: Date.now(),
  };
}

function createMockInvocationContext(
  events: Event[],
  model: any,
  agentName = 'test_agent',
  serviceTier?: ServiceTier | string,
  invocationId = 'test-invocation',
): InvocationContext {
  const session = {
    id: 'test-session',
    events,
    appName: 'test-app',
    userId: 'test-user',
  } as unknown as Session;

  const agent = new LlmAgent({
    name: agentName,
    model: model,
  });

  return new InvocationContext({
    invocationId,
    agent: agent as BaseAgent,
    session,
    pluginManager: new PluginManager([]),
    runConfig: serviceTier ? createRunConfig({serviceTier}) : createRunConfig(),
  });
}

describe('InteractionsRequestProcessor', () => {
  it('should not set previousInteractionId if model is not Gemini', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 'test_agent', 'main', 'int-1'),
    ];
    const mockModel = new MockLlm();
    const invocationContext = createMockInvocationContext(rawEvents, mockModel);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.previousInteractionId).toBeUndefined();
  });

  it('should not set previousInteractionId if model is Gemini but useInteractionsApi is false', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 'test_agent', 'main', 'int-1'),
    ];
    const geminiModel = new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: 'dummy',
      useInteractionsApi: false,
    });
    const invocationContext = createMockInvocationContext(
      rawEvents,
      geminiModel,
    );
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.previousInteractionId).toBeUndefined();
  });

  it('should set previousInteractionId to latest interactionId from history if model is Gemini and useInteractionsApi is true', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 'test_agent', 'main', 'int-1'),
      createMockEvent('2', 'test_agent', 'main', 'int-2'),
    ];
    const geminiModel = new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: 'dummy',
      useInteractionsApi: true,
    });
    const invocationContext = createMockInvocationContext(
      rawEvents,
      geminiModel,
    );
    invocationContext.branch = 'main';
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.previousInteractionId).toBe('int-2');
  });

  it('should ignore events from other branches', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 'test_agent', 'other-branch', 'int-1'),
      createMockEvent('2', 'test_agent', 'main', 'int-2'),
    ];
    const geminiModel = new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: 'dummy',
      useInteractionsApi: true,
    });
    const invocationContext = createMockInvocationContext(
      rawEvents,
      geminiModel,
    );
    invocationContext.branch = 'main';

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.previousInteractionId).toBe('int-2');
  });

  it('should ignore events from other authors', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 'other_agent', 'main', 'int-1'),
      createMockEvent('2', 'test_agent', 'main', 'int-2'),
    ];
    const geminiModel = new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: 'dummy',
      useInteractionsApi: true,
    });
    const invocationContext = createMockInvocationContext(
      rawEvents,
      geminiModel,
      'test_agent',
    );
    invocationContext.branch = 'main';
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.previousInteractionId).toBe('int-2');
  });

  it('should do nothing if agent is not LlmAgent', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 'test_agent', 'main', 'int-1'),
    ];
    const invocationContext = createMockInvocationContext(
      rawEvents,
      new MockLlm(),
    );
    (invocationContext as any).agent = {name: 'not-an-llm-agent'};
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.previousInteractionId).toBeUndefined();
  });

  it('should copy runConfig.serviceTier onto llmRequest when useInteractionsApi is true', async () => {
    const processor = new InteractionsRequestProcessor();
    const geminiModel = new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: 'dummy',
      useInteractionsApi: true,
    });
    const invocationContext = createMockInvocationContext(
      [],
      geminiModel,
      'test_agent',
      ServiceTier.DEFERRED,
    );
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of processor.runAsync(invocationContext, llmRequest)) {
      // intentionally empty
    }

    expect(llmRequest.serviceTier).toBe('deferred');
  });

  it('should leave llmRequest.serviceTier undefined when runConfig.serviceTier is unset', async () => {
    const processor = new InteractionsRequestProcessor();
    const geminiModel = new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: 'dummy',
      useInteractionsApi: true,
    });
    const invocationContext = createMockInvocationContext([], geminiModel);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of processor.runAsync(invocationContext, llmRequest)) {
      // intentionally empty
    }

    expect(llmRequest.serviceTier).toBeUndefined();
  });

  it('should not copy serviceTier and should warn once per invocationId when useInteractionsApi is false', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const processor = new InteractionsRequestProcessor();
      const geminiModel = new Gemini({
        model: 'gemini-2.5-flash',
        apiKey: 'dummy',
        useInteractionsApi: false,
      });

      for (let i = 0; i < 3; i++) {
        const invocationContext = createMockInvocationContext(
          [],
          geminiModel,
          'test_agent',
          ServiceTier.DEFERRED,
          'inv-same',
        );
        const llmRequest: LlmRequest = {
          contents: [],
          toolsDict: {},
          liveConnectConfig: {},
        };
        for await (const _ of processor.runAsync(
          invocationContext,
          llmRequest,
        )) {
          // intentionally empty
        }
        expect(llmRequest.serviceTier).toBeUndefined();
      }

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('runConfig.serviceTier');

      // Different invocationId should warn again
      const nextInvocationContext = createMockInvocationContext(
        [],
        geminiModel,
        'test_agent',
        ServiceTier.DEFERRED,
        'inv-different',
      );
      for await (const _ of processor.runAsync(nextInvocationContext, {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      })) {
        // intentionally empty
      }

      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
