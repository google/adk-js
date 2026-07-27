/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BaseTool,
  Context,
  Event,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  LlmResponse,
  REFLECT_AND_RETRY_RESPONSE_TYPE,
  ReflectAndRetryToolPlugin,
  ToolFailureResponse,
  TrackingScope,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v3';

// --------------------------------------------------------------------------
// Test helpers
// --------------------------------------------------------------------------

function makeTool(name = 'test_tool'): BaseTool {
  return {name} as unknown as BaseTool;
}

function makeToolContext(invocationId: string | undefined = 'inv-1'): Context {
  return {invocationId} as unknown as Context;
}

const sampleArgs: Record<string, unknown> = {
  param1: 'value1',
  param2: 42,
  param3: true,
};

/** A subclass that detects errors in results via a configurable predicate. */
class CustomExtractionPlugin extends ReflectAndRetryToolPlugin {
  detect: (
    result: Record<string, unknown>,
  ) => Record<string, unknown> | undefined = () => undefined;

  override async extractErrorFromResult({
    result,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    return this.detect(result);
  }
}

describe('ReflectAndRetryToolPlugin', () => {
  describe('initialization', () => {
    it('uses documented defaults', () => {
      const plugin = new ReflectAndRetryToolPlugin();
      expect(plugin.name).toBe('reflect_retry_tool_plugin');
      expect(plugin.maxRetries).toBe(3);
      expect(plugin.throwExceptionIfRetryExceeded).toBe(true);
      expect(plugin.scope).toBe(TrackingScope.INVOCATION);
    });

    it('honors custom options', () => {
      const plugin = new ReflectAndRetryToolPlugin({
        name: 'custom_name',
        maxRetries: 10,
        throwExceptionIfRetryExceeded: false,
        trackingScope: TrackingScope.GLOBAL,
      });
      expect(plugin.name).toBe('custom_name');
      expect(plugin.maxRetries).toBe(10);
      expect(plugin.throwExceptionIfRetryExceeded).toBe(false);
      expect(plugin.scope).toBe(TrackingScope.GLOBAL);
    });

    it('rejects a negative maxRetries', () => {
      expect(() => new ReflectAndRetryToolPlugin({maxRetries: -1})).toThrow(
        'maxRetries must be a non-negative integer.',
      );
    });
  });

  describe('afterToolCallback', () => {
    it('returns undefined for a successful result', async () => {
      const plugin = new ReflectAndRetryToolPlugin();
      const result = await plugin.afterToolCallback({
        tool: makeTool(),
        toolArgs: sampleArgs,
        toolContext: makeToolContext(),
        result: {success: true, data: 'test_data'},
      });
      expect(result).toBeUndefined();
    });

    it('never re-processes its own guidance response', async () => {
      const plugin = new ReflectAndRetryToolPlugin();
      const result = await plugin.afterToolCallback({
        tool: makeTool(),
        toolArgs: sampleArgs,
        toolContext: makeToolContext(),
        result: {response_type: REFLECT_AND_RETRY_RESPONSE_TYPE},
      });
      expect(result).toBeUndefined();
    });

    it('handles a null result gracefully', async () => {
      const plugin = new ReflectAndRetryToolPlugin();
      const result = await plugin.afterToolCallback({
        tool: makeTool(),
        toolArgs: sampleArgs,
        toolContext: makeToolContext(),
        result: null as unknown as Record<string, unknown>,
      });
      expect(result).toBeUndefined();
    });

    it('handles a non-object (primitive) result gracefully', async () => {
      const plugin = new ReflectAndRetryToolPlugin();
      const result = await plugin.afterToolCallback({
        tool: makeTool(),
        toolArgs: sampleArgs,
        toolContext: makeToolContext(),
        result: 42 as unknown as Record<string, unknown>,
      });
      expect(result).toBeUndefined();
    });
  });

  describe('extractErrorFromResult', () => {
    it('returns undefined by default', async () => {
      const plugin = new ReflectAndRetryToolPlugin();
      const error = await plugin.extractErrorFromResult({
        tool: makeTool(),
        toolArgs: sampleArgs,
        toolContext: makeToolContext(),
        result: {status: 'success', data: 'some data'},
      });
      expect(error).toBeUndefined();
    });
  });

  describe('maxRetries === 0', () => {
    it('re-throws the exact same error instance when throwing is enabled', async () => {
      const plugin = new ReflectAndRetryToolPlugin({maxRetries: 0});
      const error = new Error('Test error');
      await expect(
        plugin.onToolErrorCallback({
          tool: makeTool(),
          toolArgs: sampleArgs,
          toolContext: makeToolContext(),
          error,
        }),
      ).rejects.toBe(error);
    });

    it('returns terminal guidance when throwing is disabled', async () => {
      const plugin = new ReflectAndRetryToolPlugin({
        maxRetries: 0,
        throwExceptionIfRetryExceeded: false,
      });
      const result = (await plugin.onToolErrorCallback({
        tool: makeTool(),
        toolArgs: sampleArgs,
        toolContext: makeToolContext(),
        error: new Error('Test error'),
      })) as ToolFailureResponse;

      expect(result.response_type).toBe(REFLECT_AND_RETRY_RESPONSE_TYPE);
      expect(result.error_type).toBe('Error');
      expect(result.retry_count).toBe(0);
      expect(result.reflection_guidance).toContain(
        'the retry limit has been exceeded',
      );
    });

    it('wraps a non-Error dict error in an Error (not a TypeError)', async () => {
      const plugin = new CustomExtractionPlugin({maxRetries: 0});
      plugin.detect = () => ({status: 'error', message: 'Custom dict error'});

      await expect(
        plugin.afterToolCallback({
          tool: makeTool(),
          toolArgs: sampleArgs,
          toolContext: makeToolContext(),
          result: {some: 'result'},
        }),
      ).rejects.toSatisfy(
        (e) =>
          e instanceof Error &&
          !(e instanceof TypeError) &&
          e.message.includes('Custom dict error'),
      );
    });
  });

  describe('error handling and retry counting', () => {
    it('builds a reflection response on the first failure', async () => {
      const plugin = new ReflectAndRetryToolPlugin();
      class CustomToolError extends Error {}
      const error = new CustomToolError('Test error message');

      const result = (await plugin.onToolErrorCallback({
        tool: makeTool('test_tool_id'),
        toolArgs: sampleArgs,
        toolContext: makeToolContext(),
        error,
      })) as ToolFailureResponse;

      expect(result.response_type).toBe(REFLECT_AND_RETRY_RESPONSE_TYPE);
      expect(result.error_type).toBe('CustomToolError');
      expect(result.error_details).toBe('Test error message');
      expect(result.retry_count).toBe(1);
      expect(result.reflection_guidance).toContain('test_tool_id');
      expect(result.reflection_guidance).toContain('Test error message');
      expect(result.reflection_guidance).toContain('Wrong Function Name');
    });

    it('increments retry count for consecutive failures on the same tool', async () => {
      const plugin = new ReflectAndRetryToolPlugin();
      const tool = makeTool();
      const toolContext = makeToolContext();
      const error = new Error('Runtime error');

      const first = (await plugin.onToolErrorCallback({
        tool,
        toolArgs: sampleArgs,
        toolContext,
        error,
      })) as ToolFailureResponse;
      expect(first.retry_count).toBe(1);

      const second = (await plugin.onToolErrorCallback({
        tool,
        toolArgs: sampleArgs,
        toolContext,
        error,
      })) as ToolFailureResponse;
      expect(second.retry_count).toBe(2);
    });

    it('counts failures independently per tool', async () => {
      const plugin = new ReflectAndRetryToolPlugin();
      const toolContext = makeToolContext();
      const error = new Error('Test error');

      const r1 = (await plugin.onToolErrorCallback({
        tool: makeTool('tool1'),
        toolArgs: sampleArgs,
        toolContext,
        error,
      })) as ToolFailureResponse;
      expect(r1.retry_count).toBe(1);

      const r2 = (await plugin.onToolErrorCallback({
        tool: makeTool('tool2'),
        toolArgs: sampleArgs,
        toolContext,
        error,
      })) as ToolFailureResponse;
      expect(r2.retry_count).toBe(1);
    });

    it('progresses retry counts up to the cap', async () => {
      const plugin = new ReflectAndRetryToolPlugin({maxRetries: 5});
      const tool = makeTool('single_tool');
      const toolContext = makeToolContext();
      const error = new Error('Test error');

      for (let i = 1; i <= 3; i++) {
        const result = (await plugin.onToolErrorCallback({
          tool,
          toolArgs: sampleArgs,
          toolContext,
          error,
        })) as ToolFailureResponse;
        expect(result.retry_count).toBe(i);
      }
    });

    it('formats empty tool args as {}', async () => {
      const plugin = new ReflectAndRetryToolPlugin();
      const result = (await plugin.onToolErrorCallback({
        tool: makeTool(),
        toolArgs: {},
        toolContext: makeToolContext(),
        error: new Error('Test error'),
      })) as ToolFailureResponse;
      expect(result.reflection_guidance).toContain('{}');
    });

    it('handles non-Error thrown values (e.g. strings)', async () => {
      const plugin = new ReflectAndRetryToolPlugin();
      const result = (await plugin.onToolErrorCallback({
        tool: makeTool(),
        toolArgs: sampleArgs,
        toolContext: makeToolContext(),
        error: 'boom' as unknown as Error,
      })) as ToolFailureResponse;
      expect(result.error_type).toBe('ToolError');
      expect(result.error_details).toBe('boom');
      expect(result.reflection_guidance).toContain('boom');
    });
  });

  describe('cap exceeded', () => {
    it('re-throws the same error instance once the cap is passed', async () => {
      const plugin = new ReflectAndRetryToolPlugin({maxRetries: 1});
      const tool = makeTool();
      const toolContext = makeToolContext();
      const error = new Error('Connection failed');

      const first = await plugin.onToolErrorCallback({
        tool,
        toolArgs: sampleArgs,
        toolContext,
        error,
      });
      expect(first).toBeDefined();

      await expect(
        plugin.onToolErrorCallback({
          tool,
          toolArgs: sampleArgs,
          toolContext,
          error,
        }),
      ).rejects.toBe(error);
    });

    it('re-throws a wrapped Error for dict errors once the cap is passed', async () => {
      const plugin = new CustomExtractionPlugin({maxRetries: 1});
      plugin.detect = () => ({status: 'error', message: 'Custom dict error'});
      const tool = makeTool();
      const toolContext = makeToolContext();

      const first = (await plugin.afterToolCallback({
        tool,
        toolArgs: sampleArgs,
        toolContext,
        result: {some: 'result'},
      })) as ToolFailureResponse;
      expect(first.retry_count).toBe(1);

      await expect(
        plugin.afterToolCallback({
          tool,
          toolArgs: sampleArgs,
          toolContext,
          result: {some: 'result'},
        }),
      ).rejects.toSatisfy(
        (e) =>
          e instanceof Error &&
          !(e instanceof TypeError) &&
          e.message.includes('Custom dict error'),
      );
    });

    it('returns terminal guidance when throwing is disabled', async () => {
      const plugin = new ReflectAndRetryToolPlugin({
        maxRetries: 2,
        throwExceptionIfRetryExceeded: false,
      });
      const tool = makeTool();
      const toolContext = makeToolContext();
      const error = new Error('Timeout occurred');

      let result: ToolFailureResponse | undefined;
      for (let i = 0; i < 3; i++) {
        result = (await plugin.onToolErrorCallback({
          tool,
          toolArgs: sampleArgs,
          toolContext,
          error,
        })) as ToolFailureResponse;
      }

      expect(result).toBeDefined();
      expect(result!.response_type).toBe(REFLECT_AND_RETRY_RESPONSE_TYPE);
      expect(result!.error_type).toBe('Error');
      expect(result!.retry_count).toBe(2);
      expect(result!.reflection_guidance).toContain(
        'the retry limit has been exceeded.',
      );
      expect(result!.reflection_guidance).toContain(
        'Do not attempt to use the',
      );
    });
  });

  describe('counter reset behavior', () => {
    it('resets a tool counter after a successful call', async () => {
      const plugin = new ReflectAndRetryToolPlugin();
      const tool = makeTool();
      const toolContext = makeToolContext();
      const error = new Error('Test error');

      const first = (await plugin.onToolErrorCallback({
        tool,
        toolArgs: sampleArgs,
        toolContext,
        error,
      })) as ToolFailureResponse;
      expect(first.retry_count).toBe(1);

      await plugin.afterToolCallback({
        tool,
        toolArgs: sampleArgs,
        toolContext,
        result: {success: true},
      });

      const second = (await plugin.onToolErrorCallback({
        tool,
        toolArgs: sampleArgs,
        toolContext,
        error,
      })) as ToolFailureResponse;
      expect(second.retry_count).toBe(1);
    });

    it('resets one tool without affecting others in the same scope', async () => {
      const plugin = new ReflectAndRetryToolPlugin();
      const toolContext = makeToolContext('inv-x');
      const error = new Error('Test error');

      await plugin.onToolErrorCallback({
        tool: makeTool('t1'),
        toolArgs: sampleArgs,
        toolContext,
        error,
      });
      await plugin.onToolErrorCallback({
        tool: makeTool('t2'),
        toolArgs: sampleArgs,
        toolContext,
        error,
      });

      // Success on t1 clears only t1; t2's counter survives (size !== 0 path).
      await plugin.afterToolCallback({
        tool: makeTool('t1'),
        toolArgs: sampleArgs,
        toolContext,
        result: {ok: true},
      });

      const t2Again = (await plugin.onToolErrorCallback({
        tool: makeTool('t2'),
        toolArgs: sampleArgs,
        toolContext,
        error,
      })) as ToolFailureResponse;
      expect(t2Again.retry_count).toBe(2);

      const t1Again = (await plugin.onToolErrorCallback({
        tool: makeTool('t1'),
        toolArgs: sampleArgs,
        toolContext,
        error,
      })) as ToolFailureResponse;
      expect(t1Again.retry_count).toBe(1);
    });
  });

  describe('custom error extraction', () => {
    it('detects errors in results and resets on success', async () => {
      const plugin = new CustomExtractionPlugin();
      plugin.detect = (result) =>
        result['status'] === 'error' ? result : undefined;
      const tool = makeTool();
      const toolContext = makeToolContext();

      const errorResult = (await plugin.afterToolCallback({
        tool,
        toolArgs: sampleArgs,
        toolContext,
        result: {status: 'error', message: 'Something went wrong'},
      })) as ToolFailureResponse;
      expect(errorResult.response_type).toBe(REFLECT_AND_RETRY_RESPONSE_TYPE);
      expect(errorResult.retry_count).toBe(1);

      const successResult = await plugin.afterToolCallback({
        tool,
        toolArgs: sampleArgs,
        toolContext,
        result: {status: 'success', data: 'operation completed'},
      });
      expect(successResult).toBeUndefined();
    });

    it('manages state across mixed error types', async () => {
      const plugin = new CustomExtractionPlugin();
      plugin.detect = (result) => (result['failed'] ? result : undefined);
      const tool = makeTool();
      const toolContext = makeToolContext();
      const customError = {failed: true, reason: 'Network timeout'};

      const r1 = (await plugin.afterToolCallback({
        tool,
        toolArgs: sampleArgs,
        toolContext,
        result: customError,
      })) as ToolFailureResponse;
      expect(r1.retry_count).toBe(1);

      const r2 = (await plugin.onToolErrorCallback({
        tool,
        toolArgs: sampleArgs,
        toolContext,
        error: new Error('Invalid parameter'),
      })) as ToolFailureResponse;
      expect(r2.retry_count).toBe(2);

      const r3 = await plugin.afterToolCallback({
        tool,
        toolArgs: sampleArgs,
        toolContext,
        result: {result: 'success'},
      });
      expect(r3).toBeUndefined();

      const r4 = (await plugin.afterToolCallback({
        tool,
        toolArgs: sampleArgs,
        toolContext,
        result: customError,
      })) as ToolFailureResponse;
      expect(r4.retry_count).toBe(1);
    });
  });

  describe('tracking scope', () => {
    it('counts per invocation under INVOCATION scope', async () => {
      const plugin = new ReflectAndRetryToolPlugin();
      const tool = makeTool();
      const error = new Error('Test error');

      const a = (await plugin.onToolErrorCallback({
        tool,
        toolArgs: sampleArgs,
        toolContext: makeToolContext('A'),
        error,
      })) as ToolFailureResponse;
      expect(a.retry_count).toBe(1);

      const b = (await plugin.onToolErrorCallback({
        tool,
        toolArgs: sampleArgs,
        toolContext: makeToolContext('B'),
        error,
      })) as ToolFailureResponse;
      expect(b.retry_count).toBe(1);
    });

    it('shares a single counter under GLOBAL scope', async () => {
      const plugin = new ReflectAndRetryToolPlugin({
        trackingScope: TrackingScope.GLOBAL,
      });
      const tool = makeTool();
      const error = new Error('Test error');

      const a = (await plugin.onToolErrorCallback({
        tool,
        toolArgs: sampleArgs,
        toolContext: makeToolContext('A'),
        error,
      })) as ToolFailureResponse;
      expect(a.retry_count).toBe(1);

      const b = (await plugin.onToolErrorCallback({
        tool,
        toolArgs: sampleArgs,
        toolContext: makeToolContext('B'),
        error,
      })) as ToolFailureResponse;
      expect(b.retry_count).toBe(2);
    });

    it('throws when INVOCATION scope has no invocation id', async () => {
      const plugin = new ReflectAndRetryToolPlugin();
      await expect(
        plugin.onToolErrorCallback({
          tool: makeTool(),
          toolArgs: sampleArgs,
          toolContext: makeToolContext(''),
          error: new Error('Test error'),
        }),
      ).rejects.toThrow('invocationId must be provided for INVOCATION scope');

      await expect(
        plugin.onToolErrorCallback({
          tool: makeTool(),
          toolArgs: sampleArgs,
          toolContext: {invocationId: undefined} as unknown as Context,
          error: new Error('Test error'),
        }),
      ).rejects.toThrow('invocationId must be provided for INVOCATION scope');
    });
  });
});

// --------------------------------------------------------------------------
// End-to-end: drive a real InMemoryRunner with a scripted (non-mock) model.
//
// A real FunctionTool throws on its first call and succeeds on the second. The
// plugin must convert the first failure into a reflection guidance payload fed
// back to the model, then let the retry succeed. No plugin internals are
// stubbed -- only the LLM is scripted (deterministic), exactly as the real
// PluginManager + tool-execution flow drive it.
// --------------------------------------------------------------------------

/** A deterministic model that yields a pre-scripted response per turn. */
class ScriptedLlm extends BaseLlm {
  private index = 0;

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'scripted-test-llm'});
  }

  override async *generateContentAsync(): AsyncGenerator<
    LlmResponse,
    void,
    void
  > {
    const next =
      this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index++;
    yield next;
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('connect is not supported by ScriptedLlm');
  }
}

