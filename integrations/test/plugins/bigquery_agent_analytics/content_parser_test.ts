/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  convertKeysToSnakeCase,
  parseContent,
  sanitizeExternalUri,
  sanitizeText,
  smartTruncate,
  truncateCodePoints,
} from '../../../src/plugins/bigquery_agent_analytics/content_parser.js';

describe('truncateCodePoints', () => {
  it('leaves string untouched when under limit', () => {
    const res = truncateCodePoints('hello', 10);
    expect(res.value).toBe('hello');
    expect(res.truncated).toBe(false);
  });

  it('leaves string untouched when limit is -1', () => {
    const res = truncateCodePoints('a very long string here', -1);
    expect(res.value).toBe('a very long string here');
    expect(res.truncated).toBe(false);
  });

  it('truncates at code point limit with ...[TRUNCATED] suffix', () => {
    const res = truncateCodePoints('hello world', 5);
    expect(res.value).toBe('hello...[TRUNCATED]');
    expect(res.truncated).toBe(true);
  });

  it('never splits surrogate pair of astral characters', () => {
    // "a😀b": 3 code points ('a', '😀', 'b') but 4 UTF-16 code units ('😀' is 2 code units)
    const text = 'a😀b';
    const res = truncateCodePoints(text, 2);
    expect(res.value).toBe('a😀...[TRUNCATED]');
    expect(res.truncated).toBe(true);
    // Verify valid UTF-16: encoding and decoding does not produce replacement characters
    expect(res.value.includes('\uFFFD')).toBe(false);
  });
});

describe('sanitizeText', () => {
  it('redacts authorization headers', () => {
    const text =
      'HTTP/1.1\nAuthorization: Bearer secret-token-123\nContent-Type: text/plain';
    const res = sanitizeText(text);
    expect(res.value).toContain('Authorization: [REDACTED]');
    expect(res.value).not.toContain('secret-token-123');
    expect(res.truncated).toBe(true);
  });

  it('redacts standalone bearer tokens', () => {
    const text = 'Received bearer my_secret_bearer_token; proceed';
    const res = sanitizeText(text);
    expect(res.value).toBe('Received bearer [REDACTED]; proceed');
    expect(res.truncated).toBe(true);
  });

  it('does not redact prose mentioning bearer of', () => {
    const text = 'The bearer of good news';
    const res = sanitizeText(text);
    expect(res.value).toBe(text);
    expect(res.truncated).toBe(false);
  });

  it('redacts basic authentication credentials when decoding to user:password', () => {
    const encoded = Buffer.from('admin:supersecret').toString('base64');
    const text = `Basic ${encoded} authentication`;
    const res = sanitizeText(text);
    expect(res.value).toContain('Basic [REDACTED]');
    expect(res.value).not.toContain(encoded);
    expect(res.truncated).toBe(true);
  });

  it('redacts sensitive key=value pairs in prose', () => {
    const text =
      'Config: api_key="secret-key-123", temp:token=xyz456; status=ok';
    const res = sanitizeText(text);
    expect(res.value).toContain('api_key="[REDACTED]"');
    expect(res.value).toContain('temp:token=[REDACTED]');
    expect(res.value).not.toContain('secret-key-123');
    expect(res.value).not.toContain('xyz456');
    expect(res.value).toContain('status=ok');
    expect(res.truncated).toBe(true);
  });

  it('leaves clean text without credentials unchanged', () => {
    const text = 'Normal diagnostic text with no secrets.';
    const res = sanitizeText(text);
    expect(res.value).toBe(text);
    expect(res.truncated).toBe(false);
  });
});

describe('sanitizeExternalUri', () => {
  it('redacts userinfo in URI', () => {
    const uri =
      'https://admin:password123@storage.googleapis.com/bucket/file.txt';
    const res = sanitizeExternalUri(uri);
    expect(res.value).toBe('[REDACTED_SENSITIVE_URI]');
    expect(res.truncated).toBe(true);
  });

  it('redacts sensitive query parameters', () => {
    const uri =
      'https://storage.googleapis.com/bucket/file.txt?client_id=123&api_key=secret-999&temp:run=abc';
    const res = sanitizeExternalUri(uri);
    expect(res.value).toContain('api_key=%5BREDACTED%5D');
    expect(res.value).toContain('client_id=123');
    expect(res.value).not.toContain('secret-999');
    expect(res.truncated).toBe(true);
  });

  it('leaves clean URI without secrets unchanged', () => {
    const uri = 'https://storage.googleapis.com/bucket/file.txt?format=json';
    const res = sanitizeExternalUri(uri);
    expect(res.value).toBe(uri);
    expect(res.truncated).toBe(false);
  });
});

