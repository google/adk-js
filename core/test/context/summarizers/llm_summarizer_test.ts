/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Event,
  LlmRequest,
  LlmResponse,
  LlmSummarizer,
  createEvent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class MockLlm extends BaseLlm {
  constructor(private responses: LlmResponse[]) {
    super({model: 'mock-model'});
  }

  async *generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    for (const response of this.responses) {
      if (response.errorCode) {
        throw new Error(response.errorMessage || 'LLM Error');
      }
      yield response;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

describe('LlmSummarizer', () => {
  it('should summarize events using the LLM and return a CompactedEvent', async () => {
    const mockLlm = new MockLlm([
      {
        content: {
          role: 'model',
          parts: [{text: 'This is the summarized '}],
        },
      },
      {
        content: {
          role: 'model',
          parts: [{text: 'content from the LLM.'}],
        },
      },
    ]);

    const summarizer = new LlmSummarizer({llm: mockLlm as unknown as BaseLlm});

    const events: Event[] = [
      createEvent({
        author: 'user',
        timestamp: 1000,
        content: {role: 'user', parts: [{text: 'Hello'}]},
      }),
      createEvent({
        author: 'agent',
        timestamp: 2000,
        content: {role: 'model', parts: [{text: 'Hi there'}]},
      }),
    ];

    const compactedEvent = await summarizer.summarize(events);

    expect(compactedEvent.isCompacted).toBe(true);
    expect(compactedEvent.startTime).toBe(1000);
    expect(compactedEvent.endTime).toBe(2000);
    expect(compactedEvent.author).toBe('system');
    expect(compactedEvent.content?.role).toBe('model');
    expect(compactedEvent.compactedContent).toBe(
      'This is the summarized content from the LLM.',
    );
    expect(compactedEvent.content?.parts?.[0]?.text).toBe(
      'This is the summarized content from the LLM.',
    );
    expect(compactedEvent.id).toBeDefined();
  });

  it('should throw an error if the LLM fails to return valid summary', async () => {
    const mockLlm = new MockLlm([
      {
        // empty content
        content: {
          role: 'model',
          parts: [],
        },
      },
    ]);

    const summarizer = new LlmSummarizer({llm: mockLlm as unknown as BaseLlm});

    const events: Event[] = [
      createEvent({
        author: 'user',
        timestamp: 1000,
        content: {role: 'user', parts: [{text: 'Hello'}]},
      }),
    ];

    await expect(summarizer.summarize(events)).rejects.toThrow(
      'LLM failed to return a valid summary.',
    );
  });

  it('should throw an error when called with empty events list', async () => {
    const mockLlm = new MockLlm([]);
    const summarizer = new LlmSummarizer({llm: mockLlm as unknown as BaseLlm});

    await expect(summarizer.summarize([])).rejects.toThrow(
      'Cannot summarize an empty list of events.',
    );
  });
});
