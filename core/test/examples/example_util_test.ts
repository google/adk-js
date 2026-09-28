/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {createEvent} from '../../src/events/event.js';
import {BaseExampleProvider} from '../../src/examples/base_example_provider.js';
import {Example} from '../../src/examples/example.js';
import {
  _getLatestMessageFromUser,
  buildExampleSi,
  convertExamplesToText,
  getLatestMessageFromUser,
} from '../../src/examples/example_util.js';
import {createSession} from '../../src/sessions/session.js';
import {logger} from '../../src/utils/logger.js';

class FixedExampleProvider extends BaseExampleProvider {
  constructor(private readonly examples: Example[]) {
    super();
  }
  override async getExamples(_query: string): Promise<Example[]> {
    return this.examples;
  }
}

const SIMPLE_EXAMPLE: Example = {
  input: {parts: [{text: 'What is 2+2?'}]},
  output: [{role: 'model', parts: [{text: '4'}]}],
};

const FUNCTION_CALL_EXAMPLE: Example = {
  input: {parts: [{text: 'Search for cats'}]},
  output: [
    {
      role: 'model',
      parts: [{functionCall: {name: 'search', args: {query: 'cats'}}}],
    },
    {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'search',
            response: {results: ['cat1', 'cat2']},
          },
        },
      ],
    },
    {role: 'model', parts: [{text: 'Found cats!'}]},
  ],
};

describe('convertExamplesToText', () => {
  it('returns a string with EXAMPLES wrapper for empty examples array', () => {
    const result = convertExamplesToText([]);
    expect(result).toContain('<EXAMPLES>');
    expect(result).toContain('End few-shot');
  });

  it('includes the example number and user input', () => {
    const result = convertExamplesToText([SIMPLE_EXAMPLE]);
    expect(result).toContain('EXAMPLE 1:');
    expect(result).toContain('What is 2+2?');
    expect(result).toContain('4');
  });

  it('numbers multiple examples sequentially', () => {
    const result = convertExamplesToText([SIMPLE_EXAMPLE, SIMPLE_EXAMPLE]);
    expect(result).toContain('EXAMPLE 1:');
    expect(result).toContain('EXAMPLE 2:');
  });

  it('uses plain backtick prefix for function calls when model is gemini-2', () => {
    const result = convertExamplesToText(
      [FUNCTION_CALL_EXAMPLE],
      'gemini-2.0-flash',
    );
    expect(result).toContain("```\nsearch(query='cats')");
  });

  it('uses tool_code prefix for function calls when model is not gemini-2', () => {
    const result = convertExamplesToText(
      [FUNCTION_CALL_EXAMPLE],
      'gemini-1.5-pro',
    );
    expect(result).toContain("```tool_code\nsearch(query='cats')");
  });

  it('uses plain backtick prefix when model is undefined (defaults to gemini-2 path)', () => {
    const result = convertExamplesToText([FUNCTION_CALL_EXAMPLE]);
    expect(result).toContain("```\nsearch(query='cats')");
  });

  it('includes function response in output', () => {
    const result = convertExamplesToText([FUNCTION_CALL_EXAMPLE]);
    expect(result).toContain('search');
    expect(result).toContain('Found cats!');
  });

  it('handles examples with no input parts', () => {
    const example: Example = {
      input: {parts: []},
      output: [{role: 'model', parts: [{text: 'response'}]}],
    };
    const result = convertExamplesToText([example]);
    expect(result).toContain('response');
  });
});

describe('buildExampleSi', () => {
  it('delegates to convertExamplesToText when given an array', async () => {
    const result = await buildExampleSi(
      [SIMPLE_EXAMPLE],
      'query',
      'gemini-2.0-flash',
    );
    expect(result).toContain('What is 2+2?');
    expect(result).toContain('4');
  });

  it('calls getExamples on a BaseExampleProvider', async () => {
    const provider = new FixedExampleProvider([SIMPLE_EXAMPLE]);
    const result = await buildExampleSi(provider, 'my query');
    expect(result).toContain('What is 2+2?');
  });

  it('passes the model string through to the provider path', async () => {
    const provider = new FixedExampleProvider([FUNCTION_CALL_EXAMPLE]);
    const result = await buildExampleSi(provider, 'query', 'gemini-1.5-pro');
    expect(result).toContain('```tool_code');
  });

  it('throws an error for invalid input', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(buildExampleSi({} as any, 'query')).rejects.toThrow(
      'Invalid example configuration',
    );
  });
});

// --- v0.1.0 parity tests (example_util) ---
describe('example_util (v0.1.0 parity)', () => {
  it('returns empty string when session has no events', () => {
    const session = createSession({id: 's1', appName: 'app', events: []});
    expect(getLatestMessageFromUser(session)).toBe('');
    expect(_getLatestMessageFromUser(session)).toBe('');
  });

  it('returns latest user message text when last event is from user without function responses', () => {
    const session = createSession({
      id: 's1',
      appName: 'app',
      events: [
        createEvent({
          author: 'model',
          content: {role: 'model', parts: [{text: 'Previous answer'}]},
        }),
        createEvent({
          author: 'user',
          content: {role: 'user', parts: [{text: 'Latest user question'}]},
        }),
      ],
    });
    expect(getLatestMessageFromUser(session)).toBe('Latest user question');
  });

  it('returns empty string when last event is not from user', () => {
    const session = createSession({
      id: 's1',
      appName: 'app',
      events: [
        createEvent({
          author: 'user',
          content: {role: 'user', parts: [{text: 'User question'}]},
        }),
        createEvent({
          author: 'agent',
          content: {role: 'model', parts: [{text: 'Agent response'}]},
        }),
      ],
    });
    expect(getLatestMessageFromUser(session)).toBe('');
  });

  it('returns empty string when last user event contains a function response', () => {
    const session = createSession({
      id: 's1',
      appName: 'app',
      events: [
        createEvent({
          author: 'user',
          content: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'my_tool',
                  response: {result: 'ok'},
                },
              },
            ],
          },
        }),
      ],
    });
    expect(getLatestMessageFromUser(session)).toBe('');
  });

  it('logs a warning and returns empty string when last user event has no text part', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const session = createSession({
        id: 's1',
        appName: 'app',
        events: [
          createEvent({
            author: 'user',
            content: {role: 'user', parts: []},
          }),
        ],
      });
      expect(getLatestMessageFromUser(session)).toBe('');
      expect(warnSpy).toHaveBeenCalledWith(
        'No message from user for fetching example.',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