describe('smartTruncate', () => {
  it('redacts sensitive keys and temp: keys in objects', () => {
    const input = {
      user_id: 'u123',
      api_key: 'top-secret',
      'temp:session_code': 'xyz',
      nested: {
        access_token: 'nested-token',
        status: 'active',
      },
    };
    const res = smartTruncate(input, 1000);
    const val = res.value as Record<string, unknown>;

    expect(val['user_id']).toBe('u123');
    expect(val['api_key']).toBe('[REDACTED]');
    expect(val['temp:session_code']).toBe('[REDACTED]');

    const nested = val['nested'] as Record<string, unknown>;
    expect(nested['access_token']).toBe('[REDACTED]');
    expect(nested['status']).toBe('active');
  });

  it('detects circular references without throwing', () => {
    interface RecursiveNode {
      name: string;
      next?: RecursiveNode;
    }
    const node: RecursiveNode = {name: 'root'};
    node.next = node;

    const res = smartTruncate(node, 1000);
    const val = res.value as Record<string, unknown>;
    expect(val['name']).toBe('root');
    expect(val['next']).toBe('[CIRCULAR_REFERENCE]');
    expect(res.truncated).toBe(false);
  });

  it('enforces depth cap of 50', () => {
    let current: Record<string, unknown> = {val: 0};
    const root = current;
    for (let i = 1; i <= 60; i++) {
      const next: Record<string, unknown> = {val: i};
      current['child'] = next;
      current = next;
    }

    const res = smartTruncate(root, 1000);
    expect(res.truncated).toBe(true);
  });

  it('enforces work budget cap of 100000 nodes', () => {
    const hugeList: number[] = Array.from({length: 120}, (_, i) => i);
    const res = smartTruncate(hugeList, 1000, new Set(), 0, {count: 10});
    expect(res.truncated).toBe(true);
    const val = res.value as unknown[];
    expect(val).toContain('[SANITIZE_BUDGET_EXCEEDED]');
  });
});

describe('convertKeysToSnakeCase', () => {
  it('converts camelCase keys of nested objects to snake_case', () => {
    const input = {
      promptTokenCount: 15,
      candidatesTokenCount: 42,
      totalTokenCount: 57,
      nestedDetails: {
        modelVersionTag: 'v1',
      },
    };
    const converted = convertKeysToSnakeCase(input) as Record<string, unknown>;
    expect(converted['prompt_token_count']).toBe(15);
    expect(converted['candidates_token_count']).toBe(42);
    expect(converted['total_token_count']).toBe(57);

    const nested = converted['nested_details'] as Record<string, unknown>;
    expect(nested['model_version_tag']).toBe('v1');
  });
});

describe('parseContent', () => {
  it('handles undefined and null inputs', () => {
    expect(parseContent(undefined, 1000)).toEqual({
      content: null,
      contentParts: [],
      truncated: false,
    });
    expect(parseContent(null, 1000)).toEqual({
      content: null,
      contentParts: [],
      truncated: false,
    });
  });

  it('parses LlmRequest with contents and system instruction', () => {
    const llmRequest = {
      contents: [
        {
          role: 'user',
          parts: [{text: 'Hello assistant!'}],
        },
      ],
      config: {
        systemInstruction: 'You are a helpful assistant.',
      },
    };

    const res = parseContent(llmRequest, 1000);
    const content = res.content as Record<string, unknown>;

    expect(content['prompt']).toEqual([
      {role: 'user', content: 'Hello assistant!'},
    ]);
    expect(content['system_prompt']).toBe('You are a helpful assistant.');
    expect(res.contentParts.length).toBe(1);
    expect(res.contentParts[0].text).toBe('Hello assistant!');
    expect(res.contentParts[0].storage_mode).toBe('INLINE');
  });

  it('parses Content and Part objects into text_summary and parts', () => {
    const part = {text: 'Explain quantum physics'};
    const res = parseContent(part, 1000);

    expect(res.content).toEqual({text_summary: 'Explain quantum physics'});
    expect(res.contentParts.length).toBe(1);
    expect(res.contentParts[0].text).toBe('Explain quantum physics');
  });

  it('handles inlineData binary parts', () => {
    const part = {
      inlineData: {
        mimeType: 'image/png',
        data: 'base64-bytes',
      },
    };
    const res = parseContent(part, 1000);
    expect(res.contentParts[0].text).toBe('[BINARY DATA]');
    expect(res.contentParts[0].mime_type).toBe('image/png');
    expect(res.contentParts[0].storage_mode).toBe('INLINE');
  });

  it('handles fileData external URI parts', () => {
    const part = {
      fileData: {
        mimeType: 'application/pdf',
        fileUri: 'https://storage.googleapis.com/docs/spec.pdf',
      },
    };
    const res = parseContent(part, 1000);
    expect(res.contentParts[0].storage_mode).toBe('EXTERNAL_URI');
    expect(res.contentParts[0].uri).toBe(
      'https://storage.googleapis.com/docs/spec.pdf',
    );
  });

  it('handles functionCall parts', () => {
    const part = {
      functionCall: {
        name: 'getWeather',
        args: {location: 'Seattle'},
      },
    };
    const res = parseContent(part, 1000);
    expect(res.contentParts[0].text).toBe('Function: getWeather');
    expect(res.contentParts[0].part_attributes).toBe(
      JSON.stringify({function_name: 'getWeather'}),
    );
  });

  it('handles functionResponse parts', () => {
    const part = {
      functionResponse: {
        name: 'getWeather',
        response: {temp: 65, condition: 'rain'},
      },
    };
    const res = parseContent(part, 1000);
    expect(res.contentParts[0].text).toBe('Function response: getWeather');
    expect(res.contentParts[0].part_attributes).toContain('getWeather');
  });

  it('handles executableCode and codeExecutionResult parts', () => {
    const execPart = {
      executableCode: {
        language: 'python',
        code: 'print(42)',
      },
    };
    const execRes = parseContent(execPart, 1000);
    expect(execRes.contentParts[0].text).toBe('print(42)');

    const resultPart = {
      codeExecutionResult: {
        outcome: 'OUTCOME_OK',
        output: '42\n',
      },
    };
    const resultRes = parseContent(resultPart, 1000);
    expect(resultRes.contentParts[0].text).toBe('42\n');
  });
});
