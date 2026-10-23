/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BigQuery,
  type Query,
  type TableField,
  type TableMetadata,
} from '@google-cloud/bigquery';
import {describe, expect, it, vi} from 'vitest';
import {
  type BigQueryLoggerConfig,
  resolveLoggerConfig,
} from '../../src/bigquery_analytics/config.js';
import {
  SCHEMA_VERSION,
  SCHEMA_VERSION_LABEL_KEY,
  getEventsSchema,
} from '../../src/bigquery_analytics/schema.js';
import {
  type BigQueryClient,
  createAnalyticsViews,
  createEvalViews,
  ensureEventsTable,
} from '../../src/bigquery_analytics/table_setup.js';
import {EVENT_VIEW_DEFS} from '../../src/bigquery_analytics/views.js';

const viewStatements = vi.hoisted(() => ({throwOnBuild: false}));

vi.mock('../../src/bigquery_analytics/views.js', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('../../src/bigquery_analytics/views.js')
    >();
  return {
    ...original,
    analyticsViewStatements: (
      ...args: Parameters<typeof original.analyticsViewStatements>
    ) => {
      if (viewStatements.throwOnBuild) {
        throw new RangeError('invalid identifier');
      }
      return original.analyticsViewStatements(...args);
    },
  };
});

class ApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

function notFound(): ApiError {
  return new ApiError('not found', 404);
}

function conflict(): ApiError {
  return new ApiError('already exists', 409);
}

interface FakeOptions {
  getMetadata?: () => Promise<[TableMetadata]>;
  setMetadata?: (metadata: TableMetadata) => Promise<ReadonlyArray<unknown>>;
  createTable?: (
    tableId: string,
    options: TableMetadata,
  ) => Promise<ReadonlyArray<unknown>>;
  query?: (query: Query) => Promise<ReadonlyArray<unknown>>;
}

function fakeClient(options: FakeOptions) {
  const getMetadata = vi.fn(
    options.getMetadata ?? (() => Promise.reject(notFound())),
  );
  const setMetadata = vi.fn(
    options.setMetadata ?? (() => Promise.resolve([{}])),
  );
  const createTable = vi.fn(
    options.createTable ?? (() => Promise.resolve([{}])),
  );
  const query = vi.fn(options.query ?? (() => Promise.resolve([[]])));
  const dataset = vi.fn(
    (
      _datasetId: string,
      _options?: {projectId?: string; location?: string},
    ) => ({
      table: () => ({getMetadata, setMetadata}),
      createTable,
    }),
  );
  const client: BigQueryClient = {dataset, query};
  return {client, dataset, getMetadata, setMetadata, createTable, query};
}

function existingTable(
  fields: Array<TableField>,
  labels: Record<string, string> = {},
) {
  return () => Promise.resolve<[TableMetadata]>([{schema: {fields}, labels}]);
}

function ensure({
  client,
  config = {},
  schema = getEventsSchema(),
  denied = new Set<string>(),
}: {
  client: BigQueryClient;
  config?: Partial<BigQueryLoggerConfig>;
  schema?: Array<TableField>;
  denied?: ReadonlySet<string>;
}) {
  return ensureEventsTable({
    client,
    projectId: 'test-project',
    datasetId: 'test_dataset',
    tableId: 'agent_events',
    schema,
    config: resolveLoggerConfig({createViews: false, ...config}),
    denied,
  });
}

function updatedMetadata(
  setMetadata: ReturnType<typeof fakeClient>['setMetadata'],
): TableMetadata {
  return setMetadata.mock.calls[0]?.[0] ?? {};
}

function fieldNamesOf(metadata: TableMetadata) {
  return (metadata.schema?.fields ?? []).map((field) => field.name);
}

describe('BigQueryClient', () => {
  it('is satisfied by a real BigQuery client', () => {
    const client: BigQueryClient = new BigQuery({projectId: 'p'});
    expect(client).toBeDefined();
  });
});

