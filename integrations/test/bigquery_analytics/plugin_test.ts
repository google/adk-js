/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type BigQuery} from '@google-cloud/bigquery';
import {type managedwriter} from '@google-cloud/bigquery-storage';
import {
  BaseLlm,
  type BaseLlmConnection,
  BasePlugin,
  Context,
  createEvent,
  type Event,
  FunctionTool,
  InMemoryRunner,
  type InvocationContext,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  LongRunningFunctionTool,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v3';
import {
  BigQueryAgentAnalyticsPlugin,
  type BigQueryLoggerConfig,
} from '../../src/bigquery_analytics/index.js';
import {type BigQueryClient} from '../../src/bigquery_analytics/table_setup.js';
import {
  type EncodedRow,
  type RowAppender,
} from '../../src/bigquery_analytics/write_client.js';

const appended: EncodedRow[] = [];
const finalizeWriteStream = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => undefined),
);

vi.mock(
  '../../src/bigquery_analytics/write_client.js',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('../../src/bigquery_analytics/write_client.js')
      >();
    const appender: RowAppender = {
      appendRows: async ({rows}) => {
        appended.push(...rows);
        return {};
      },
      finalizeWriteStream,
      close: () => undefined,
    };
    return {...original, createStorageRowAppender: () => appender};
  },
);

/** Returns canned responses in order, then a plain text reply. */
class ScriptedLlm extends BaseLlm {
  private index = 0;

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'scripted-model'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield this.responses[this.index++] ?? textResponse('Done.');
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connections are not used in this test.');
  }
}

/** Keeps the invocation context of the last run. */
class ContextCapture extends BasePlugin {
  invocationContext: InvocationContext | undefined;

  constructor() {
    super('context_capture');
  }

  override async beforeRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<undefined> {
    this.invocationContext = invocationContext;
    return undefined;
  }
}

function textResponse(text: string): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}};
}

function callResponse(
  name: string,
  args: Record<string, unknown>,
): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: [{functionCall: {id: `call-${name}`, name, args}}],
    },
  };
}

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Returns the forecast for a city.',
  parameters: z.object({city: z.string()}),
  execute: ({city}) => ({city, forecast: 'sunny', api_key: 'secret'}),
});

const explode = new FunctionTool({
  name: 'explode',
  description: 'Always fails.',
  parameters: z.object({reason: z.string()}),
  execute: () => {
    throw new Error('tool exploded');
  },
});

const rememberCity = new FunctionTool({
  name: 'remember_city',
  description: 'Stores the city in session state.',
  parameters: z.object({city: z.string()}),
  execute: ({city}, context) => {
    context?.state.set('last_city', city);
    return {stored: city};
  },
});

const bookTrip = new LongRunningFunctionTool({
  name: 'book_trip',
  description: 'Starts a booking that finishes later.',
  parameters: z.object({city: z.string()}),
  execute: () => ({status: 'pending'}),
});

const deleteTrip = new FunctionTool({
  name: 'delete_trip',
  description: 'Deletes a booking after confirmation.',
  parameters: z.object({city: z.string()}),
  requireConfirmation: true,
  execute: () => ({deleted: true}),
});

class FailingLlm extends ScriptedLlm {
  override async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield* [];
    throw new Error('model unavailable');
  }
}

function fakeBigQuery(
  createTableImpl: () => Promise<unknown[]> = () => Promise.resolve([{}]),
) {
  const createTable = vi.fn(createTableImpl);
  const query = vi.fn(() => Promise.resolve([[]]));
  const client: BigQueryClient = {
    dataset: () => ({
      table: () => ({
        getMetadata: () =>
          Promise.reject(Object.assign(new Error('not found'), {code: 404})),
        setMetadata: () => Promise.resolve([{}]),
      }),
      createTable,
    }),
    query,
  };
  return {bigQuery: client as unknown as BigQuery, createTable, query};
}

