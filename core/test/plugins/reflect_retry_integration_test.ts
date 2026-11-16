/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {z as z3} from 'zod/v3';
import {Context} from '../../src/agents/context.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {BaseLlm} from '../../src/models/base_llm.js';
import {BaseLlmConnection} from '../../src/models/base_llm_connection.js';
import {LlmResponse} from '../../src/models/llm_response.js';
import {
  REFLECT_AND_RETRY_RESPONSE_TYPE,
  TrackingScope,
} from '../../src/plugins/_reflect_retry_utils.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {ReflectAndRetryToolPlugin} from '../../src/plugins/reflect_retry_tool_plugin.js';
import {InMemoryRunner} from '../../src/runner/in_memory_runner.js';
import {BaseTool, RunAsyncToolRequest} from '../../src/tools/base_tool.js';
import {FunctionTool} from '../../src/tools/function_tool.js';

class MockWeatherTool extends BaseTool {
  callCount = 0;

  constructor() {
    super({
      name: 'get_weather',
      description: 'Fetches weather for a city',
    });
  }

  override async runAsync({
    args,
  }: RunAsyncToolRequest): Promise<Record<string, unknown>> {
    this.callCount++;
    if (!args['city'] || typeof args['city'] !== 'string') {
      throw new Error(
        "Missing or invalid parameter 'city'. Expected a string city name.",
      );
    }
    return {
      city: args['city'],
      temperature: 72,
      condition: 'Sunny',
    };
  }
}

class MockFlightTool extends BaseTool {
  callCount = 0;

  constructor() {
    super({
      name: 'book_flight',
      description: 'Books a flight ticket',
    });
  }

  override async runAsync({
    args,
  }: RunAsyncToolRequest): Promise<Record<string, unknown>> {
    this.callCount++;
    if (!args['destination']) {
      throw new Error("Parameter 'destination' is required.");
    }
    return {
      booking_id: 'FL-9988',
      status: 'CONFIRMED',
    };
  }
}

function createTestContext(invocationId = 'integration-turn-1'): {
  invocationContext: InvocationContext;
  toolContext: Context;
} {
  const stateStore: Record<string, unknown> = {};
  const invocationContext = {
    invocationId,
    session: {id: 'session-xyz'},
    pluginManager: undefined as unknown as PluginManager,
  } as unknown as InvocationContext;

  const toolContext = {
    invocationId,
    agentName: 'travel_agent',
    functionCallId: 'call-101',
    state: {
      get: (k: string) => stateStore[k],
      set: (k: string, v: unknown) => {
        stateStore[k] = v;
      },
    },
  } as unknown as Context;

  return {invocationContext, toolContext};
}

