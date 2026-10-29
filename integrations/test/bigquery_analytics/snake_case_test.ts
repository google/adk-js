/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  camelToSnake,
  snakeCaseKeysDeep,
} from '../../src/bigquery_analytics/snake_case.js';

describe('camelToSnake', () => {
  it.each([
    ['promptTokenCount', 'prompt_token_count'],
    ['Type', 'type'],
    ['JSONSchema', 'json_schema'],
    ['maxLength', 'max_length'],
    ['already_snake', 'already_snake'],
  ])('converts %s', (key, expected) => {
    expect(camelToSnake(key)).toBe(expected);
  });
});

describe('snakeCaseKeysDeep', () => {
  it('keeps both entries when two keys share a snake_case form', () => {
    expect(
      snakeCaseKeysDeep({accessToken: 'harmless', access_token: 'SECRET'}),
    ).toEqual({accessToken: 'harmless', access_token: 'SECRET'});
    expect(
      snakeCaseKeysDeep({promptTokenCount: 20, prompt_token_count: 10}),
    ).toEqual({promptTokenCount: 20, prompt_token_count: 10});
    expect(snakeCaseKeysDeep({fooBar: 1, FooBar: 2})).toEqual({
      foo_bar: 1,
      FooBar: 2,
    });
  });

  it('stops at the sanitizer depth bound instead of overflowing the stack', () => {
    let deep: Record<string, unknown> = {leafValue: 1};
    for (let index = 0; index < 100_000; index += 1) {
      deep = {childNode: deep};
    }
    expect(JSON.stringify(snakeCaseKeysDeep(deep))).toContain(
      '[MAX_DEPTH_EXCEEDED]',
    );
  });

  it('passes built-in instances through for the sanitizer', () => {
    const url = new URL('https://example.com/a');
    const params = new URLSearchParams('a=1');
    const error = new Error('boom');
    const boxed = new String('text');
    const converted = snakeCaseKeysDeep({
      someUrl: url,
      someParams: params,
      someError: error,
      someBoxed: boxed,
    }) as Record<string, unknown>;
    expect(converted['some_url']).toBe(url);
    expect(converted['some_params']).toBe(params);
    expect(converted['some_error']).toBe(error);
    expect(converted['some_boxed']).toBe(boxed);
  });

  it('converts SDK class instances', () => {
    class UsageMetadata {
      promptTokenCount = 3;
    }
    expect(snakeCaseKeysDeep({usage: new UsageMetadata()})).toEqual({
      usage: {prompt_token_count: 3},
    });
  });
});