function makePlugin(
  config: Partial<BigQueryLoggerConfig> = {},
  {
    createTable,
    writeClient = {} as managedwriter.WriterClient,
  }: {
    createTable?: () => Promise<unknown[]>;
    writeClient?: managedwriter.WriterClient;
  } = {},
) {
  const fake = fakeBigQuery(createTable);
  const plugin = new BigQueryAgentAnalyticsPlugin({
    projectId: 'test-project',
    datasetId: 'test_dataset',
    bigQuery: fake.bigQuery,
    writeClient,
    config: {createViews: false, ...config},
  });
  return {plugin, ...fake};
}

async function run({
  plugin,
  responses,
  prompt = 'What is the weather in Oslo?',
  model = new ScriptedLlm(responses),
}: {
  plugin: BigQueryAgentAnalyticsPlugin;
  responses: LlmResponse[];
  prompt?: string;
  model?: BaseLlm;
}) {
  const capture = new ContextCapture();
  const agent = new LlmAgent({
    name: 'weather_agent',
    description: 'Answers weather questions.',
    instruction: 'Answer weather questions.',
    model,
    tools: [getWeather, explode, rememberCity, bookTrip, deleteTrip],
  });
  const runner = new InMemoryRunner({
    agent,
    appName: 'weather_app',
    plugins: [plugin, capture],
  });
  const session = await runner.sessionService.createSession({
    appName: 'weather_app',
    userId: 'user-1',
    state: {region: 'nordics'},
  });
  for await (const _event of runner.runAsync({
    userId: 'user-1',
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: prompt}]},
  })) {
    // Drain the run.
  }
  await plugin.flush();
  return {agent, invocationContext: capture.invocationContext!};
}

function eventTypes(): string[] {
  return appended.map((row) => row['event_type'] as string);
}

function rowsOf(eventType: string): EncodedRow[] {
  return appended.filter((row) => row['event_type'] === eventType);
}

function json(row: EncodedRow | undefined, column: string): unknown {
  const value = row?.[column];
  return typeof value === 'string' ? JSON.parse(value) : value;
}

afterEach(() => {
  appended.length = 0;
  finalizeWriteStream.mockClear();
  vi.restoreAllMocks();
});

function adkOf(row: EncodedRow | undefined): Record<string, unknown> {
  const attributes = json(row, 'attributes') as Record<string, unknown>;
  return attributes['adk'] as Record<string, unknown>;
}

/** A plugin with one finished run, and that run's context for direct calls. */
async function primedPlugin(config: Partial<BigQueryLoggerConfig> = {}) {
  const made = makePlugin(config);
  const {agent, invocationContext} = await run({
    plugin: made.plugin,
    responses: [textResponse('Hello.')],
  });
  appended.length = 0;
  return {...made, agent, invocationContext};
}

function nodeEvent(
  path: string,
  fields: Partial<Event> = {},
  timestamp = 1_700_000_000_000,
): Event {
  return createEvent({
    author: path.split('.').at(-1)?.split('@')[0],
    nodeInfo: {path},
    timestamp,
    ...fields,
  });
}