describe('ensureEventsTable: table creation', () => {
  it('creates a DAY-partitioned, clustered table carrying the schema version label', async () => {
    const fake = fakeClient({});
    await expect(ensure({client: fake.client})).resolves.toBe(true);
    expect(fake.createTable).toHaveBeenCalledOnce();
    expect(fake.createTable.mock.calls[0]?.[1]).toEqual({
      schema: {fields: getEventsSchema()},
      timePartitioning: {type: 'DAY', field: 'timestamp'},
      clustering: {fields: ['event_type', 'agent', 'user_id']},
      labels: {[SCHEMA_VERSION_LABEL_KEY]: SCHEMA_VERSION},
    });
  });

  it('omits clustering when clusteringFields is empty', async () => {
    const fake = fakeClient({});
    await ensure({client: fake.client, config: {clusteringFields: []}});
    expect(fake.createTable.mock.calls[0]?.[1]).not.toHaveProperty(
      'clustering',
    );
  });

  it('addresses the dataset in the configured project, without a location by default', async () => {
    const fake = fakeClient({});
    await ensure({client: fake.client});
    expect(fake.dataset).toHaveBeenCalledWith('test_dataset', {
      projectId: 'test-project',
    });
  });

  it('passes the location to the dataset when set', async () => {
    const fake = fakeClient({});
    await ensureEventsTable({
      client: fake.client,
      projectId: 'p',
      datasetId: 'd',
      tableId: 't',
      location: 'EU',
      schema: getEventsSchema(),
      config: resolveLoggerConfig({createViews: false}),
      denied: new Set(),
    });
    expect(fake.dataset).toHaveBeenCalledWith('d', {
      projectId: 'p',
      location: 'EU',
    });
  });

  it('re-runs the existing-table path on a concurrently created table', async () => {
    const getMetadata = vi
      .fn<() => Promise<[TableMetadata]>>()
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce([
        {
          schema: {
            fields: [{name: 'timestamp', type: 'TIMESTAMP', mode: 'REQUIRED'}],
          },
          labels: {},
        },
      ]);
    const fake = fakeClient({
      getMetadata,
      createTable: () => Promise.reject(conflict()),
    });
    await expect(ensure({client: fake.client})).resolves.toBe(true);
    expect(getMetadata).toHaveBeenCalledTimes(2);
    expect(fake.setMetadata).toHaveBeenCalledOnce();
    expect(fieldNamesOf(updatedMetadata(fake.setMetadata))).toContain(
      'event_type',
    );
  });

  it('propagates a failed re-fetch after a conflict', async () => {
    const getMetadata = vi
      .fn<() => Promise<[TableMetadata]>>()
      .mockRejectedValueOnce(notFound())
      .mockRejectedValueOnce(new ApiError('control plane down', 503));
    const fake = fakeClient({
      getMetadata,
      createTable: () => Promise.reject(conflict()),
    });
    await expect(ensure({client: fake.client})).rejects.toThrow(
      'control plane down',
    );
  });

  it('propagates a create failure and creates no views', async () => {
    const fake = fakeClient({
      createTable: () => Promise.reject(new ApiError('denied', 403)),
    });
    await expect(
      ensure({client: fake.client, config: {createViews: true}}),
    ).rejects.toThrow('denied');
    expect(fake.query).not.toHaveBeenCalled();
  });
});

