/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Query,
  type TableField,
  type TableMetadata,
} from '@google-cloud/bigquery';
import {logger} from '@google/adk';
import {type BigQueryLoggerConfig} from './config.js';
import {
  SCHEMA_VERSION,
  SCHEMA_VERSION_LABEL_KEY,
  mergeUpdated,
  schemaFieldsMatch,
} from './schema.js';
import {
  type EvalViewParams,
  analyticsViewStatements,
  buildEvalSessionViewSql,
  buildEvalTurnViewSql,
} from './views.js';

/** The part of a `@google-cloud/bigquery` `Table` this module uses. */
export interface TableHandle {
  getMetadata: () => Promise<[TableMetadata, ...Array<unknown>]>;
  setMetadata: (metadata: TableMetadata) => Promise<ReadonlyArray<unknown>>;
}

export interface DatasetHandle {
  table: (tableId: string) => TableHandle;
  createTable: (
    tableId: string,
    options: TableMetadata,
  ) => Promise<ReadonlyArray<unknown>>;
}

/**
 * The part of a `@google-cloud/bigquery` `BigQuery` client this module uses; a
 * `BigQuery` instance satisfies it.
 */
export interface BigQueryClient {
  dataset: (datasetId: string) => DatasetHandle;
  query: (query: Query) => Promise<ReadonlyArray<unknown>>;
}

export interface EventsTableLocation {
  client: BigQueryClient;
  projectId: string;
  datasetId: string;
  tableId: string;
  /**
   * BigQuery location for the view DDL jobs; the client's default when omitted.
   */
  location?: string;
}

export interface ViewSetup extends EventsTableLocation {
  config: Pick<BigQueryLoggerConfig, 'viewPrefix'>;
  denied: ReadonlySet<string>;
}

export interface EventsTableSetup extends EventsTableLocation {
  /**
   * The desired events schema, already projected by `payloadColumnDenylist`.
   */
  schema: Array<TableField>;
  config: BigQueryLoggerConfig;
  denied: ReadonlySet<string>;
}

interface PendingView {
  viewName: string;
  build: () => string;
}

function hasErrorCode(cause: unknown, code: number): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === code;
}

function fullTableIdOf({
  projectId,
  datasetId,
  tableId,
}: EventsTableLocation): string {
  return `${projectId}.${datasetId}.${tableId}`;
}

function fieldNames(fields: ReadonlyArray<TableField>): string {
  return `[${fields.map((field) => `'${field.name ?? ''}'`).join(', ')}]`;
}

async function runViewStatements({
  client,
  location,
  views,
}: {
  client: BigQueryClient;
  location: string | undefined;
  views: ReadonlyArray<PendingView>;
}): Promise<boolean> {
  let createdAll = true;
  for (const {viewName, build} of views) {
    try {
      const query: Query = {query: build()};
      if (location !== undefined) {
        query.location = location;
      }
      // One DDL job at a time, as in adk-python, stays under the dataset
      // metadata update rate limit.
      await client.query(query);
    } catch (error) {
      if (hasErrorCode(error, 409)) {
        logger.debug(
          `View ${viewName} was updated concurrently by another process.`,
        );
        continue;
      }
      createdAll = false;
      logger.error(`Failed to create view ${viewName}:`, error);
    }
  }
  return createdAll;
}

/**
 * Creates the per-event-type views with `CREATE OR REPLACE VIEW`, so repeating
 * it is safe. Failures are logged, never thrown. Returns whether every view was
 * created.
 */
export function createAnalyticsViews({
  config,
  denied,
  ...table
}: ViewSetup): Promise<boolean> {
  const statements = analyticsViewStatements({
    projectId: table.projectId,
    datasetId: table.datasetId,
    tableId: table.tableId,
    viewPrefix: config.viewPrefix,
    denied,
  });
  return runViewStatements({
    client: table.client,
    location: table.location,
    views: statements.map(({viewName, sql}) => ({viewName, build: () => sql})),
  });
}

/**
 * Creates the `{viewPrefix}_eval_session` and `{viewPrefix}_eval_turn` views.
 * Failures, including a config the views cannot be built for, are logged, never
 * thrown. Returns whether both views were created.
 */
export function createEvalViews({
  config,
  denied,
  ...table
}: ViewSetup): Promise<boolean> {
  const params: EvalViewParams = {
    fullTableId: fullTableIdOf(table),
    viewPrefix: config.viewPrefix,
    denied,
  };
  return runViewStatements({
    client: table.client,
    location: table.location,
    views: [
      {
        viewName: `${config.viewPrefix}_eval_session`,
        build: () => buildEvalSessionViewSql(params),
      },
      {
        viewName: `${config.viewPrefix}_eval_turn`,
        build: () => buildEvalTurnViewSql(params),
      },
    ],
  });
}

/**
 * Adds the columns `schema` has and the table lacks (additive only, recursing
 * into RECORDs), then stamps the schema version label in the same update, so a
 * failed upgrade is retried on the next run. A failed label-only refresh is
 * logged and ignored, since the table is still write-compatible.
 */
