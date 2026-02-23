/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  createEvent,
  Event,
  EventType,
  InMemoryArtifactService,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  Runner,
  toStructuredEvents,
} from '@google/adk';
import {Language, Outcome} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const TEST_APP_ID = 'test_app_id';
const TEST_USER_ID = 'test_user_id';

class MockLlmAgent extends LlmAgent {
  constructor(
    name: string,
    disallowTransferToParent = false,
    parentAgent?: BaseAgent,
  ) {
    super({
      name,
      model: 'gemini-2.5-flash',
      subAgents: [],
      parentAgent,
      disallowTransferToParent,
    });
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {
        role: 'model',
        parts: [
          {text: 'Test LLM response'},
          {functionCall: {name: 'test_tool', args: {}}},
        ],
      },
    });
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      // Simulate thought
      content: {
        role: 'model',
        parts: [{text: 'I am thinking', thought: true}],
      },
    });
  }
}

describe('Runner Streaming and Ephemeral', () => {
  let sessionService: InMemorySessionService;
  let artifactService: InMemoryArtifactService;
  let rootAgent: MockLlmAgent;
  let runner: Runner;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    artifactService = new InMemoryArtifactService();
    rootAgent = new MockLlmAgent('root_agent');

    runner = new Runner({
      appName: TEST_APP_ID,
      agent: rootAgent,
      sessionService,
      artifactService,
    });
  });

  describe('runEphemeral', () => {
    it('should run freely without managing session manually', async () => {
      const events = [];
      for await (const event of runner.runEphemeral({
        userId: TEST_USER_ID,
        newMessage: {role: 'user', parts: [{text: 'Hello'}]},
      })) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].id).toBeDefined();
    });

    it('should cleanup session after run', async () => {
      const generator = runner.runEphemeral({
        userId: TEST_USER_ID,
        newMessage: {role: 'user', parts: [{text: 'Hello'}]},
      });

      for await (const _ of generator) {
        // consume
      }

      const spy = vi.spyOn(sessionService, 'deleteSession');

      const generator2 = runner.runEphemeral({
        userId: TEST_USER_ID,
        newMessage: {role: 'user', parts: [{text: 'Hello'}]},
      });
      for await (const _ of generator2) {
        // consume
      }

      expect(spy).toHaveBeenCalled();
    });

    it('should initialize with stateDelta', async () => {
      const createSpy = vi.spyOn(sessionService, 'createSession');
      const events = [];
      for await (const event of runner.runEphemeral({
        userId: TEST_USER_ID,
        newMessage: {role: 'user', parts: [{text: 'Hello'}]},
        stateDelta: {foo: 'bar'},
      })) {
        events.push(event);
      }
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: TEST_USER_ID,
        }),
      );
    });
  });

  describe('toStructuredEvents', () => {
    it('should convert error events', () => {
      const event = createEvent({
        errorCode: '500',
        errorMessage: 'Test Error',
      });
      const results = toStructuredEvents(event);
      expect(results[0]).toEqual({
        type: EventType.ERROR,
        error: new Error('Test Error'),
      });
    });

    it('should convert content events', () => {
      const event = createEvent({
        invocationId: 'id',
        author: 'model',
        content: {role: 'model', parts: [{text: 'Hello'}]},
      });
      const results = toStructuredEvents(event);
      expect(results[0]).toEqual({
        type: EventType.CONTENT,
        content: 'Hello',
      });
    });

    it('should convert tool call events', () => {
      const event = createEvent({
        invocationId: 'id',
        author: 'model',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool', args: {}}}],
        },
      });
      const results = toStructuredEvents(event);
      expect(results[0]).toEqual({
        type: EventType.TOOL_CALL,
        call: {name: 'tool', args: {}},
      });
    });

    it('should convert tool response events', () => {
      const event = createEvent({
        invocationId: 'id',
        author: 'model',
        content: {
          role: 'model',
          parts: [{functionResponse: {name: 'tool', response: {}}}],
        },
      });
      const results = toStructuredEvents(event);
      expect(results[0]).toEqual({
        type: EventType.TOOL_RESULT,
        result: {name: 'tool', response: {}},
      });
    });

    it('should convert thought events', () => {
      const event = createEvent({
        invocationId: 'id',
        author: 'model',
        content: {
          role: 'model',
          parts: [{text: 'Thinking...', thought: true}],
        },
      });
      const results = toStructuredEvents(event);
      expect(results[0]).toEqual({
        type: EventType.THOUGHT,
        content: 'Thinking...',
      });
    });

    it('should convert code execution events', () => {
      const event = createEvent({
        invocationId: 'id',
        author: 'model',
        content: {
          role: 'model',
          parts: [
            {executableCode: {code: 'print("hi")', language: Language.PYTHON}},
          ],
        },
      });
      const results = toStructuredEvents(event);
      expect(results[0]).toEqual({
        type: EventType.CALL_CODE,
        code: {code: 'print("hi")', language: Language.PYTHON},
      });
    });

    it('should convert code result events', () => {
      const event = createEvent({
        invocationId: 'id',
        author: 'model',
        content: {
          role: 'model',
          parts: [
            {codeExecutionResult: {outcome: Outcome.OUTCOME_OK, output: 'hi'}},
          ],
        },
      });
      const results = toStructuredEvents(event);
      expect(results[0]).toEqual({
        type: EventType.CODE_RESULT,
        result: {outcome: Outcome.OUTCOME_OK, output: 'hi'},
      });
    });

    it('should include finished event when final', () => {
      const event = createEvent({
        invocationId: 'id',
        author: 'model',
        content: {role: 'model', parts: [{text: 'Bye'}]},
      });
      const results = toStructuredEvents(event);
      expect(results).toContainEqual({
        type: EventType.FINISHED,
        output: undefined,
      });
    });
  });
});
