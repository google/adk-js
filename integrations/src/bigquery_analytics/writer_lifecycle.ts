/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BigQuery} from '@google-cloud/bigquery';
import {type managedwriter} from '@google-cloud/bigquery-storage';
import type {Storage} from '@google-cloud/storage';
import {logger} from '@google/adk';
import {BatchProcessor} from './batch_processor.js';
import {type BigQueryLoggerConfig} from './config.js';
import {HybridContentParser} from './content_parser.js';
import {GcsOffloader} from './gcs_offloader.js';
import {getEventsSchema, projectSchema} from './schema.js';
import {
  createAnalyticsViews,
  createEvalViews,
  ensureEventsTable,
  type EventsTableLocation,
} from './table_setup.js';
import {type DropStats, type EventRow} from './types.js';
import {validateEvalViewConfig} from './views.js';
import {
  closeWriteClient,
  createCommittedWriteStream,
  createWriteClient,
} from './write_client.js';

export type SetupOutcome = 'ok' | 'disabled' | 'failed' | 'aborted';

interface WriterState {
  writeClient: managedwriter.WriterClient;
  batchProcessor: BatchProcessor;
}

export interface WriterLifecycleOptions {
  projectId: string;
  datasetId: string;
  tableId: string;
  /** Dataset location; BigQuery infers it from the dataset when undefined. */
  location?: string | undefined;
  config: BigQueryLoggerConfig;
  deniedColumns: ReadonlySet<string>;
  bigQuery: BigQuery | null;
  storage: Storage | null;
  writeClient: managedwriter.WriterClient | null;
}

function monotonicSeconds(): number {
  return performance.now() / 1000;
}

class SetupAbortedError extends Error {
  override readonly name = 'SetupAbortedError';
}

/**
 * The plugin's clients, table readiness, content parser and batch writer, with
 * setup retried after a bounded backoff and torn down once by `shutdown()`,
 * after which it never starts again. Drop counts survive teardown.
 */
export class WriterLifecycle {
  private readonly options: WriterLifecycleOptions;
  private readonly localDropCounts = new Map<string, number>();

  private client: BigQuery | null;
  private parserState: HybridContentParser | null = null;
  private writer: WriterState | null = null;
  /** A writer being released, still counted by `getDropStats()`. */
  private releasing: WriterState | null = null;
  private tableReady = false;