describe('ensureEventsTable: schema upgrade', () => {
  it('leaves an existing table alone when auto-upgrade is off', async () => {
    const fake = fakeClient({
      getMetadata: existingTable([{name: 'timestamp', type: 'TIMESTAMP'}]),
    });
    await ensure({client: fake.client, config: {autoSchemaUpgrade: false}});
    expect(fake.setMetadata).not.toHaveBeenCalled();
  });

  it('adds missing columns after existing ones and stamps the label, keeping other labels', async () => {
    const fake = fakeClient({
      getMetadata: existingTable(
        [
          {name: 'timestamp', type: 'TIMESTAMP', mode: 'REQUIRED'},
          {name: 'event_type', type: 'STRING'},
          {name: 'my_custom_col', type: 'STRING'},
        ],
        {other: 'label'},
      ),
    });
    await ensure({client: fake.client});
    const metadata = updatedMetadata(fake.setMetadata);
    const names = fieldNamesOf(metadata);
    expect(names.slice(0, 3)).toEqual([
      'timestamp',
      'event_type',
      'my_custom_col',
    ]);
    expect(names).toEqual(
      expect.arrayContaining(['event_id', 'agent', 'content']),
    );
    expect(metadata.labels).toEqual({
      other: 'label',
      [SCHEMA_VERSION_LABEL_KEY]: SCHEMA_VERSION,
    });
  });

  it('skips the update when columns and label are current', async () => {
    const fake = fakeClient({
      getMetadata: existingTable(getEventsSchema(), {
        [SCHEMA_VERSION_LABEL_KEY]: SCHEMA_VERSION,
      }),
    });
    await ensure({client: fake.client});
    expect(fake.setMetadata).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([{}, {[SCHEMA_VERSION_LABEL_KEY]: '0'}])(
    'stamps a missing or older label (%o)',
    async (labels) => {
      const fake = fakeClient({
        getMetadata: existingTable(getEventsSchema(), labels),
      });
      await ensure({client: fake.client});
      expect(fake.setMetadata).toHaveBeenCalledOnce();
      expect(updatedMetadata(fake.setMetadata)).toEqual({
        labels: {...labels, [SCHEMA_VERSION_LABEL_KEY]: SCHEMA_VERSION},
      });
    },
  );

  it('re-adds columns a relaxed denylist makes desired again, even with a current label', async () => {
    const projected = getEventsSchema().filter(
      (field) => field.name !== 'attributes',
    );
    const fake = fakeClient({
      getMetadata: existingTable(projected, {
        [SCHEMA_VERSION_LABEL_KEY]: SCHEMA_VERSION,
      }),
    });
    await ensure({client: fake.client});
    expect(fieldNamesOf(updatedMetadata(fake.setMetadata)).at(-1)).toBe(
      'attributes',
    );
  });

  it('throws when an additive upgrade fails', async () => {
    const fake = fakeClient({
      getMetadata: existingTable([
        {name: 'timestamp', type: 'TIMESTAMP', mode: 'REQUIRED'},
      ]),
      setMetadata: () => Promise.reject(new Error('boom')),
    });
    await expect(ensure({client: fake.client})).rejects.toThrow('boom');
  });

  it('tolerates a failed label-only refresh', async () => {
    const fake = fakeClient({
      getMetadata: existingTable(getEventsSchema()),
      setMetadata: () => Promise.reject(new Error('labels policy')),
    });
    await expect(ensure({client: fake.client})).resolves.toBe(true);
  });

  it.each([
    ['STRING', 'REQUIRED'],
    ['TIMESTAMP', 'NULLABLE'],
  ])(
    'rejects an incompatible existing timestamp (%s/%s) without updating',
    async (type, mode) => {
      const fake = fakeClient({
        getMetadata: existingTable([{name: 'timestamp', type, mode}]),
      });
      await expect(ensure({client: fake.client})).rejects.toThrow(/timestamp/);
      expect(fake.setMetadata).not.toHaveBeenCalled();
    },
  );

  it('merges a new nested sub-field', async () => {
    const fake = fakeClient({
      getMetadata: existingTable([
        {name: 'timestamp', type: 'TIMESTAMP'},
        {
          name: 'metadata',
          type: 'RECORD',
          fields: [{name: 'key', type: 'STRING'}],
        },
      ]),
    });
    await ensure({
      client: fake.client,
      schema: [
        {name: 'timestamp', type: 'TIMESTAMP'},
        {
          name: 'metadata',
          type: 'RECORD',
          fields: [
            {name: 'key', type: 'STRING'},
            {name: 'value', type: 'STRING'},
          ],
        },
      ],
    });
    const metadata = updatedMetadata(fake.setMetadata).schema?.fields?.find(
      (field) => field.name === 'metadata',
    );
    expect(metadata?.fields?.map((field) => field.name)).toEqual([
      'key',
      'value',
    ]);
  });
});

describe('ensureEventsTable: views', () => {
  it('creates every per-event view on a new table', async () => {
    const fake = fakeClient({});
    await expect(
      ensure({client: fake.client, config: {createViews: true}}),
    ).resolves.toBe(true);
    expect(fake.query).toHaveBeenCalledTimes(
      Object.keys(EVENT_VIEW_DEFS).length,
    );
  });

  it('creates views for an existing table, passing the location', async () => {
    const fake = fakeClient({
      getMetadata: existingTable(getEventsSchema(), {
        [SCHEMA_VERSION_LABEL_KEY]: SCHEMA_VERSION,
      }),
    });
    await ensureEventsTable({
      client: fake.client,
      projectId: 'p',
      datasetId: 'd',
      tableId: 't',
      location: 'EU',
      schema: getEventsSchema(),
      config: resolveLoggerConfig(),
      denied: new Set(),
    });
    expect(fake.query.mock.calls[0]?.[0]).toMatchObject({location: 'EU'});
  });

  it('sends no location with view DDL by default', async () => {
    const fake = fakeClient({});
    await ensure({client: fake.client, config: {createViews: true}});
    expect(fake.query.mock.calls[0]?.[0]).not.toHaveProperty('location');
  });

  it('reports analytics view statements that cannot be built as false without throwing', async () => {
    const fake = fakeClient({});
    viewStatements.throwOnBuild = true;
    try {
      await expect(
        createAnalyticsViews({
          client: fake.client,
          projectId: 'p',
          datasetId: 'd',
          tableId: 't',
          config: resolveLoggerConfig(),
          denied: new Set(),
        }),
      ).resolves.toBe(false);
    } finally {
      viewStatements.throwOnBuild = false;
    }
    expect(fake.query).not.toHaveBeenCalled();
  });

  it('reports a view failure as false without throwing, and still tries every view', async () => {
    const fake = fakeClient({
      query: () => Promise.reject(new Error('view failed')),
    });
    await expect(
      ensure({client: fake.client, config: {createViews: true}}),
    ).resolves.toBe(false);
    expect(fake.query).toHaveBeenCalledTimes(
      Object.keys(EVENT_VIEW_DEFS).length,
    );
  });

  it('counts a concurrent view update as created', async () => {
    const fake = fakeClient({query: () => Promise.reject(conflict())});
    await expect(
      ensure({
        client: fake.client,
        config: {createViews: true, createEvalViews: true},
      }),
    ).resolves.toBe(true);
  });

  it('creates the eval views only when enabled', async () => {
    const off = fakeClient({});
    await ensure({client: off.client});
    expect(off.query).not.toHaveBeenCalled();

    const on = fakeClient({});
    await ensure({client: on.client, config: {createEvalViews: true}});
    expect(
      on.query.mock.calls.map(([query]) => query.query?.split('\n')[0]),
    ).toEqual([
      'CREATE OR REPLACE VIEW `test-project.test_dataset.v_eval_session` AS',
      'CREATE OR REPLACE VIEW `test-project.test_dataset.v_eval_turn` AS',
    ]);
  });

  it('reports an eval view that cannot be built as a failure', async () => {
    const fake = fakeClient({});
    await expect(
      createEvalViews({
        client: fake.client,
        projectId: 'p',
        datasetId: 'd',
        tableId: 't',
        config: {viewPrefix: 'v'},
        denied: new Set(['content']),
      }),
    ).resolves.toBe(false);
    expect(fake.query).not.toHaveBeenCalled();
  });
});

describe('ensureEventsTable: schema callbacks', () => {
  it('calls onSchemaReady, not onSchemaError, when the table is ready', async () => {
    const onSchemaError = vi.fn();
    const onSchemaReady = vi.fn();
    await ensure({
      client: fakeClient({}).client,
      config: {onSchemaError, onSchemaReady},
    });
    expect(onSchemaReady).toHaveBeenCalledOnce();
    expect(onSchemaError).not.toHaveBeenCalled();
  });

  it('calls neither when a view fails', async () => {
    const onSchemaError = vi.fn();
    const onSchemaReady = vi.fn();
    const fake = fakeClient({
      query: () => Promise.reject(new Error('view failed')),
    });
    await ensure({
      client: fake.client,
      config: {createViews: true, onSchemaError, onSchemaReady},
    });
    expect(onSchemaReady).not.toHaveBeenCalled();
    expect(onSchemaError).not.toHaveBeenCalled();
  });

  it.each<[string, FakeOptions]>([
    [
      'get failure',
      {getMetadata: () => Promise.reject(new ApiError('unavailable', 503))},
    ],
    [
      'create failure',
      {createTable: () => Promise.reject(new ApiError('denied', 403))},
    ],
    [
      'incompatible schema',
      {getMetadata: existingTable([{name: 'timestamp', type: 'STRING'}])},
    ],
    [
      'additive upgrade failure',
      {
        getMetadata: existingTable([
          {name: 'timestamp', type: 'TIMESTAMP', mode: 'REQUIRED'},
        ]),
        setMetadata: () => Promise.reject(new Error('boom')),
      },
    ],
  ])(
    'calls onSchemaError with the error on %s, then rethrows it',
    async (_name, options) => {
      const onSchemaError = vi.fn<(cause: unknown) => void>();
      const onSchemaReady = vi.fn();
      const result = ensure({
        client: fakeClient(options).client,
        config: {onSchemaError, onSchemaReady},
      });
      await expect(result).rejects.toBeInstanceOf(Error);
      const [thrown] = onSchemaError.mock.calls[0] ?? [];
      await expect(result).rejects.toBe(thrown);
      expect(onSchemaReady).not.toHaveBeenCalled();
    },
  );

  it('does not call onSchemaError for a failed label-only refresh', async () => {
    const onSchemaError = vi.fn();
    const fake = fakeClient({
      getMetadata: existingTable(getEventsSchema()),
      setMetadata: () => Promise.reject(new Error('x')),
    });
    await ensure({client: fake.client, config: {onSchemaError}});
    expect(onSchemaError).not.toHaveBeenCalled();
  });

  it('suppresses an exception thrown by a callback', async () => {
    const fake = fakeClient({
      getMetadata: () => Promise.reject(new ApiError('unavailable', 503)),
    });
    await expect(
      ensure({
        client: fake.client,
        config: {
          onSchemaError: () => {
            throw new Error('callback bug');
          },
        },
      }),
    ).rejects.toThrow('unavailable');
    await expect(
      ensure({
        client: fakeClient({}).client,
        config: {
          onSchemaReady: () => {
            throw new Error('callback bug');
          },
        },
      }),
    ).resolves.toBe(true);
  });

  it('swallows a promise returned by a callback', async () => {
    const onSchemaReady = vi.fn(() =>
      Promise.reject(new Error('async callback')),
    );
    await expect(
      ensure({client: fakeClient({}).client, config: {onSchemaReady}}),
    ).resolves.toBe(true);
    expect(onSchemaReady).toHaveBeenCalledOnce();
  });
});
