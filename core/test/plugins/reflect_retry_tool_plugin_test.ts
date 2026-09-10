/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {Context} from '../../src/agents/context.js';
import {
  GLOBAL_SCOPE_KEY,
  REFLECT_AND_RETRY_RESPONSE_TYPE,
  resolveScopeKey,
  ScopedFailureTracker,
  TrackingScope,
} from '../../src/plugins/_reflect_retry_utils.js';
import {ReflectAndRetryToolPlugin} from '../../src/plugins/reflect_retry_tool_plugin.js';
import {BaseTool} from '../../src/tools/base_tool.js';

function createMockTool(name = 'weather_tool'): BaseTool {
  return {
    name,
    description: 'Mock weather tool for testing',
  } as unknown as BaseTool;
}

function createMockContext(
  invocationId = 'inv-123',
  agentName = 'test_agent',
): Context {
  const stateStore: Record<string, unknown> = {};
  return {
    invocationId,
    agentName,
    functionCallId: 'fc-001',
    state: {
      get: (key: string) => stateStore[key],
      set: (key: string, value: unknown) => {
        stateStore[key] = value;
      },
    },
  } as unknown as Context;
}

describe('ScopedFailureTracker and Utils', () => {
  it('should resolve scope keys correctly', () => {
    expect(resolveScopeKey(TrackingScope.INVOCATION, 'inv-abc')).toBe(
      'inv-abc',
    );
    expect(resolveScopeKey(TrackingScope.GLOBAL)).toBe(GLOBAL_SCOPE_KEY);
    expect(() => resolveScopeKey(TrackingScope.INVOCATION)).toThrow(
      'invocation_id must be provided for INVOCATION scope',
    );
    expect(() => resolveScopeKey('invalid' as TrackingScope)).toThrow(
      'Unknown scope',
    );
  });

  it('should increment and reset failure counts atomically', async () => {
    const tracker = new ScopedFailureTracker();
    const count1 = await tracker.increment('scope-1', 'toolA');
    expect(count1).toBe(1);

    const count2 = await tracker.increment('scope-1', 'toolA');
    expect(count2).toBe(2);

    const countB = await tracker.increment('scope-1', 'toolB');
    expect(countB).toBe(1);

    await tracker.reset('scope-1', 'toolA');
    expect(await tracker.getCount('scope-1', 'toolA')).toBe(0);
    expect(await tracker.getCount('scope-1', 'toolB')).toBe(1);
  });

  it('should handle concurrent operations safely', async () => {
    const tracker = new ScopedFailureTracker();
    const tasks = Array.from({length: 20}, () =>
      tracker.increment('concurrent-scope', 'toolX'),
    );
    const results = await Promise.all(tasks);
    expect(results).toHaveLength(20);
    expect(await tracker.getCount('concurrent-scope', 'toolX')).toBe(20);
  });
});