async function maybeUpgradeSchema({
  table,
  metadata,
  schema,
  fullTableId,
}: {
  table: TableHandle;
  metadata: TableMetadata;
  schema: ReadonlyArray<TableField>;
  fullTableId: string;
}): Promise<void> {
  const existingFields = metadata.schema?.fields ?? [];
  const {newFields, updatedRecords} = schemaFieldsMatch({
    existing: existingFields,
    desired: schema,
  });
  const changed = newFields.length > 0 || updatedRecords.length > 0;
  const labels = metadata.labels ?? {};

  // The label alone cannot short-circuit this: the desired schema depends on
  // payloadColumnDenylist, so a relaxed denylist makes columns desired again on
  // a table whose label is already current.
  if (!changed && labels[SCHEMA_VERSION_LABEL_KEY] === SCHEMA_VERSION) {
    return;
  }

  let fields = existingFields;
  if (changed) {
    fields = [
      ...mergeUpdated({fields: existingFields, updated: updatedRecords}),
      ...newFields,
    ];
    const changes: Array<string> = [];
    if (newFields.length > 0) {
      changes.push(`new columns ${fieldNames(newFields)}`);
    }
    if (updatedRecords.length > 0) {
      changes.push(`updated RECORD fields ${fieldNames(updatedRecords)}`);
    }
    logger.info(`Auto-upgrading table ${fullTableId}: ${changes.join(', ')}`);
  }

  try {
    await table.setMetadata({
      schema: {fields},
      labels: {...labels, [SCHEMA_VERSION_LABEL_KEY]: SCHEMA_VERSION},
    });
  } catch (error) {
    logger.error(`Schema auto-upgrade failed for ${fullTableId}:`, error);
    if (changed) {
      throw error;
    }
  }
}

async function createViewsIfConfigured({
  config,
  denied,
  ...table
}: EventsTableSetup): Promise<boolean> {
  let viewsOk = true;
  if (config.createViews) {
    viewsOk =
      (await createAnalyticsViews({...table, config, denied})) && viewsOk;
  }
  if (config.createEvalViews) {
    viewsOk = (await createEvalViews({...table, config, denied})) && viewsOk;
  }
  return viewsOk;
}

async function upgradeExistingTable({
  table,
  schema,
  config,
  fullTableId,
}: {
  table: TableHandle;
  schema: ReadonlyArray<TableField>;
  config: Pick<BigQueryLoggerConfig, 'autoSchemaUpgrade'>;
  fullTableId: string;
}): Promise<void> {
  const [metadata] = await table.getMetadata();
  if (config.autoSchemaUpgrade) {
    await maybeUpgradeSchema({table, metadata, schema, fullTableId});
  }
}

async function ensureEventsTableReady(
  setup: EventsTableSetup,
): Promise<boolean> {
  const {client, datasetId, tableId, schema, config} = setup;
  const fullTableId = fullTableIdOf(setup);
  const dataset = client.dataset(datasetId);
  const table = dataset.table(tableId);

  try {
    await upgradeExistingTable({table, schema, config, fullTableId});
  } catch (error) {
    if (!hasErrorCode(error, 404)) {
      logger.error(`Error ensuring table ${fullTableId} is ready:`, error);
      throw error;
    }
    logger.info(`Table ${fullTableId} not found, creating table.`);
    try {
      await dataset.createTable(tableId, {
        schema: {fields: schema},
        timePartitioning: {type: 'DAY', field: 'timestamp'},
        clustering: {fields: [...config.clusteringFields]},
        labels: {[SCHEMA_VERSION_LABEL_KEY]: SCHEMA_VERSION},
      });
    } catch (createError) {
      if (!hasErrorCode(createError, 409)) {
        logger.error(`Could not create table ${fullTableId}:`, createError);
        throw createError;
      }
      // A concurrent creator may have used an incompatible schema, so it takes
      // the existing-table path.
      await upgradeExistingTable({table, schema, config, fullTableId});
    }
  }
  return createViewsIfConfigured(setup);
}

function notifySchemaCallback(
  name: 'onSchemaError' | 'onSchemaReady',
  invoke: () => Promise<void> | void,
): void {
  try {
    const result = invoke();
    if (result instanceof Promise) {
      result.catch(() => undefined);
      logger.warn(
        `BigQueryLoggerConfig.${name} returned a promise; callback must be synchronous.`,
      );
    }
  } catch (error) {
    logger.warn(
      `Exception raised by BigQueryLoggerConfig.${name} callback`,
      error,
    );
  }
}

/**
 * Ensures the events table exists with the desired schema: creates it
 * (DAY-partitioned on `timestamp`, clustered, version-labelled) or upgrades it
 * additively when `autoSchemaUpgrade` is on, then creates the configured views.
 * A missing or unready table throws after `onSchemaError`; view failures do not
 * throw.
 *
 * @returns true when the table is ready and every requested view was created
 *   (then `onSchemaReady` runs), false when a view failed and the pass is
 *   worth repeating.
 */
export async function ensureEventsTable(
  setup: EventsTableSetup,
): Promise<boolean> {
  const {onSchemaError, onSchemaReady} = setup.config;
  let ready: boolean;
  try {
    ready = await ensureEventsTableReady(setup);
  } catch (error) {
    if (onSchemaError !== null) {
      notifySchemaCallback('onSchemaError', () => onSchemaError(error));
    }
    throw error;
  }
  if (ready && onSchemaReady !== null) {
    notifySchemaCallback('onSchemaReady', onSchemaReady);
  }
  return ready;
}
