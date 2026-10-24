/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type BaseTool, type Context, type Event} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  classifyToolResultError,
  isDurableNodeError,
  markToolErrorRecorded,
  popToolErrorRecorded,
  toolResultClassification,
  type ToolResultClassification,
  type ToolResultClassifier,
  validateToolResultClassifier,
} from '../../src/bigquery_analytics/callback_helpers.js';

// Behaviour ported from adk-python plugins/_callback_helpers.py and the
// tool-error tests of test_bigquery_agent_analytics_plugin.py.

const tool = {name: 'lookup'} as unknown as BaseTool;
const toolContext = {} as unknown as Context;

function classify(
  result: unknown,
  toolResultClassifier: ToolResultClassifier | null = null,
): string | null {
  return classifyToolResultError({
    tool,
    toolArgs: {},
    toolContext,
    result,
    toolResultClassifier,
  });
}

const RETRY_ANSWER = {
  response_type: 'ERROR_HANDLED_BY_REFLECT_AND_RETRY_PLUGIN',
  error_type: 'ValueError',
  error_details: 'boom',
};

describe('classifyToolResultError', () => {
  it('records a ReflectAndRetryToolPlugin answer, preferring its details over its type', () => {
    expect(classify(RETRY_ANSWER)).toBe('boom');
    expect(classify({...RETRY_ANSWER, error_details: ''})).toBe('ValueError');
    expect(classify({response_type: RETRY_ANSWER.response_type})).toBe(
      'Tool raised an error that ReflectAndRetryToolPlugin handled.',
    );
  });

  it('does not let a classifier hide a retry answer', () => {
    expect(
      classify(RETRY_ANSWER, () => toolResultClassification({status: 'OK'})),
    ).toBe('boom');
  });

  it('records an MCP result whose isError or is_error is exactly true', () => {
    expect(classify({isError: true, content: []})).toBe(
      'Tool returned an MCP result with isError=true.',
    );
    expect(classify({is_error: true})).toBe(
      'Tool returned an MCP result with isError=true.',
    );
    expect(classify({isError: 'true'})).toBeNull();
    expect(classify({error_details: 'only a field'})).toBeNull();
    expect(classify('isError')).toBeNull();
  });

  it('never runs a getter of the result', () => {
    let called = false;
    const result = {
      get isError(): boolean {
        called = true;
        return true;
      },
    };
    expect(classify(result)).toBeNull();
    expect(called).toBe(false);
  });

  it('applies a classifier verdict', () => {
    function failing({
      result,
    }: Parameters<ToolResultClassifier>[0]): ToolResultClassification | null {
      return typeof result === 'object' &&
        result !== null &&
        'status' in result &&
        result.status === 'ERROR'
        ? toolResultClassification({status: 'ERROR', errorMessage: 'failed'})
        : null;
    }
    expect(classify({status: 'ERROR'}, failing)).toBe('failed');
    expect(classify({status: 'OK'}, failing)).toBeNull();
    expect(
      classify({}, () => toolResultClassification({status: 'ERROR'})),
    ).toBe('tool_result_classifier classified the tool result as an error.');
    expect(
      classify({}, () =>
        toolResultClassification({status: 'ERROR', errorMessage: ''}),
      ),
    ).toBe('tool_result_classifier classified the tool result as an error.');
    expect(
      classify({isError: true}, () => toolResultClassification({status: 'OK'})),
    ).toBeNull();
  });

  it('falls back to the built-in rule when the classifier throws, is async, or returns junk', () => {
    function throwing(): never {
      throw new Error('SECRET');
    }
    const junk = (() => 'ERROR') as unknown as ToolResultClassifier;
    const badStatus = (() => ({
      status: 'MAYBE',
    })) as unknown as ToolResultClassifier;
    const asyncClassifier = (() =>
      Promise.reject(new Error('SECRET'))) as unknown as ToolResultClassifier;
    for (const classifier of [throwing, junk, badStatus, asyncClassifier]) {
      expect(classify({isError: true}, classifier)).toBe(
        'Tool returned an MCP result with isError=true.',
      );
      expect(classify({}, classifier)).toBeNull();
    }
  });
});

describe('toolResultClassification', () => {
  it('rejects an invalid status or message', () => {
    expect(() => toolResultClassification({status: 'NOPE' as 'OK'})).toThrow(
      RangeError,
    );
    expect(() =>
      toolResultClassification({
        status: 'ERROR',
        errorMessage: 1 as unknown as string,
      }),
    ).toThrow(RangeError);
  });
});

describe('validateToolResultClassifier', () => {
  it('accepts null and synchronous one-argument functions', () => {
    expect(() => validateToolResultClassifier(null)).not.toThrow();
    expect(() => validateToolResultClassifier(() => null)).not.toThrow();
  });

  it.each([
    ['a non-function', 'nope'],
    ['an async function', async () => null],
    ['an async generator', async function* () {}],
    ['a positional signature', (_a: unknown, _b: unknown) => null],
  ])('rejects %s', (_label, classifier) => {
    expect(() => validateToolResultClassifier(classifier)).toThrow(RangeError);
  });
});

describe('isDurableNodeError', () => {
  function event(fields: Partial<Event>): Event {
    return fields as Event;
  }

  it('separates node failures from model finish and block reasons', () => {
    expect(isDurableNodeError(event({errorCode: 'NODE_TIMEOUT'}))).toBe(true);
    expect(isDurableNodeError(event({errorCode: 'MAX_TOKENS'}))).toBe(false);
    expect(isDurableNodeError(event({errorCode: 'BLOCKLIST'}))).toBe(false);
    expect(
      isDurableNodeError(event({errorCode: 'NODE_TIMEOUT', partial: true})),
    ).toBe(false);
    expect(isDurableNodeError(event({}))).toBe(false);
  });
});

describe('markToolErrorRecorded / popToolErrorRecorded', () => {
  it('reports a mark once, per plugin and per call', () => {
    const plugin = {};
    const otherPlugin = {};
    const call = {};
    const otherCall = {};
    markToolErrorRecorded(plugin, call);
    expect(popToolErrorRecorded(otherPlugin, call)).toBe(false);
    expect(popToolErrorRecorded(plugin, otherCall)).toBe(false);
    expect(popToolErrorRecorded(plugin, call)).toBe(true);
    expect(popToolErrorRecorded(plugin, call)).toBe(false);
  });

  it('keeps concurrent calls of one plugin apart', () => {
    const plugin = {};
    const first = {};
    const second = {};
    markToolErrorRecorded(plugin, first);
    markToolErrorRecorded(plugin, second);
    expect(popToolErrorRecorded(plugin, first)).toBe(true);
    expect(popToolErrorRecorded(plugin, second)).toBe(true);
  });
});
