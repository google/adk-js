/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GroundingMetadata, LiveServerGoAway} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {LiveResponseAggregator} from '../../src/utils/live_connection_utils.js';

describe('LiveResponseAggregator', () => {
  it('should yield usage metadata', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');
    const usageMetadata = {
      promptTokenCount: 10,
      candidatesTokenCount: 20,
      totalTokenCount: 30,
    };

    const generator = aggregator.processMessage({usageMetadata});
    const results = Array.from(generator);

    expect(results).toEqual([
      {
        usageMetadata,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should stream text and yield full response on turnComplete', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    // Message 1: partial text
    const gen1 = aggregator.processMessage({
      serverContent: {
        modelTurn: {
          parts: [{text: 'Hello'}],
        },
      },
    });
    const res1 = Array.from(gen1);
    expect(res1).toEqual([
      {
        content: {parts: [{text: 'Hello'}]},
        modelVersion: 'gemini-2.5-flash',
        partial: true,
      },
    ]);

    // Message 2: partial text and turnComplete
    const gen2 = aggregator.processMessage({
      serverContent: {
        modelTurn: {
          parts: [{text: ' world!'}],
        },
        turnComplete: true,
        interrupted: false,
        groundingMetadata: {groundingChunks: []} as GroundingMetadata,
      },
    });
    const res2 = Array.from(gen2);
    expect(res2).toEqual([
      {
        content: {parts: [{text: ' world!'}]},
        modelVersion: 'gemini-2.5-flash',
        partial: true,
        interrupted: false,
      },
      {
        content: {
          role: 'model',
          parts: [{text: 'Hello world!'}],
        },
        partial: false,
        modelVersion: 'gemini-2.5-flash',
        groundingMetadata: {groundingChunks: []},
      },
      {
        turnComplete: true,
        modelVersion: 'gemini-2.5-flash',
        interrupted: false,
        groundingMetadata: {groundingChunks: []},
      },
    ]);
  });

  it('should flush text when transitioning between thought and non-thought', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    // Message 1: thought
    const res1 = Array.from(
      aggregator.processMessage({
        serverContent: {
          modelTurn: {
            parts: [{text: 'Thinking...', thought: true}],
          },
        },
      }),
    );
    expect(res1).toEqual([
      {
        content: {parts: [{text: 'Thinking...', thought: true}]},
        modelVersion: 'gemini-2.5-flash',
        partial: true,
      },
    ]);

    // Message 2: transition to text
    const res2 = Array.from(
      aggregator.processMessage({
        serverContent: {
          modelTurn: {
            parts: [{text: 'Answer is 42.'}],
          },
        },
      }),
    );
    expect(res2).toEqual([
      {
        content: {
          role: 'model',
          parts: [{text: 'Thinking...', thought: true}],
        },
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      },
      {
        content: {parts: [{text: 'Answer is 42.'}]},
        modelVersion: 'gemini-2.5-flash',
        partial: true,
      },
    ]);

    // Message 3: turn complete
    const res3 = Array.from(
      aggregator.processMessage({
        serverContent: {
          turnComplete: true,
        },
      }),
    );
    expect(res3).toEqual([
      {
        content: {
          role: 'model',
          parts: [{text: 'Answer is 42.'}],
        },
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      },
      {
        turnComplete: true,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should handle input transcription partial and finished', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    const res1 = Array.from(
      aggregator.processMessage({
        serverContent: {
          inputTranscription: {text: 'hello', finished: false},
        },
      }),
    );
    expect(res1).toEqual([
      {
        inputTranscription: {text: 'hello', finished: false},
        partial: true,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);

    const res2 = Array.from(
      aggregator.processMessage({
        serverContent: {
          inputTranscription: {text: ' world', finished: true},
        },
      }),
    );
    expect(res2).toEqual([
      {
        inputTranscription: {text: ' world', finished: false},
        partial: true,
        modelVersion: 'gemini-2.5-flash',
      },
      {
        inputTranscription: {text: 'hello world', finished: true},
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should flush pending transcription on interrupted', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    const res1 = Array.from(
      aggregator.processMessage({
        serverContent: {
          inputTranscription: {text: 'hello', finished: false},
        },
      }),
    );
    expect(res1[0].inputTranscription).toEqual({
      text: 'hello',
      finished: false,
    });

    const res2 = Array.from(
      aggregator.processMessage({
        serverContent: {
          interrupted: true,
        },
      }),
    );
    expect(res2).toEqual([
      {
        inputTranscription: {text: 'hello', finished: true},
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      },
      {
        interrupted: true,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should yield groundingMetadata on partial response', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    const res1 = Array.from(
      aggregator.processMessage({
        serverContent: {
          modelTurn: {
            parts: [{text: 'Partial text'}],
          },
          groundingMetadata: {
            groundingChunks: [
              {web: {uri: 'https://google.com', title: 'Google'}},
            ],
          } as GroundingMetadata,
        },
      }),
    );
    expect(res1).toEqual([
      {
        content: {parts: [{text: 'Partial text'}]},
        partial: true,
        modelVersion: 'gemini-2.5-flash',
        groundingMetadata: {
          groundingChunks: [
            {web: {uri: 'https://google.com', title: 'Google'}},
          ],
        },
      },
    ]);
  });

  it('should buffer tool calls and yield at turnComplete for non-Gemini 3.x', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    const res1 = Array.from(
      aggregator.processMessage({
        toolCall: {
          functionCalls: [{name: 'tool_a', args: {x: 1}, id: '1'}],
        },
      }),
    );
    expect(res1).toEqual([]); // Buffered

    const res2 = Array.from(
      aggregator.processMessage({
        serverContent: {
          turnComplete: true,
        },
      }),
    );
    expect(res2).toEqual([
      {
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool_a', args: {x: 1}, id: '1'}}],
        },
        modelVersion: 'gemini-2.5-flash',
      },
      {
        turnComplete: true,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should yield tool calls immediately for Gemini 3.x', () => {
    const aggregator = new LiveResponseAggregator('gemini-3.1-flash-live');

    const res1 = Array.from(
      aggregator.processMessage({
        toolCall: {
          functionCalls: [{name: 'tool_a', args: {x: 1}, id: '1'}],
        },
      }),
    );
    expect(res1).toEqual([
      {
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool_a', args: {x: 1}, id: '1'}}],
        },
        modelVersion: 'gemini-3.1-flash-live',
      },
    ]);
  });

  it('should yield session resumption update', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');
    const resumptionUpdate = {resumed: true};

    const res = Array.from(
      aggregator.processMessage({sessionResumptionUpdate: resumptionUpdate}),
    );
    expect(res).toEqual([
      {
        liveSessionResumptionUpdate: resumptionUpdate,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should yield go away', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');
    const goAway = {goAway: true};

    const res = Array.from(
      aggregator.processMessage({goAway: goAway as LiveServerGoAway}),
    );
    expect(res).toEqual([
      {
        goAway,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });
});
