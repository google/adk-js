/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  A2AEvent,
  createMessage,
  createTaskArtifactUpdateEvent,
  createTaskCompletedEvent,
  createTextPart,
  Role,
} from '../../src/a2a/a2a_event.js';
import {A2ARemoteAgentRunProcessor} from '../../src/a2a/a2a_remote_agent_run_processor.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {createEvent} from '../../src/events/event.js';

describe('A2ARemoteAgentRunProcessor', () => {
  const createMockContext = (): InvocationContext => {
    return {
      invocationId: 'test-invocation',
      agent: {name: 'test-agent'},
      session: {appName: 'test-app', userId: 'user-1', id: 'sess-1'},
    } as unknown as InvocationContext;
  };

  it('should collapse contiguous text parts', () => {
    const processor = new A2ARemoteAgentRunProcessor();
    const context = createMockContext();

    const a2aEvent1: A2AEvent = createTaskArtifactUpdateEvent({
      taskId: 't1',
      contextId: 'c1',
      artifactId: 'art-1',
      append: true,
      lastChunk: false,
    });
    const adkEvent1 = createEvent({
      content: {role: 'model', parts: [{text: 'Hello'}]},
    });

    const a2aEvent2: A2AEvent = createTaskArtifactUpdateEvent({
      taskId: 't1',
      contextId: 'c1',
      artifactId: 'art-1',
      append: true,
      lastChunk: true,
    });
    const adkEvent2 = createEvent({
      content: {role: 'model', parts: [{text: ' World'}]},
    });

    const result1 = processor.aggregatePartial(context, a2aEvent1, adkEvent1);
    expect(result1.length).toBe(1);
    expect(result1[0]).toBe(adkEvent1);

    const result2 = processor.aggregatePartial(context, a2aEvent2, adkEvent2);
    expect(result2.length).toBe(2);
    expect(result2[1].content?.parts?.length).toBe(1);
    expect(result2[1].content?.parts?.[0].text).toBe('Hello World');
    expect(result2[1].partial).toBe(false);
  });

  it('should collapse contiguous thoughts', () => {
    const processor = new A2ARemoteAgentRunProcessor();
    const context = createMockContext();

    const a2aEvent1: A2AEvent = createTaskArtifactUpdateEvent({
      taskId: 't1',
      contextId: 'c1',
      artifactId: 'art-1',
      append: true,
      lastChunk: false,
    });
    const adkEvent1 = createEvent({
      content: {role: 'model', parts: [{thought: true, text: 'Thinking'}]},
    });

    const a2aEvent2: A2AEvent = createTaskArtifactUpdateEvent({
      taskId: 't1',
      contextId: 'c1',
      artifactId: 'art-1',
      append: true,
      lastChunk: true,
    });
    const adkEvent2 = createEvent({
      content: {role: 'model', parts: [{thought: true, text: ' hard'}]},
    });

    processor.aggregatePartial(context, a2aEvent1, adkEvent1);
    const result2 = processor.aggregatePartial(context, a2aEvent2, adkEvent2);

    expect(result2[1].content?.parts?.[0].text).toBe('Thinking hard');
    expect(result2[1].content?.parts?.[0].thought).toBe(true);
  });

  it('should aggregate citations', () => {
    const processor = new A2ARemoteAgentRunProcessor();
    const context = createMockContext();

    const a2aEvent1: A2AEvent = createTaskArtifactUpdateEvent({
      taskId: 't1',
      contextId: 'c1',
      artifactId: 'art-1',
      append: true,
      lastChunk: false,
    });
    const adkEvent1 = createEvent({
      citationMetadata: {citations: [{uri: 'http://a.com'}]},
    });

    const a2aEvent2: A2AEvent = createTaskArtifactUpdateEvent({
      taskId: 't1',
      contextId: 'c1',
      artifactId: 'art-1',
      append: true,
      lastChunk: true,
    });
    const adkEvent2 = createEvent({
      citationMetadata: {citations: [{uri: 'http://b.com'}]},
    });

    processor.aggregatePartial(context, a2aEvent1, adkEvent1);
    const result2 = processor.aggregatePartial(context, a2aEvent2, adkEvent2);

    const aggregated = result2[1];
    expect(aggregated.citationMetadata?.citations?.length).toBe(2);
    expect(aggregated.citationMetadata?.citations?.[0].uri).toBe(
      'http://a.com',
    );
    expect(aggregated.citationMetadata?.citations?.[1].uri).toBe(
      'http://b.com',
    );
  });

  it('should merge custom metadata', () => {
    const processor = new A2ARemoteAgentRunProcessor();
    const context = createMockContext();

    const a2aEvent1: A2AEvent = createTaskArtifactUpdateEvent({
      taskId: 't1',
      contextId: 'c1',
      artifactId: 'art-1',
      append: true,
      lastChunk: false,
    });
    const adkEvent1 = createEvent({
      customMetadata: {foo: 'bar'},
    });

    const a2aEvent2: A2AEvent = createTaskArtifactUpdateEvent({
      taskId: 't1',
      contextId: 'c1',
      artifactId: 'art-1',
      append: true,
      lastChunk: true,
    });
    const adkEvent2 = createEvent({
      customMetadata: {baz: 'qux'},
    });

    processor.aggregatePartial(context, a2aEvent1, adkEvent1);
    const result2 = processor.aggregatePartial(context, a2aEvent2, adkEvent2);

    const aggregated = result2[1];
    expect(aggregated.customMetadata).toEqual({foo: 'bar', baz: 'qux'});
  });

  it('should emit aggregated events on final status update', () => {
    const processor = new A2ARemoteAgentRunProcessor();
    const context = createMockContext();

    const a2aEvent1: A2AEvent = createTaskArtifactUpdateEvent({
      taskId: 't1',
      contextId: 'c1',
      artifactId: 'art-1',
      append: true,
      lastChunk: false,
    });
    const adkEvent1 = createEvent({content: {parts: [{text: 'art 1'}]}});

    const a2aEvent2: A2AEvent = createTaskArtifactUpdateEvent({
      taskId: 't2',
      contextId: 'c2',
      artifactId: 'art-2',
      append: true,
      lastChunk: false,
    });
    const adkEvent2 = createEvent({content: {parts: [{text: 'art 2'}]}});

    processor.aggregatePartial(context, a2aEvent1, adkEvent1);
    processor.aggregatePartial(context, a2aEvent2, adkEvent2);

    const finalEvent: A2AEvent = createTaskCompletedEvent({
      taskId: 't',
      contextId: 'c',
    });
    const finalAdkEvent = createEvent({turnComplete: true});

    const result = processor.aggregatePartial(
      context,
      finalEvent,
      finalAdkEvent,
    );

    expect(result.length).toBe(3);
    expect(result[0].content?.parts?.[0].text).toBe('art 1');
    expect(result[1].content?.parts?.[0].text).toBe('art 2');
    expect(result[2]).toBe(finalAdkEvent);
  });

  describe('updateCustomMetadata', () => {
    it('records a2a:context_id on a Message without taskId', () => {
      const processor = new A2ARemoteAgentRunProcessor();
      const event = createEvent({turnComplete: true});
      const response: A2AEvent = createMessage({
        messageId: 'msg-1',
        role: Role.ROLE_AGENT,
        contextId: 'ctx-message-only',
        parts: [createTextPart('hello')],
      });

      processor.updateCustomMetadata(event, response);

      expect(event.customMetadata).toEqual({
        'a2a:response': {
          messageId: 'msg-1',
          contextId: 'ctx-message-only',
          role: 'ROLE_AGENT',
          parts: [{text: 'hello'}],
        },
        'a2a:context_id': 'ctx-message-only',
      });
    });

    it('records both task_id and context_id on a Message with taskId', () => {
      const processor = new A2ARemoteAgentRunProcessor();
      const event = createEvent({turnComplete: true});
      const response: A2AEvent = createMessage({
        messageId: 'msg-2',
        role: Role.ROLE_AGENT,
        taskId: 'task-1',
        contextId: 'ctx-1',
        parts: [createTextPart('hello')],
      });

      processor.updateCustomMetadata(event, response);

      expect(event.customMetadata).toEqual({
        'a2a:response': {
          messageId: 'msg-2',
          contextId: 'ctx-1',
          taskId: 'task-1',
          role: 'ROLE_AGENT',
          parts: [{text: 'hello'}],
        },
        'a2a:task_id': 'task-1',
        'a2a:context_id': 'ctx-1',
      });
    });
  });
});