  private startedState = false;
  private shuttingDown = false;
  private generation = 0;
  private setupPromise: Promise<SetupOutcome> | null = null;
  private startupError: unknown = null;
  private setupFailures = 0;
  private setupRetryAt = 0;
  private shutdownPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: WriterLifecycleOptions) {
    this.options = options;
    this.client = options.bigQuery;
  }

  get started(): boolean {
    return this.startedState;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  get parser(): HybridContentParser | null {
    return this.parserState;
  }

  countLocalDrop(reason: string, count = 1): void {
    this.localDropCounts.set(
      reason,
      (this.localDropCounts.get(reason) ?? 0) + count,
    );
  }

  getDropStats(): DropStats {
    const totals: DropStats = Object.fromEntries(this.localDropCounts);
    for (const writer of [this.writer, this.releasing]) {
      for (const [reason, count] of Object.entries(
        writer?.batchProcessor.getDropStats() ?? {},
      )) {
        totals[reason] = (totals[reason] ?? 0) + count;
      }
    }
    return totals;
  }

  async flush(): Promise<void> {
    await this.writer?.batchProcessor.flush();
  }

  /**
   * Queues a row; false when no writer can take it because setup was lost to a
   * shutdown.
   */
  append(row: EventRow): boolean {
    const writer = this.writer;
    if (writer === null || this.shuttingDown) {
      return false;
    }
    writer.batchProcessor.append(row);
    return true;
  }

  // The Google Cloud clients are optional peer dependencies, loaded on first
  // use.
  private async requireClient(): Promise<BigQuery> {
    if (this.client === null) {
      const {projectId, location} = this.options;
      const {BigQuery} = await import('@google-cloud/bigquery');
      this.client = new BigQuery({
        projectId,
        ...(location !== undefined ? {location} : {}),
      });
    }
    return this.client;
  }

  private async tableLocation(): Promise<EventsTableLocation> {
    const {projectId, datasetId, tableId, location} = this.options;
    return {
      client: await this.requireClient(),
      projectId,
      datasetId,
      tableId,
      ...(location !== undefined ? {location} : {}),
    };
  }

  private async lazySetup(claimedGeneration: number): Promise<void> {
    const {projectId, datasetId, tableId, config, deniedColumns} = this.options;
    const schema = projectSchema({
      schema: getEventsSchema(),
      denied: deniedColumns,
    });
    // View failures are logged by ensureEventsTable; once the table is ready
    // rows can flow, so they never block or repeat setup.
    if (!this.tableReady) {
      await ensureEventsTable({
        ...(await this.tableLocation()),
        schema,
        config,
        denied: deniedColumns,
      });
      this.tableReady = true;
    }

    if (this.parserState === null) {
      let offloader: GcsOffloader | null = null;
      if (config.gcsBucketName !== null) {
        if (deniedColumns.has('content_parts')) {
          logger.warn(
            "GCS offload disabled: payloadColumnDenylist drops 'content_parts', which holds the offloaded " +
              'object reference; large/binary content is kept inline (truncated) instead of being uploaded to ' +
              `${config.gcsBucketName}.`,
          );
        } else {
          offloader = new GcsOffloader({
            bucketName: config.gcsBucketName,
            storage:
              this.options.storage ??
              new (await import('@google-cloud/storage')).Storage({projectId}),
          });
        }
      }
      this.parserState = new HybridContentParser({
        offloader,
        traceId: '',
        spanId: '',
        maxLength: config.maxContentLength,
        connectionId: config.connectionId,
      });
    }

    if (this.writer === null) {
      const writeClient =
        this.options.writeClient ?? (await createWriteClient({projectId}));
      const tableRef = {client: writeClient, projectId, datasetId, tableId};
      try {
        const writeStream = config.exactlyOnceDelivery
          ? await createCommittedWriteStream(tableRef)
          : undefined;
        const batchProcessor = new BatchProcessor({
          writeClient,
          ownsWriteClient: this.options.writeClient === null,
          schema,
          destinationTable: `projects/${projectId}/datasets/${datasetId}/tables/${tableId}`,
          writeStream,
          batchSize: config.batchSize,
          flushInterval: config.batchFlushInterval,
          retryConfig: config.retryConfig,
          queueMaxSize: config.queueMaxSize,
          shutdownTimeout: config.shutdownTimeout,
          exactlyOnceDelivery: config.exactlyOnceDelivery,
          createStream: config.exactlyOnceDelivery
            ? () => createCommittedWriteStream(tableRef)
            : undefined,
        });
        if (this.shuttingDown || this.generation !== claimedGeneration) {
          throw new SetupAbortedError(
            'BigQuery plugin setup aborted: shutdown during setup.',
          );
        }
        batchProcessor.start();
        this.writer = {writeClient, batchProcessor};
      } catch (error) {
        if (this.options.writeClient === null) {
          await closeWriteClient({
            client: writeClient,
            timeoutSeconds: config.shutdownTimeout,
          });
        }
        throw error;
      }
    }
  }

  /**
   * Starts the plugin once. A failed setup is retried after a bounded
   * exponential backoff (2^n seconds, capped at 60) rather than poisoning the
   * plugin, and concurrent callers share one attempt. Never counts a lost row:
   * the row owner does, from the returned outcome.
   */
  async ensureStarted(): Promise<SetupOutcome> {
    if (!this.options.config.enabled) {
      return 'disabled';
    }
    if (this.closed) {
      return 'aborted';
    }
    if (this.startedState) {
      return 'ok';
    }
    if (this.setupPromise !== null) {
      return this.setupPromise;
    }
    if (this.startupError !== null && Date.now() < this.setupRetryAt) {
      return 'failed';
    }
    const claimedGeneration = this.generation;
    const attempt = this.runSetup(claimedGeneration).finally(() => {
      this.setupPromise = null;
    });
    this.setupPromise = attempt;
    return attempt;
  }

  private async runSetup(claimedGeneration: number): Promise<SetupOutcome> {
    try {
      await this.lazySetup(claimedGeneration);
    } catch (error) {
      if (
        error instanceof SetupAbortedError ||
        this.generation !== claimedGeneration
      ) {
        this.parserState = null;
        return 'aborted';
      }
      this.startupError = error;
      this.setupFailures += 1;
      const backoffSeconds = Math.min(60, 2 ** Math.min(this.setupFailures, 6));
      this.setupRetryAt = Date.now() + backoffSeconds * 1000;
      logger.error(
        `Failed to initialize BigQuery Plugin (attempt ${this.setupFailures}, next retry in ${backoffSeconds}s):`,
        error,
      );
      return 'failed';
    }
    if (this.generation !== claimedGeneration) {
      logger.info(
        'BigQuery plugin setup finished after shutdown and was discarded; releasing what it created.',
      );
      this.parserState = null;
      try {
        await this.releaseWriter(
          monotonicSeconds() + this.options.config.shutdownTimeout,
        );
      } catch (error) {
        logger.warn('Could not release a discarded BigQuery writer.', error);
      }
      return 'aborted';
    }
    this.startedState = true;
    this.startupError = null;
    this.setupFailures = 0;
    this.setupRetryAt = 0;
    return 'ok';
  }

  /**
   * Drains the writer and closes its stream connections, and the write client
   * when the lifecycle created it, all by the monotonic `deadline` in seconds.
   * Drop counts survive teardown; the first teardown failure is rethrown.
   */
  private async releaseWriter(deadline: number): Promise<void> {
    const writer = this.writer;
    this.writer = null;
    if (writer === null) {
      return;
    }
    this.releasing = writer;
    let failure: {error: unknown} | null = null;
    try {
      await writer.batchProcessor.shutdown({
        timeoutSeconds: Math.max(0, deadline - monotonicSeconds()),
      });
    } catch (error) {
      failure = {error};
    }
    try {
      await writer.batchProcessor.close();
    } catch (error) {
      failure ??= {error};
    }
    for (const [reason, count] of Object.entries(
      writer.batchProcessor.getDropStats(),
    )) {
      this.localDropCounts.set(
        reason,
        (this.localDropCounts.get(reason) ?? 0) + count,
      );
    }
    this.releasing = null;
    if (this.options.writeClient === null) {
      try {
        await closeWriteClient({
          client: writer.writeClient,
          timeoutSeconds: Math.max(0, deadline - monotonicSeconds()),
        });
      } catch (error) {
        failure ??= {error};
      }
    }
    if (failure !== null) {
      throw failure.error;
    }
  }

  private async requireStarted(message: string): Promise<void> {
    await this.ensureStarted();
    if (!this.startedState) {
      throw new Error(message, {cause: this.startupError});
    }
  }

  async createAnalyticsViews(): Promise<void> {
    await this.requireStarted(
      'Plugin initialization failed; cannot create analytics views.',
    );
    const {config, deniedColumns} = this.options;
    await createAnalyticsViews({
      ...(await this.tableLocation()),
      config,
      denied: deniedColumns,
    });
  }

  async createEvalViews(): Promise<void> {
    const {config, deniedColumns} = this.options;
    validateEvalViewConfig({config, denied: deniedColumns, fromInit: false});
    await this.requireStarted(
      'Plugin initialization failed; cannot create eval views.',
    );
    await createEvalViews({
      ...(await this.tableLocation()),
      config,
      denied: deniedColumns,
    });
  }

  /**
   * Tears down for good within `timeoutSeconds` (default `shutdownTimeout`),
   * transport close included. Concurrent callers share one teardown;
   * `onReleased` runs once the writer is released, and a teardown failure is
   * rethrown.
   */
  shutdown({
    timeoutSeconds,
    onReleased,
  }: {
    timeoutSeconds?: number;
    onReleased: () => void;
  }): Promise<void> {
    if (this.shutdownPromise !== null) {
      return this.shutdownPromise;
    }
    const deadline =
      monotonicSeconds() +
      Math.max(0, timeoutSeconds ?? this.options.config.shutdownTimeout);
    this.shuttingDown = true;
    this.closed = true;
    this.generation += 1;
    this.startedState = false;
    const teardown = (async () => {
      try {
        await this.releaseWriter(deadline);
      } finally {
        this.parserState = null;
        onReleased();
      }
    })();
    this.shutdownPromise = teardown.finally(() => {
      this.shutdownPromise = null;
      this.shuttingDown = false;
    });
    return this.shutdownPromise;
  }
}