describe('BigQueryAgentAnalyticsPlugin', () => {
  it('logs a run with a successful tool call', async () => {
    const {plugin, createTable} = makePlugin();
    await run({
      plugin,
      responses: [
        callResponse('get_weather', {city: 'Oslo'}),
        textResponse('It is sunny in Oslo.'),
      ],
    });
    await plugin.shutdown();

    expect(createTable).toHaveBeenCalledOnce();
    expect(eventTypes()).toEqual([
      'USER_MESSAGE_RECEIVED',
      'INVOCATION_STARTING',
      'LLM_REQUEST',
      'LLM_RESPONSE',
      'TOOL_STARTING',
      'TOOL_COMPLETED',
      'LLM_REQUEST',
      'LLM_RESPONSE',
      'AGENT_RESPONSE',
      'INVOCATION_COMPLETED',
    ]);
    for (const row of appended) {
      expect(row['agent']).toBe('weather_agent');
      expect(row['user_id']).toBe('user-1');
      expect(row['trace_id']).toBe(appended[0]['trace_id']);
      expect(row['invocation_id']).toBe(appended[0]['invocation_id']);
    }

    const request = rowsOf('LLM_REQUEST')[0];
    expect(request['status']).toBe('OK');
    expect(JSON.stringify(json(request, 'content'))).toContain('Oslo');
    expect(JSON.stringify(json(request, 'attributes'))).toContain(
      'scripted-model',
    );

    const toolCompleted = rowsOf('TOOL_COMPLETED')[0];
    const toolContent = JSON.stringify(json(toolCompleted, 'content'));
    expect(toolContent).toContain('get_weather');
    expect(toolContent).toContain('sunny');
    expect(toolContent).not.toContain('secret');
    expect(
      Object.values(plugin.getDropStats()).every((count) => count === 0),
    ).toBe(true);
  });

  it('logs a failed tool call as TOOL_ERROR', async () => {
    const {plugin} = makePlugin();
    await run({
      plugin,
      responses: [
        callResponse('explode', {reason: 'test'}),
        textResponse('The tool failed.'),
      ],
      prompt: 'Break it.',
    });
    await plugin.shutdown();

    const toolError = rowsOf('TOOL_ERROR')[0];
    expect(toolError['status']).toBe('ERROR');
    expect(toolError['error_message']).toContain('tool exploded');
    expect(eventTypes()).not.toContain('TOOL_COMPLETED');
    expect(eventTypes().at(-1)).toBe('INVOCATION_COMPLETED');
  });

  it('logs agent lifecycle and error rows when a host reports them', async () => {
    const {plugin} = makePlugin();
    const {agent, invocationContext} = await run({
      plugin,
      responses: [textResponse('Hello.')],
    });
    appended.length = 0;
    const callbackContext = new Context({invocationContext});

    await plugin.beforeAgentCallback({agent, callbackContext});
    await plugin.afterAgentCallback({agent, callbackContext});
    await plugin.beforeAgentCallback({agent, callbackContext});
    await plugin.onAgentErrorCallback({
      agent,
      callbackContext,
      error: new Error('agent failed'),
    });
    await plugin.onRunErrorCallback({
      invocationContext,
      error: new Error('run failed'),
    });
    await plugin.flush();
    await plugin.shutdown();

    expect(eventTypes()).toEqual([
      'AGENT_STARTING',
      'AGENT_COMPLETED',
      'AGENT_STARTING',
      'AGENT_ERROR',
      'INVOCATION_ERROR',
    ]);
    const starting = rowsOf('AGENT_STARTING')[0];
    expect(json(starting, 'content')).toBe('Answer weather questions.');
    expect(JSON.stringify(json(starting, 'attributes'))).toContain(
      'Answers weather questions.',
    );
    const agentError = rowsOf('AGENT_ERROR')[0];
    expect(agentError['error_message']).toBe('agent failed');
    expect(rowsOf('INVOCATION_ERROR')[0]['error_message']).toBe('run failed');
  });

  it('keeps only allowlisted event types', async () => {
    const {plugin} = makePlugin({
      eventAllowlist: ['LLM_REQUEST', 'LLM_RESPONSE'],
    });
    await run({plugin, responses: [textResponse('Hello.')]});
    await plugin.shutdown();

    expect(eventTypes()).toEqual(['LLM_REQUEST', 'LLM_RESPONSE']);
  });

  it('writes nothing and touches no table when disabled', async () => {
    const {plugin, createTable} = makePlugin({enabled: false});
    await run({plugin, responses: [textResponse('Hello.')]});
    await plugin.shutdown();

    expect(appended).toEqual([]);
    expect(createTable).not.toHaveBeenCalled();
  });

  it('creates the analytics views on demand', async () => {
    const {plugin, query} = makePlugin();
    await plugin.createAnalyticsViews();
    await plugin.shutdown();

    expect(query).toHaveBeenCalled();
    expect(JSON.stringify(query.mock.calls)).toContain('v_llm_request');
  });

  it('rejects identifiers that would break the view DDL', () => {
    expect(() => makePlugin({tableId: 'events`; DROP TABLE x; --'})).toThrow(
      RangeError,
    );
    expect(() => makePlugin({viewPrefix: 'v\n'})).toThrow(RangeError);
  });

  it('rejects contradictory configuration', () => {
    expect(() => makePlugin({viewPrefix: ''})).toThrow(RangeError);
    expect(() =>
      makePlugin({
        customMetadataAllowlist: ['tenant'],
        payloadColumnDenylist: ['attributes'],
      }),
    ).toThrow(RangeError);
  });

  it('logs state changes, paused tools and confirmation requests', async () => {
    const {plugin} = makePlugin();
    await run({
      plugin,
      responses: [
        callResponse('remember_city', {city: 'Oslo'}),
        callResponse('book_trip', {city: 'Oslo'}),
        callResponse('delete_trip', {city: 'Oslo'}),
      ],
    });
    await plugin.shutdown();

    expect(
      JSON.stringify(json(rowsOf('STATE_DELTA')[0], 'attributes')),
    ).toContain('last_city');
    expect(eventTypes()).toContain('TOOL_PAUSED');
    expect(eventTypes()).toContain('HITL_CONFIRMATION_REQUEST');
  });

  it('logs a model failure as LLM_ERROR', async () => {
    const {plugin} = makePlugin();
    await run({plugin, responses: [], model: new FailingLlm([])});
    await plugin.shutdown();

    const llmError = rowsOf('LLM_ERROR')[0];
    expect(llmError['status']).toBe('ERROR');
    expect(llmError['error_message']).toContain('model unavailable');
  });

  it('drops rows and retries setup later when the table cannot be created', async () => {
    const {plugin, createTable} = makePlugin(
      {},
      {createTable: () => Promise.reject(new Error('access denied'))},
    );
    await run({plugin, responses: [textResponse('Hello.')]});
    await plugin.shutdown();

    expect(createTable).toHaveBeenCalledOnce();
    expect(appended).toEqual([]);
    expect(plugin.getDropStats()['setup_unavailable']).toBeGreaterThan(0);
    await expect(plugin.createAnalyticsViews()).rejects.toThrow(
      'Plugin initialization failed',
    );
  });

  it('retries a failed setup once the backoff has passed', async () => {
    let failures = 1;
    const {plugin, createTable} = makePlugin(
      {},
      {
        createTable: () =>
          failures-- > 0
            ? Promise.reject(new Error('access denied'))
            : Promise.resolve([{}]),
      },
    );
    await run({plugin, responses: [textResponse('Hello.')]});
    expect(appended).toEqual([]);

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await run({plugin, responses: [textResponse('Hello.')]});
    await plugin.shutdown();

    expect(createTable).toHaveBeenCalledTimes(2);
    expect(eventTypes()).toContain('INVOCATION_COMPLETED');
  });

  it('writes through a committed stream with exactly-once delivery', async () => {
    const createWriteStream = vi.fn(() =>
      Promise.resolve('projects/p/datasets/d/tables/t/streams/committed-1'),
    );
    const {plugin} = makePlugin(
      {exactlyOnceDelivery: true},
      {
        writeClient: {
          createWriteStream,
        } as unknown as managedwriter.WriterClient,
      },
    );
    await run({plugin, responses: [textResponse('Hello.')]});
    await plugin.shutdown();

    expect(createWriteStream).toHaveBeenCalled();
    expect(eventTypes()).toContain('INVOCATION_COMPLETED');
    expect(finalizeWriteStream).toHaveBeenCalled();
  });

  it('creates the eval views on demand', async () => {
    const {plugin, query} = makePlugin();
    await plugin.createEvalViews();
    await plugin.shutdown();

    expect(JSON.stringify(query.mock.calls)).toContain('v_eval_session');
  });

  it('enriches rows with usage, session metadata, tags and formatted content', async () => {
    const {plugin} = makePlugin({
      customTags: {env: 'test'},
      customMetadataAllowlist: ['tenant', 'trace.*'],
      payloadColumnDenylist: ['content_parts'],
      logSessionMetadata: true,
      contentFormatter: (content, eventType) =>
        eventType === 'LLM_RESPONSE' ? {formatted: content} : content,
    });
    await run({
      plugin,
      responses: [
        {
          ...textResponse('Sunny.'),
          modelVersion: 'scripted-001',
          finishReason: FinishReason.STOP,
          usageMetadata: {promptTokenCount: 12, candidatesTokenCount: 3},
          customMetadata: {tenant: 'acme', 'trace.id': 'abc', other: 'no'},
        },
      ],
    });
    await plugin.shutdown();

    const response = rowsOf('LLM_RESPONSE')[0];
    const attributes = json(response, 'attributes') as Record<string, unknown>;
    expect(attributes['model_version']).toBe('scripted-001');
    expect(attributes['custom_tags']).toEqual({env: 'test'});
    expect(attributes['custom_metadata']).toEqual({
      tenant: 'acme',
      'trace.id': 'abc',
    });
    expect(JSON.stringify(attributes['usage_metadata'])).toContain(
      '"prompt_token_count":12',
    );
    expect(JSON.stringify(attributes['session_metadata'])).toContain('nordics');
    expect(JSON.stringify(json(response, 'content'))).toContain('formatted');
    expect(response).not.toHaveProperty('content_parts');
  });

  it('records a content formatter failure without dropping the row', async () => {
    const {plugin} = makePlugin({
      contentFormatter: () => {
        throw new Error('bad formatter');
      },
    });
    await run({plugin, responses: [textResponse('Hello.')]});
    await plugin.shutdown();

    const response = rowsOf('LLM_RESPONSE')[0];
    expect(response['error_message']).toContain('formatter');
    expect(plugin.getDropStats()['formatter_failed']).toBeGreaterThan(0);
  });

  it('leaves the location unset by default', async () => {
    const {plugin, query} = makePlugin();
    await plugin.createAnalyticsViews();
    await plugin.shutdown();

    expect(plugin.location).toBeUndefined();
    expect(query).toHaveBeenCalled();
    for (const [options] of query.mock.calls as unknown as Array<[unknown]>) {
      expect(options).not.toHaveProperty('location');
    }
  });

  it('parses SDK content with unknown part fields, and logs other values as JSON', async () => {
    const {plugin, invocationContext} = await primedPlugin();
    await plugin.onUserMessageCallback({
      invocationContext,
      userMessage: {
        role: 'user',
        parts: [{text: 'hello', futureField: 1} as never],
      },
    });
    await plugin.onEventCallback({
      invocationContext,
      event: nodeEvent('wf@1.step', {output: {text: 'keep this key'}}),
    });
    await plugin.onEventCallback({
      invocationContext,
      event: nodeEvent('wf@1.other', {output: {parts: [{text: 'x'}]}}),
    });
    await plugin.flush();
    await plugin.shutdown();

    const user = rowsOf('USER_MESSAGE_RECEIVED')[0];
    expect(json(user, 'content')).toEqual({text_summary: 'hello'});
    expect((user['content_parts'] as Array<{text: string}>)[0].text).toBe(
      'hello',
    );
    const outputs = rowsOf('NODE_OUTPUT');
    expect(json(outputs[0], 'content')).toEqual({text: 'keep this key'});
    expect(json(outputs[1], 'content')).toEqual({parts: [{text: 'x'}]});
    expect(outputs[0]['content_parts']).toEqual([]);
  });

  it('logs a workflow node output once, without a duplicate AGENT_RESPONSE', async () => {
    const {plugin, invocationContext} = await primedPlugin();
    await plugin.onEventCallback({
      invocationContext,
      event: nodeEvent('wf@1.step', {
        output: 'done',
        content: {role: 'model', parts: [{text: 'done'}]},
      }),
    });
    await plugin.onEventCallback({
      invocationContext,
      event: nodeEvent('wf@1.agent', {
        content: {role: 'model', parts: [{text: 'agent reply'}]},
        nodeInfo: {path: 'wf@1.agent', messageAsOutput: true},
      }),
    });
    await plugin.flush();
    await plugin.shutdown();

    expect(rowsOf('NODE_OUTPUT')).toHaveLength(1);
    const responses = rowsOf('AGENT_RESPONSE');
    expect(responses).toHaveLength(1);
    expect(JSON.stringify(json(responses[0], 'content'))).toContain(
      'agent reply',
    );
  });

  it('attributes runner events to their author and branch', async () => {
    const {plugin, invocationContext} = await primedPlugin();
    await plugin.onEventCallback({
      invocationContext,
      event: createEvent({
        author: 'sub_agent',
        branch: 'weather_agent.sub_agent',
        content: {role: 'model', parts: [{text: 'From the sub-agent.'}]},
      }),
    });
    await plugin.flush();
    await plugin.shutdown();

    const response = rowsOf('AGENT_RESPONSE')[0];
    expect(response['agent']).toBe('sub_agent');
    expect(adkOf(response)['branch']).toBe('weather_agent.sub_agent');
  });

  it('logs compaction as EVENT_COMPACTION in seconds, not as AGENT_RESPONSE', async () => {
    const {plugin, invocationContext} = await primedPlugin();
    await plugin.onEventCallback({
      invocationContext,
      event: {
        ...createEvent({
          author: 'weather_agent',
          content: {role: 'model', parts: [{text: 'Summary so far.'}]},
        }),
        isCompacted: true,
        startTime: 1_700_000_000_000,
        endTime: 1_700_000_005_500,
        compactedContent: 'Summary so far.',
      } as Event,
    });
    await plugin.flush();
    await plugin.shutdown();

    expect(eventTypes()).toEqual(['EVENT_COMPACTION']);
    expect(json(rowsOf('EVENT_COMPACTION')[0], 'content')).toEqual({
      start_timestamp: 1_700_000_000,
      end_timestamp: 1_700_000_005.5,
      compacted_content: "text: 'Summary so far.'",
    });
  });

  it('writes no checkpoint for a null agent state', async () => {
    const {plugin, invocationContext} = await primedPlugin();
    const event = createEvent({author: 'weather_agent'});
    (event.actions as {agentState: unknown}).agentState = null;
    await plugin.onEventCallback({invocationContext, event});
    await plugin.flush();
    await plugin.shutdown();

    expect(eventTypes()).not.toContain('AGENT_STATE_CHECKPOINT');
  });

  it('gives an error row without an opening span a span of its own', async () => {
    const {plugin, invocationContext} = await primedPlugin();
    const toolContext = new Context({invocationContext});
    await plugin.beforeRunCallback({invocationContext});
    await plugin.onToolErrorCallback({
      tool: getWeather,
      toolArgs: {city: 'Oslo'},
      toolContext,
      error: new Error('no such tool'),
    });
    await plugin.onModelErrorCallback({
      callbackContext: new Context({invocationContext}),
      llmRequest: {contents: [], liveConnectConfig: {}, toolsDict: {}},
      error: new Error('model down'),
    });
    await plugin.flush();
    await plugin.shutdown();

    const starting = rowsOf('INVOCATION_STARTING')[0];
    for (const type of ['TOOL_ERROR', 'LLM_ERROR']) {
      const row = rowsOf(type)[0];
      expect(row['span_id']).not.toBe(row['parent_span_id']);
      expect(row['parent_span_id']).toBe(starting['span_id']);
    }
  });

  it('closes an agent and invocation above a model that never completed', async () => {
    const {plugin, agent, invocationContext} = await primedPlugin();
    const callbackContext = new Context({invocationContext});
    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeAgentCallback({agent, callbackContext});
    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: {contents: [], liveConnectConfig: {}, toolsDict: {}},
    });
    await plugin.afterAgentCallback({agent, callbackContext});
    await plugin.afterRunCallback({invocationContext});
    await plugin.flush();
    await plugin.shutdown();

    for (const [start, end] of [
      ['AGENT_STARTING', 'AGENT_COMPLETED'],
      ['INVOCATION_STARTING', 'INVOCATION_COMPLETED'],
    ]) {
      const opening = rowsOf(start)[0];
      const closing = rowsOf(end)[0];
      expect(closing['span_id']).toBe(opening['span_id']);
      expect(closing['parent_span_id']).toBe(opening['parent_span_id']);
    }
    expect(rowsOf('AGENT_COMPLETED')[0]['parent_span_id']).toBe(
      rowsOf('INVOCATION_STARTING')[0]['span_id'],
    );
  });

  it('closes an invocation above an agent and model that never completed', async () => {
    const {plugin, agent, invocationContext} = await primedPlugin();
    const callbackContext = new Context({invocationContext});
    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeAgentCallback({agent, callbackContext});
    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: {contents: [], liveConnectConfig: {}, toolsDict: {}},
    });
    await plugin.afterRunCallback({invocationContext});
    await plugin.flush();
    await plugin.shutdown();

    const opening = rowsOf('INVOCATION_STARTING')[0];
    const closing = rowsOf('INVOCATION_COMPLETED')[0];
    expect(closing['span_id']).toBe(opening['span_id']);
    expect(closing['parent_span_id']).toBe(opening['parent_span_id']);
    expect(closing['parent_span_id']).not.toBe(
      rowsOf('LLM_REQUEST')[0]['span_id'],
    );
  });

  it('keeps concurrent tool calls without ids on separate spans', async () => {
    const {plugin, invocationContext} = await primedPlugin();
    await plugin.beforeRunCallback({invocationContext});
    const first = new Context({invocationContext});
    const second = new Context({invocationContext});
    const toolArgs = {city: 'Oslo'};
    const result = {forecast: 'sunny'};
    await plugin.beforeToolCallback({
      tool: getWeather,
      toolArgs,
      toolContext: first,
    });
    await plugin.beforeToolCallback({
      tool: rememberCity,
      toolArgs,
      toolContext: second,
    });
    await plugin.afterToolCallback({
      tool: getWeather,
      toolArgs,
      toolContext: first,
      result,
    });
    await plugin.afterToolCallback({
      tool: rememberCity,
      toolArgs,
      toolContext: second,
      result,
    });
    await plugin.flush();
    await plugin.shutdown();

    const spanOf = (type: string, tool: string) =>
      rowsOf(type).find((row) =>
        JSON.stringify(json(row, 'content')).includes(tool),
      )?.['span_id'];
    for (const tool of ['get_weather', 'remember_city']) {
      expect(spanOf('TOOL_COMPLETED', tool)).toBe(
        spanOf('TOOL_STARTING', tool),
      );
    }
  });

  it('does not let a stalled end-of-run flush hold up the run', async () => {
    const {plugin, invocationContext} = await primedPlugin({
      shutdownTimeout: 0.05,
    });
    vi.spyOn(plugin, 'flush').mockReturnValue(new Promise(() => undefined));
    await plugin.beforeRunCallback({invocationContext});
    await expect(
      plugin.afterRunCallback({invocationContext}),
    ).resolves.toBeUndefined();
    vi.restoreAllMocks();
    await plugin.shutdown();
  });

  it('accepts finalResponseToolNames as an array', async () => {
    const {plugin} = makePlugin({
      finalResponseToolNames: ['get_weather'] as unknown as Set<string>,
    });
    await run({
      plugin,
      responses: [
        callResponse('get_weather', {city: 'Oslo'}),
        textResponse('Sunny.'),
      ],
    });
    await plugin.shutdown();

    expect(
      rowsOf('AGENT_RESPONSE').some((row) =>
        JSON.stringify(json(row, 'attributes')).includes('source_tool'),
      ),
    ).toBe(true);
  });
});

