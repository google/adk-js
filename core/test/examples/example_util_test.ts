/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {BaseExampleProvider} from '../../src/examples/base_example_provider.js';
import {Example} from '../../src/examples/example.js';
import {
  buildExampleSi,
  convertExamplesToText,
} from '../../src/examples/example_util.js';

class FixedExampleProvider extends BaseExampleProvider {
  constructor(private readonly examples: Example[]) {
    super();
  }
  override getExamples(_query: string): Example[] {
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
  it('delegates to convertExamplesToText when given an array', () => {
    const result = buildExampleSi(
      [SIMPLE_EXAMPLE],
      'query',
      'gemini-2.0-flash',
    );
    expect(result).toContain('What is 2+2?');
    expect(result).toContain('4');
  });

  it('calls getExamples on a BaseExampleProvider', () => {
    const provider = new FixedExampleProvider([SIMPLE_EXAMPLE]);
    const result = buildExampleSi(provider, 'my query');
    expect(result).toContain('What is 2+2?');
  });

  it('passes the model string through to the provider path', () => {
    const provider = new FixedExampleProvider([FUNCTION_CALL_EXAMPLE]);
    const result = buildExampleSi(provider, 'query', 'gemini-1.5-pro');
    expect(result).toContain('```tool_code');
  });

  it('throws an error for invalid input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => buildExampleSi({} as any, 'query')).toThrow(
      'Invalid example configuration',
    );
  });
});
