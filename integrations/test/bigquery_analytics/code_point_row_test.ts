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
  InMemoryRunner,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {BigQueryAgentAnalyticsPlugin} from '../../src/bigquery_analytics/index.js';
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

class EmojiLlm extends BaseLlm {
  constructor() {
    super({model: 'emoji-model'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield {content: {role: 'model', parts: [{text: '😀a'}]}};
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connections are not used in this test.');
  }
}

describe('row construction', () => {
  it('bounds content in code points, like the parser', async () => {
    const client = {
      dataset: () => ({
        table: () => ({
          getMetadata: () =>
            Promise.reject(Object.assign(new Error('nf'), {code: 404})),
          setMetadata: () => Promise.resolve([{}]),
        }),
        createTable: () => Promise.resolve([{}]),
      }),
      query: () => Promise.resolve([[]]),
    } as BigQueryClient;
    const plugin = new BigQueryAgentAnalyticsPlugin({
      projectId: 'test-project',
      datasetId: 'test_dataset',
      bigQuery: client as unknown as BigQuery,
      writeClient: {} as managedwriter.WriterClient,
      config: {createViews: false, maxContentLength: 2},
    });
    const runner = new InMemoryRunner({
      agent: new LlmAgent({name: 'emoji_agent', model: new EmojiLlm()}),
      appName: 'emoji_app',
      plugins: [plugin],
    });
    const session = await runner.sessionService.createSession({
      appName: 'emoji_app',
      userId: 'user-1',
    });
    for await (const _event of runner.runAsync({
      userId: 'user-1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: '😀a'}]},
    })) {
      // Drain the run.
    }
    await plugin.flush();
    await plugin.shutdown();

    const message = appended.find(
      (row) => row['event_type'] === 'USER_MESSAGE_RECEIVED',
    );
    expect(message?.['content']).toBe('{"text_summary":"😀a"}');
    expect(message?.['content_parts']).toMatchObject([{text: '😀a'}]);
  });
});
