/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  BaseAgent,
  createEvent,
  Event,
  EventType,
  InMemoryArtifactService,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  parseEvent,
  Runner,
} from '../../src/common.js';

const TEST_APP_ID = 'test_app_id';
const TEST_USER_ID = 'test_user_id';
const TEST_SESSION_ID = 'test_session_id';

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parts: [{text: 'I am thinking', thought: true} as any],
      },
    });
  }
}

describe('Runner Streaming and Stateless', () => {
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

  describe('runStream', () => {
    it('should yield native Events', async () => {
      const session = await sessionService.createSession({
        appName: TEST_APP_ID,
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
      });

      const events = [];
      for await (const event of runner.runStream({
        userId: session.userId,
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'Hello'}]},
      })) {
        events.push(event);
      }

      // Check that it returned events with valid properties
      expect(events.length).toBeGreaterThan(0);
      expect(
        events.some((e) => e.content?.parts[0].text === 'Test LLM response'),
      ).toBe(true);
      expect(
        events.some((e) => e.content?.parts[0].text === 'I am thinking'),
      ).toBe(true);
    });
  });

  describe('runStateless', () => {
    it('should run freely without managing session manually', async () => {
      const events = [];
      for await (const event of runner.runStateless({
        userId: TEST_USER_ID,
        newMessage: {role: 'user', parts: [{text: 'Hello'}]},
      })) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].id).toBeDefined();
    });

    it('should cleanup session after run', async () => {
      const generator = runner.runStateless({
        userId: TEST_USER_ID,
        newMessage: {role: 'user', parts: [{text: 'Hello'}]},
      });

      for await (const _ of generator) {
        // consume
      }

      const spy = vi.spyOn(sessionService, 'deleteSession');

      const generator2 = runner.runStateless({
        userId: TEST_USER_ID,
        newMessage: {role: 'user', parts: [{text: 'Hello'}]},
      });
      for await (const _ of generator2) {
        // consume
      }

      expect(spy).toHaveBeenCalled();
    });
  });

  describe('parseEvent', () => {
    it('should convert error events', () => {
      const event = createEvent({
        invocationId: 'id',
        author: 'model',
        content: {role: 'system', parts: [{text: 'Test Error'}]},
      });
      const generator = parseEvent(event);
      const result = generator.next().value;
      expect(result).toEqual({
        type: EventType.ERROR,
        error: new Error('Agent error: Test Error'),
      });
    });

    it('should convert content events', () => {
      const event = createEvent({
        invocationId: 'id',
        author: 'model',
        content: {role: 'model', parts: [{text: 'Hello'}]},
      });
      const generator = parseEvent(event);
      const result = generator.next().value;
      expect(result).toEqual({
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
      const generator = parseEvent(event);
      const result = generator.next().value;
      expect(result).toEqual({
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
      const generator = parseEvent(event);
      const result = generator.next().value;
      expect(result).toEqual({
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          parts: [{text: 'Thinking...', thought: true} as any],
        },
      });
      const generator = parseEvent(event);
      const result = generator.next().value;
      expect(result).toEqual({
        type: EventType.THOUGHT,
        content: 'Thinking...',
      });
    });
  });
});