describe('workflow node observations', () => {
  it('writes a first-observed row per node path and a summary per path when the run ends', async () => {
    const {plugin, invocationContext} = await primedPlugin();
    await plugin.beforeRunCallback({invocationContext});
    const events = [
      nodeEvent('wf@1', {}, 1_700_000_000_000),
      nodeEvent('wf@1.step@2', {}, 1_700_000_001_000),
      nodeEvent(
        'wf@1.step@2',
        {longRunningToolIds: ['call-1']},
        1_700_000_003_500,
      ),
      nodeEvent(
        'wf@1.step@2.leaf',
        {errorCode: 'NODE_FAILED'},
        1_700_000_004_000,
      ),
    ];
    for (const event of events) {
      await plugin.onEventCallback({invocationContext, event});
    }
    await plugin.afterRunCallback({invocationContext});
    await plugin.shutdown();

    const firsts = rowsOf('WORKFLOW_NODE_FIRST_OBSERVED');
    expect(
      firsts.map((row) => (adkOf(row)['node'] as {path: string}).path),
    ).toEqual(['wf@1', 'wf@1.step@2', 'wf@1.step@2.leaf']);
    const firstStep = adkOf(firsts[1]);
    const segmentId = firstStep['workflow_segment_id'];
    expect(segmentId).toEqual(expect.any(String));
    expect(firstStep).toMatchObject({
      node: {path: 'wf@1.step@2', run_id: '2', parent_run_id: '1'},
      source_event_id: events[1].id,
      source_event_timestamp: 1_700_000_001,
      boundary_basis: 'event_observation',
    });

    const summaries = rowsOf('WORKFLOW_NODE_OBSERVATION_SUMMARY');
    expect(summaries).toHaveLength(3);
    const byPath = Object.fromEntries(
      summaries.map((row) => [
        (adkOf(row)['node'] as {path: string}).path,
        adkOf(row),
      ]),
    );
    expect(byPath['wf@1']).toMatchObject({
      workflow_segment_id: segmentId,
      descendant_interrupt_observed: true,
      node_interrupt_observed: false,
    });
    expect(byPath['wf@1.step@2']).toMatchObject({
      node: {path: 'wf@1.step@2', run_id: '2', parent_run_id: '1'},
      first_source_event_id: events[1].id,
      last_source_event_id: events[2].id,
      first_source_event_timestamp: 1_700_000_001,
      last_source_event_timestamp: 1_700_000_003.5,
      source_event_span_ms: 2500,
      observed_event_count: 2,
      node_interrupt_observed: true,
      drain_callback: 'after_run',
      boundary_basis: 'event_observation',
    });
    expect(byPath['wf@1.step@2.leaf']).toMatchObject({
      node: {path: 'wf@1.step@2.leaf', run_id: '', parent_run_id: '2'},
      node_error_observed_count: 1,
    });
    expect(eventTypes().at(-1)).toBe('INVOCATION_COMPLETED');
  });

  it('caps summaries per segment and counts the paths left out', async () => {
    const {plugin, invocationContext} = await primedPlugin({
      maxObservationSummariesPerSegment: 2,
    });
    await plugin.beforeRunCallback({invocationContext});
    for (const path of ['wf', 'wf.a', 'wf.b', 'wf.c', 'wf.b']) {
      await plugin.onEventCallback({invocationContext, event: nodeEvent(path)});
    }
    await plugin.onRunErrorCallback({invocationContext, error: new Error('x')});
    await plugin.shutdown();

    const summaries = rowsOf('WORKFLOW_NODE_OBSERVATION_SUMMARY');
    expect(summaries).toHaveLength(2);
    expect(adkOf(summaries[0])).not.toHaveProperty('truncated_node_count');
    expect(adkOf(summaries[1])).toMatchObject({
      truncated_node_count: 2,
      drain_callback: 'on_run_error',
    });
    expect(rowsOf('WORKFLOW_NODE_FIRST_OBSERVED')).toHaveLength(4);
    expect(plugin.getDropStats()['workflow_observation_capacity']).toBe(2);
  });

  it('opens a new segment for each runner call, and none for denied summaries', async () => {
    const {plugin, invocationContext} = await primedPlugin({
      eventDenylist: ['WORKFLOW_NODE_OBSERVATION_SUMMARY'],
      maxObservationSummariesPerSegment: 1,
    });
    for (let call = 0; call < 2; call += 1) {
      await plugin.beforeRunCallback({invocationContext});
      await plugin.onEventCallback({invocationContext, event: nodeEvent('wf')});
      await plugin.onEventCallback({
        invocationContext,
        event: nodeEvent('wf.a'),
      });
      await plugin.afterRunCallback({invocationContext});
    }
    await plugin.shutdown();

    const segments = new Set(
      rowsOf('WORKFLOW_NODE_FIRST_OBSERVED').map(
        (row) => adkOf(row)['workflow_segment_id'],
      ),
    );
    expect(segments.size).toBe(2);
    expect(rowsOf('WORKFLOW_NODE_OBSERVATION_SUMMARY')).toEqual([]);
    expect(
      plugin.getDropStats()['workflow_observation_capacity'],
    ).toBeUndefined();
  });

  it('rejects a summary cap below one', () => {
    expect(() => makePlugin({maxObservationSummariesPerSegment: 0})).toThrow(
      RangeError,
    );
  });
});