describe('ReflectAndRetryToolPlugin', () => {
  describe('constructor and configuration', () => {
    it('should initialize with default parameters', () => {
      const plugin = new ReflectAndRetryToolPlugin();
      expect(plugin.name).toBe('reflect_retry_tool_plugin');
      expect(plugin.maxRetries).toBe(3);
      expect(plugin.throwExceptionIfRetryExceeded).toBe(true);
      expect(plugin.scope).toBe(TrackingScope.INVOCATION);
    });

    it('should initialize with options object', () => {
      const plugin = new ReflectAndRetryToolPlugin({
        name: 'custom_retry',
        maxRetries: 5,
        throwExceptionIfRetryExceeded: false,
        trackingScope: TrackingScope.GLOBAL,
      });
      expect(plugin.name).toBe('custom_retry');
      expect(plugin.maxRetries).toBe(5);
      expect(plugin.throwExceptionIfRetryExceeded).toBe(false);
      expect(plugin.scope).toBe(TrackingScope.GLOBAL);
    });

    it('should throw error for negative maxRetries', () => {
      expect(() => new ReflectAndRetryToolPlugin({maxRetries: -1})).toThrow(
        'maxRetries must be a non-negative integer.',
      );
    });
  });

  describe('successful tool execution', () => {
    it('should return undefined and reset tool failure count on success', async () => {
      const plugin = new ReflectAndRetryToolPlugin({maxRetries: 3});
      const tool = createMockTool('search_tool');
      const toolContext = createMockContext('inv-1');
      const toolArgs = {query: 'Gemini'};

      // Simulate a prior failure
      await plugin.onToolErrorCallback({
        tool,
        toolArgs,
        toolContext,
        error: new Error('Network timeout'),
      });

      // Subsequent successful call
      const afterResult = await plugin.afterToolCallback({
        tool,
        toolArgs,
        toolContext,
        result: {output: 'Success result'},
      });

      expect(afterResult).toBeUndefined();

      // Next failure should be attempt 1 again (reset verified)
      const nextFailure = await plugin.onToolErrorCallback({
        tool,
        toolArgs,
        toolContext,
        error: new Error('Second timeout'),
      });

      expect(nextFailure).toBeDefined();
      expect(nextFailure!['retry_count']).toBe(1);
    });

    it('should ignore already handled reflection responses in afterToolCallback', async () => {
      const plugin = new ReflectAndRetryToolPlugin();
      const tool = createMockTool();
      const toolContext = createMockContext();

      const result = await plugin.afterToolCallback({
        tool,
        toolArgs: {},
        toolContext,
        result: {
          response_type: REFLECT_AND_RETRY_RESPONSE_TYPE,
          error_details: 'Already handled',
        },
      });

      expect(result).toBeUndefined();
    });
  });

  describe('tool error handling within retry limit', () => {
    it('should return structured reflection guidance on first failure', async () => {
      const plugin = new ReflectAndRetryToolPlugin({maxRetries: 3});
      const tool = createMockTool('calculator');
      const toolContext = createMockContext('inv-100');
      const toolArgs = {expression: '10 / 0'};
      const error = new Error('Division by zero');

      const response = await plugin.onToolErrorCallback({
        tool,
        toolArgs,
        toolContext,
        error,
      });

      expect(response).toBeDefined();
      expect(response!['response_type']).toBe(REFLECT_AND_RETRY_RESPONSE_TYPE);
      expect(response!['error_type']).toBe('Error');
      expect(response!['error_details']).toBe('Division by zero');
      expect(response!['retry_count']).toBe(1);

      const guidance = response!['reflection_guidance'] as string;
      expect(guidance).toContain('The call to tool `calculator` failed.');
      expect(guidance).toContain('Error: Division by zero');
      expect(guidance).toContain('retry attempt **1 of 3**');
      expect(guidance).toContain('Invalid Parameters');
    });

    it('should increment retry count consecutively up to maxRetries', async () => {
      const plugin = new ReflectAndRetryToolPlugin({maxRetries: 3});
      const tool = createMockTool('api_tool');
      const toolContext = createMockContext('inv-200');

      const res1 = await plugin.onToolErrorCallback({
        tool,
        toolArgs: {page: 1},
        toolContext,
        error: new Error('Rate limit'),
      });
      expect(res1!['retry_count']).toBe(1);

      const res2 = await plugin.onToolErrorCallback({
        tool,
        toolArgs: {page: 1},
        toolContext,
        error: new Error('Rate limit'),
      });
      expect(res2!['retry_count']).toBe(2);

      const res3 = await plugin.onToolErrorCallback({
        tool,
        toolArgs: {page: 1},
        toolContext,
        error: new Error('Rate limit'),
      });
      expect(res3!['retry_count']).toBe(3);
    });
  });

  describe('retry limit exceeded behavior', () => {
    it('should throw exception when retry limit is exceeded and throwExceptionIfRetryExceeded is true', async () => {
      const plugin = new ReflectAndRetryToolPlugin({
        maxRetries: 2,
        throwExceptionIfRetryExceeded: true,
      });
      const tool = createMockTool('flaky_tool');
      const toolContext = createMockContext('inv-300');

      // Attempt 1 & 2 succeed in returning guidance
      await plugin.onToolErrorCallback({
        tool,
        toolArgs: {},
        toolContext,
        error: new Error('Err 1'),
      });
      await plugin.onToolErrorCallback({
        tool,
        toolArgs: {},
        toolContext,
        error: new Error('Err 2'),
      });

      // Attempt 3 exceeds maxRetries (2) -> throws exception
      await expect(
        plugin.onToolErrorCallback({
          tool,
          toolArgs: {},
          toolContext,
          error: new Error('Err 3 - Fatal'),
        }),
      ).rejects.toThrow('Err 3 - Fatal');
    });

    it('should return retry-exceeded guidance when throwExceptionIfRetryExceeded is false', async () => {
      const plugin = new ReflectAndRetryToolPlugin({
        maxRetries: 2,
        throwExceptionIfRetryExceeded: false,
      });
      const tool = createMockTool('flaky_tool');
      const toolContext = createMockContext('inv-400');

      await plugin.onToolErrorCallback({
        tool,
        toolArgs: {},
        toolContext,
        error: new Error('Err 1'),
      });
      await plugin.onToolErrorCallback({
        tool,
        toolArgs: {},
        toolContext,
        error: new Error('Err 2'),
      });

      const exceedResponse = await plugin.onToolErrorCallback({
        tool,
        toolArgs: {param: 'xyz'},
        toolContext,
        error: new Error('Err 3'),
      });

      expect(exceedResponse).toBeDefined();
      expect(exceedResponse!['response_type']).toBe(
        REFLECT_AND_RETRY_RESPONSE_TYPE,
      );
      expect(exceedResponse!['retry_count']).toBe(2);

      const guidance = exceedResponse!['reflection_guidance'] as string;
      expect(guidance).toContain(
        'failed consecutively 2 times and the retry limit has been exceeded',
      );
      expect(guidance).toContain(
        'Do not attempt to use the `flaky_tool` tool again for this task.',
      );
    });

    it('should handle maxRetries = 0 properly', async () => {
      const throwingPlugin = new ReflectAndRetryToolPlugin({
        maxRetries: 0,
        throwExceptionIfRetryExceeded: true,
      });
      const softPlugin = new ReflectAndRetryToolPlugin({
        maxRetries: 0,
        throwExceptionIfRetryExceeded: false,
      });
      const tool = createMockTool('zero_retry_tool');
      const toolContext = createMockContext('inv-500');

      await expect(
        throwingPlugin.onToolErrorCallback({
          tool,
          toolArgs: {},
          toolContext,
          error: new Error('Zero retry instant error'),
        }),
      ).rejects.toThrow('Zero retry instant error');

      const softRes = await softPlugin.onToolErrorCallback({
        tool,
        toolArgs: {},
        toolContext,
        error: new Error('Soft zero retry error'),
      });

      expect(softRes).toBeDefined();
      expect(softRes!['retry_count']).toBe(0);
      expect(softRes!['reflection_guidance']).toContain(
        'Do not attempt to use the `zero_retry_tool`',
      );
    });
  });

  describe('scoping isolation', () => {
    it('should isolate failures per invocation when scope is INVOCATION', async () => {
      const plugin = new ReflectAndRetryToolPlugin({
        maxRetries: 3,
        trackingScope: TrackingScope.INVOCATION,
      });
      const tool = createMockTool('scoped_tool');
      const context1 = createMockContext('invocation-A');
      const context2 = createMockContext('invocation-B');

      // 2 failures in Invocation A
      await plugin.onToolErrorCallback({
        tool,
        toolArgs: {},
        toolContext: context1,
        error: new Error('A1'),
      });
      const resA2 = await plugin.onToolErrorCallback({
        tool,
        toolArgs: {},
        toolContext: context1,
        error: new Error('A2'),
      });
      expect(resA2!['retry_count']).toBe(2);

      // Invocation B should start at attempt 1
      const resB1 = await plugin.onToolErrorCallback({
        tool,
        toolArgs: {},
        toolContext: context2,
        error: new Error('B1'),
      });
      expect(resB1!['retry_count']).toBe(1);
    });

    it('should accumulate failures across invocations when scope is GLOBAL', async () => {
      const plugin = new ReflectAndRetryToolPlugin({
        maxRetries: 3,
        trackingScope: TrackingScope.GLOBAL,
      });
      const tool = createMockTool('global_tool');
      const context1 = createMockContext('turn-1');
      const context2 = createMockContext('turn-2');

      const res1 = await plugin.onToolErrorCallback({
        tool,
        toolArgs: {},
        toolContext: context1,
        error: new Error('Turn 1 fail'),
      });
      expect(res1!['retry_count']).toBe(1);

      const res2 = await plugin.onToolErrorCallback({
        tool,
        toolArgs: {},
        toolContext: context2,
        error: new Error('Turn 2 fail'),
      });
      expect(res2!['retry_count']).toBe(2);
    });

    it('should track failures separately per tool', async () => {
      const plugin = new ReflectAndRetryToolPlugin({maxRetries: 3});
      const toolA = createMockTool('tool_alpha');
      const toolB = createMockTool('tool_beta');
      const toolContext = createMockContext('inv-tools');

      const resA = await plugin.onToolErrorCallback({
        tool: toolA,
        toolArgs: {},
        toolContext,
        error: new Error('Alpha error'),
      });
      expect(resA!['retry_count']).toBe(1);

      const resB = await plugin.onToolErrorCallback({
        tool: toolB,
        toolArgs: {},
        toolContext,
        error: new Error('Beta error'),
      });
      expect(resB!['retry_count']).toBe(1);

      // Success with Tool A resets Tool A only
      await plugin.afterToolCallback({
        tool: toolA,
        toolArgs: {},
        toolContext,
        result: {ok: true},
      });

      // Tool B next failure is attempt 2
      const resB2 = await plugin.onToolErrorCallback({
        tool: toolB,
        toolArgs: {},
        toolContext,
        error: new Error('Beta error 2'),
      });
      expect(resB2!['retry_count']).toBe(2);
    });
  });

  describe('custom extractErrorFromResult hook', () => {
    class CustomStatusRetryPlugin extends ReflectAndRetryToolPlugin {
      override async extractErrorFromResult({
        result,
      }: {
        tool: BaseTool;
        toolArgs: Record<string, unknown>;
        toolContext: Context;
        result: unknown;
      }): Promise<unknown | undefined> {
        if (
          result &&
          typeof result === 'object' &&
          (result as Record<string, unknown>)['status'] === 'error'
        ) {
          return (
            (result as Record<string, unknown>)['error_message'] ??
            'Custom tool failure payload'
          );
        }
        return undefined;
      }
    }

    it('should trigger retry logic when error is returned in result payload', async () => {
      const plugin = new CustomStatusRetryPlugin({maxRetries: 3});
      const tool = createMockTool('status_tool');
      const toolContext = createMockContext('inv-custom');

      // Result has { status: 'error' }
      const reflectionResult = await plugin.afterToolCallback({
        tool,
        toolArgs: {query: 'invalid'},
        toolContext,
        result: {
          status: 'error',
          error_message: 'Invalid query schema detected in response',
        },
      });

      expect(reflectionResult).toBeDefined();
      expect(reflectionResult!['response_type']).toBe(
        REFLECT_AND_RETRY_RESPONSE_TYPE,
      );
      expect(reflectionResult!['retry_count']).toBe(1);
      expect(reflectionResult!['reflection_guidance']).toContain(
        'Invalid query schema detected in response',
      );
    });

    it('should proceed normally when result has no error status', async () => {
      const plugin = new CustomStatusRetryPlugin({maxRetries: 3});
      const tool = createMockTool('status_tool');
      const toolContext = createMockContext('inv-custom-ok');

      const reflectionResult = await plugin.afterToolCallback({
        tool,
        toolArgs: {query: 'valid'},
        toolContext,
        result: {
          status: 'success',
          data: [1, 2, 3],
        },
      });

      expect(reflectionResult).toBeUndefined();
    });
  });
});