function functionCallResponse(
  id: string,
  name: string,
  args: Record<string, unknown>,
): LlmResponse {
  return {
    content: {role: 'model', parts: [{functionCall: {id, name, args}}]},
  };
}

function collectResponses(events: Event[]): Array<Record<string, unknown>> {
  return events
    .flatMap((event) => event.content?.parts ?? [])
    .map((part) => part.functionResponse?.response)
    .filter((response): response is Record<string, unknown> => !!response);
}

describe('ReflectAndRetryToolPlugin (end-to-end)', () => {
  it('recovers a failing tool by feeding reflection guidance to the model', async () => {
    let callCount = 0;
    const flaky = new FunctionTool({
      name: 'flaky',
      description: 'Fails on the first call, then succeeds.',
      parameters: z.object({x: z.number()}),
      execute: async ({x}) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('transient failure');
        }
        return {value: x + 1};
      },
    });

    const model = new ScriptedLlm([
      functionCallResponse('call-1', 'flaky', {x: 1}),
      functionCallResponse('call-2', 'flaky', {x: 1}),
      {content: {role: 'model', parts: [{text: 'All done.'}]}},
    ]);

    const agent = new LlmAgent({
      name: 'root_agent',
      description: 'Agent under test.',
      model,
      tools: [flaky],
    });
    const plugin = new ReflectAndRetryToolPlugin();
    const runner = new InMemoryRunner({agent, plugins: [plugin]});

    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'user-1',
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'user-1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'please run flaky'}]},
    })) {
      events.push(event);
    }

    const responses = collectResponses(events);

    const reflections = responses.filter(
      (r) => r['response_type'] === REFLECT_AND_RETRY_RESPONSE_TYPE,
    );
    expect(reflections).toHaveLength(1);
    expect(reflections[0]['error_type']).toBe('Error');
    expect(reflections[0]['retry_count']).toBe(1);
    expect(String(reflections[0]['reflection_guidance'])).toContain(
      'Wrong Function Name',
    );

    // The retry actually executed and returned the corrected result.
    expect(callCount).toBe(2);
    const successes = responses.filter((r) => r['value'] === 2);
    expect(successes).toHaveLength(1);

    // The run recovered and produced the final text response.
    const finalText = events
      .flatMap((event) => event.content?.parts ?? [])
      .map((part) => part.text)
      .filter((text): text is string => !!text);
    expect(finalText).toContain('All done.');
  });
});
