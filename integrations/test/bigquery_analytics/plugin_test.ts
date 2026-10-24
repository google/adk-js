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
      finalizeWriteStream: async () => undefined,
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
});

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
    await expect(plugin.createAnalyticsViews()).rejects.toThrow(
      'Plugin initialization failed',
    );
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
});