describe('ReflectAndRetryToolPlugin Integration Flow', () => {
  it('should enable self-healing tool error recovery in a simulated multi-turn workflow', async () => {
    const plugin = new ReflectAndRetryToolPlugin({maxRetries: 3});
    const pluginManager = new PluginManager([plugin]);
    const weatherTool = new MockWeatherTool();
    const {toolContext} = createTestContext('inv-self-heal');

    // Turn 1: LLM hallucinates parameter {"city_name": 12345} instead of {"city": "New York"}
    const invalidArgs = {city_name: 12345};
    let toolResult: Record<string, unknown> | undefined;

    try {
      toolResult = (await weatherTool.runAsync({
        args: invalidArgs,
        toolContext,
      })) as Record<string, unknown>;
    } catch (err) {
      toolResult = await pluginManager.runOnToolErrorCallback({
        tool: weatherTool,
        toolArgs: invalidArgs,
        toolContext,
        error: err as Error,
      });
    }

    // Intercepted and reflection guidance provided
    expect(toolResult).toBeDefined();
    expect(toolResult!['response_type']).toBe(REFLECT_AND_RETRY_RESPONSE_TYPE);
    expect(toolResult!['retry_count']).toBe(1);
    expect(toolResult!['error_details']).toContain(
      "Missing or invalid parameter 'city'",
    );
    expect(toolResult!['reflection_guidance']).toContain(
      'retry attempt **1 of 3**',
    );

    // Turn 2: LLM reflects on the guidance, fixes arguments to {"city": "New York"}
    const correctedArgs = {city: 'New York'};
    const successResult = (await weatherTool.runAsync({
      args: correctedArgs,
      toolContext,
    })) as Record<string, unknown>;

    // afterToolCallback notifies plugin of success -> resets failure count
    await pluginManager.runAfterToolCallback({
      tool: weatherTool,
      toolArgs: correctedArgs,
      toolContext,
      result: successResult,
    });

    expect(successResult).toEqual({
      city: 'New York',
      temperature: 72,
      condition: 'Sunny',
    });
    expect(weatherTool.callCount).toBe(2);

    // Turn 3: Future error starts fresh from retry count 1
    const nextErrorRes = await pluginManager.runOnToolErrorCallback({
      tool: weatherTool,
      toolArgs: {invalid: true},
      toolContext,
      error: new Error('Future error'),
    });
    expect(nextErrorRes!['retry_count']).toBe(1);
  });

  it('should independently track and heal multiple concurrent tools', async () => {
    const plugin = new ReflectAndRetryToolPlugin({maxRetries: 3});
    const pluginManager = new PluginManager([plugin]);
    const weatherTool = new MockWeatherTool();
    const flightTool = new MockFlightTool();
    const {toolContext} = createTestContext('inv-multi-tool');

    // Weather tool fails once
    const weatherErr = await pluginManager.runOnToolErrorCallback({
      tool: weatherTool,
      toolArgs: {},
      toolContext,
      error: new Error('Weather invalid'),
    });
    expect(weatherErr!['retry_count']).toBe(1);

    // Flight tool fails twice
    await pluginManager.runOnToolErrorCallback({
      tool: flightTool,
      toolArgs: {},
      toolContext,
      error: new Error('Flight fail 1'),
    });
    const flightErr2 = await pluginManager.runOnToolErrorCallback({
      tool: flightTool,
      toolArgs: {},
      toolContext,
      error: new Error('Flight fail 2'),
    });
    expect(flightErr2!['retry_count']).toBe(2);

    // Weather tool succeeds and resets
    const weatherOk = (await weatherTool.runAsync({
      args: {city: 'Tokyo'},
      toolContext,
    })) as Record<string, unknown>;
    await pluginManager.runAfterToolCallback({
      tool: weatherTool,
      toolArgs: {city: 'Tokyo'},
      toolContext,
      result: weatherOk,
    });

    // Flight tool next failure is attempt 3
    const flightErr3 = await pluginManager.runOnToolErrorCallback({
      tool: flightTool,
      toolArgs: {},
      toolContext,
      error: new Error('Flight fail 3'),
    });
    expect(flightErr3!['retry_count']).toBe(3);
  });

  it('should enforce retry limit when a broken tool continues to fail', async () => {
    const plugin = new ReflectAndRetryToolPlugin({
      maxRetries: 2,
      throwExceptionIfRetryExceeded: false,
      trackingScope: TrackingScope.INVOCATION,
    });
    const pluginManager = new PluginManager([plugin]);
    const tool = new MockFlightTool();
    const {toolContext} = createTestContext('inv-limit');

    // Fail 1
    const f1 = await pluginManager.runOnToolErrorCallback({
      tool,
      toolArgs: {},
      toolContext,
      error: new Error('Fail 1'),
    });
    expect(f1!['retry_count']).toBe(1);

    // Fail 2
    const f2 = await pluginManager.runOnToolErrorCallback({
      tool,
      toolArgs: {},
      toolContext,
      error: new Error('Fail 2'),
    });
    expect(f2!['retry_count']).toBe(2);

    // Fail 3 (Exceeds limit) -> Returns stop using tool guidance
    const f3 = await pluginManager.runOnToolErrorCallback({
      tool,
      toolArgs: {},
      toolContext,
      error: new Error('Fail 3'),
    });
    expect(f3!['retry_count']).toBe(2);
    expect(f3!['reflection_guidance']).toContain(
      'Do not attempt to use the `book_flight` tool again',
    );
  });

  it('should terminate the agent run immediately by propagating the exception when maxRetries is exceeded', async () => {
    class AlwaysCallsToolLlm extends BaseLlm {
      callCount = 0;

      constructor() {
        super({model: 'mock-llm'});
      }

      async *generateContentAsync(): AsyncGenerator<LlmResponse, void, void> {
        this.callCount++;
        yield {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: `c-${this.callCount}`,
                  name: 'fail_tool',
                  args: {},
                },
              },
            ],
          },
        };
      }

      async connect(): Promise<BaseLlmConnection> {
        throw new Error('not implemented');
      }
    }

    const llm = new AlwaysCallsToolLlm();
    let toolRuns = 0;
    const failTool = new FunctionTool({
      name: 'fail_tool',
      description: 'always fails',
      parameters: z3.object({}),
      execute: async () => {
        toolRuns++;
        throw new Error('boom');
      },
    });

    const agent = new LlmAgent({
      name: 'agent',
      model: llm,
      tools: [failTool],
    });

    const runner = new InMemoryRunner({
      agent,
      appName: 'repro',
      plugins: [new ReflectAndRetryToolPlugin({maxRetries: 1})],
    });

    const session = await runner.sessionService.createSession({
      appName: 'repro',
      userId: 'u1',
    });

    await expect(async () => {
      for await (const _event of runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'go'}]},
        runConfig: {maxLlmCalls: 10},
      })) {
        // Consume events until error is thrown.
      }
    }).rejects.toThrow(/boom/);

    // 1 initial attempt + 1 retry = 2 LLM calls and 2 tool runs, not maxLlmCalls (10).
    expect(llm.callCount).toBe(2);
    expect(toolRuns).toBe(2);
  });
});
