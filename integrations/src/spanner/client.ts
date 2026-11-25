/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type GoogleAuthClient,
  type GoogleCredentials,
  isGoogleAuthClient,
  logger,
} from '@google/adk';

import {version} from '../version.js';

/**
 * Default User-Agent string sent on Cloud Spanner API requests from ADK tools.
 */
export const SPANNER_USER_AGENT = `adk-spanner-tool google-adk/${version}`;

const SPANNER_MODULE_SPECIFIER = '@google-cloud/spanner';

/**
 * Database SQL dialect reported by Cloud Spanner.
 */
export type SpannerDatabaseDialect =
  'GOOGLE_STANDARD_SQL' | 'POSTGRESQL' | 'DATABASE_DIALECT_UNSPECIFIED';

/**
 * SQL query request options accepted by {@link SpannerClient} helpers.
 */
export interface SpannerQueryOptions {
  /**
   * SQL query text to execute.
   */
  sql: string;

  /**
   * Named query parameters mapped by parameter identifier.
   */
  params?: Record<string, unknown>;

  /**
   * Parameter type hints mapped by parameter identifier.
   */
  types?: Record<string, string>;

  /**
   * Explicit protobuf parameter type objects mapped by parameter identifier.
   */
  paramTypes?: Record<string, unknown>;

  /**
   * Maximum number of rows to collect when streaming query results.
   */
  maxRows?: number;

  /**
   * Optional ordered column names used to extract positional values when a
   * row is returned as a plain object.
   */
  columns?: readonly string[];
}

/**
 * Options for running a standalone read-only query through
 * {@link SpannerClient.runReadOnlyQuery}.
 */
export interface SpannerDatabaseQueryOptions extends SpannerQueryOptions {
  /**
   * Cloud Spanner instance ID.
   */
  instanceId: string;

  /**
   * Cloud Spanner database ID.
   */
  databaseId: string;
}

/**
 * Target Cloud Spanner instance and database identifiers.
 */
export interface SpannerDatabaseTarget {
  /**
   * Cloud Spanner instance ID.
   */
  instanceId: string;

  /**
   * Cloud Spanner database ID.
   */
  databaseId: string;
}

/**
 * Snapshot-scoped query interface passed to {@link SpannerDatabaseContext.withSnapshot}.
 */
export interface SpannerSnapshotContext {
  /**
   * Executes a read-only SQL query against the active snapshot and returns
   * positional row arrays.
   */
  runQuery(options: SpannerQueryOptions): Promise<unknown[][]>;
}

/**
 * Scoped database handle passed to {@link SpannerClient.withDatabase}.
 */
export interface SpannerDatabaseContext {
  /**
   * Returns the Cloud Spanner database dialect.
   */
  getDialect(): Promise<SpannerDatabaseDialect | undefined>;

  /**
   * Executes one read-only SQL query in its own snapshot and ends the snapshot
   * before returning.
   */
  runQuery(options: SpannerQueryOptions): Promise<unknown[][]>;

  /**
   * Acquires a read-only snapshot, invokes `callback`, and ends the snapshot in
   * `finally`.
   */
  withSnapshot<T>(
    callback: (snapshot: SpannerSnapshotContext) => Promise<T>,
  ): Promise<T>;
}

/**
 * Structural interface for a single field inside a Spanner SDK row or struct.
 */
interface SpannerSdkField {
  name: string;
  value: unknown;
}

/**
 * Structural interface for a row emitted by `@google-cloud/spanner`.
 */
interface SpannerSdkRow extends Array<SpannerSdkField> {
  toJSON?: (options?: {wrapNumbers?: boolean}) => Record<string, unknown>;
}

interface SpannerSdkReadableStream extends AsyncIterable<
  SpannerSdkRow | unknown[] | Record<string, unknown>
> {
  destroyed?: boolean;
  destroy?: (error?: Error) => void;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

interface SpannerSdkExecuteSqlRequest {
  sql: string;
  params?: Record<string, unknown>;
  types?: Record<string, string>;
  paramTypes?: Record<string, unknown>;
}

interface SpannerSdkSnapshot {
  run?(
    query: string | SpannerSdkExecuteSqlRequest,
  ): Promise<[Array<SpannerSdkRow | unknown[] | Record<string, unknown>>]>;
  runStream?(
    query: string | SpannerSdkExecuteSqlRequest,
  ): SpannerSdkReadableStream;
  end?(): void | Promise<void>;
}

interface SpannerSdkDatabase {
  databaseDialect?: SpannerDatabaseDialect | null;
  getDatabaseDialect?(): Promise<SpannerDatabaseDialect | undefined>;
  getMetadata?(): Promise<
    [{databaseDialect?: SpannerDatabaseDialect | null} | undefined]
  >;
  getSnapshot?(): Promise<[SpannerSdkSnapshot]>;
  run?(
    query: string | SpannerSdkExecuteSqlRequest,
  ): Promise<[Array<SpannerSdkRow | unknown[] | Record<string, unknown>>]>;
  runStream?(
    query: string | SpannerSdkExecuteSqlRequest,
  ): SpannerSdkReadableStream;
  close?(): void | Promise<unknown>;
}

interface SpannerSdkInstance {
  database(databaseId: string): SpannerSdkDatabase;
}

interface SpannerSdkClient {
  instance(instanceId: string): SpannerSdkInstance;
  close?(): void | Promise<void>;
}

interface SpannerSdkModule {
  Spanner: new (options: Record<string, unknown>) => SpannerSdkClient;
}

/**
 * Options for constructing a {@link SpannerClient} via {@link getSpannerClient}.
 */
export interface GetSpannerClientOptions {
  /**
   * Google Cloud project ID. Falls back to `process.env['GOOGLE_CLOUD_PROJECT']`
   * when omitted or empty.
   */
  projectId?: string;

  /**
   * Credentials to authenticate Spanner requests. Objects implementing
   * `GoogleAuthClient` (such as `google-auth-library` clients) are passed as
   * `authClient` (normalizing `getRequestHeaders()` to `Headers` while
   * preserving prototype identity); objects carrying an access `token` are
   * wrapped in a bearer-token `authClient`. When `credentials` is omitted, the
   * SDK uses Application Default Credentials; when `credentials` is provided
   * without a token or `getRequestHeaders`, client creation throws.
   */
  credentials?: GoogleCredentials;

  /**
   * Optional custom user-agent string or list of strings appended to
   * {@link SPANNER_USER_AGENT}.
   */
  userAgent?: string | ReadonlyArray<string | undefined | null>;

  /**
   * Whether to disable `@google-cloud/spanner`'s built-in Cloud Monitoring
   * metrics exporter. Defaults to `true` so short-lived tool clients neither
   * require `monitoring.write` scope nor leave periodic metric-reader intervals
   * running across invocations.
   */
  disableBuiltInMetrics?: boolean;
}

interface InternalGetSpannerClientOptions extends GetSpannerClientOptions {
  sdkLoader?: () => Promise<SpannerSdkModule>;
}

async function importSpannerModule(
  specifier = SPANNER_MODULE_SPECIFIER,
): Promise<SpannerSdkModule> {
  try {
    return (await import(specifier)) as SpannerSdkModule;
  } catch (cause: unknown) {
    throw new Error(
      `Spanner integration requires the optional '${SPANNER_MODULE_SPECIFIER}' package. ` +
        `Install it with: npm install ${SPANNER_MODULE_SPECIFIER}`,
      {cause},
    );
  }
}

function buildUserAgent(
  customUserAgent?: string | ReadonlyArray<string | undefined | null>,
): string {
  const parts = [SPANNER_USER_AGENT];
  if (typeof customUserAgent === 'string') {
    if (customUserAgent.length > 0) {
      parts.push(customUserAgent);
    }
  } else if (Array.isArray(customUserAgent)) {
    for (const entry of customUserAgent) {
      if (typeof entry === 'string' && entry.length > 0) {
        parts.push(entry);
      }
    }
  }
  return parts.join(' ');
}

function nonEmptyString(value?: string): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

function noopErrorHandler(): void {}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isSpannerField(value: unknown): value is SpannerSdkField {
  if (!isPlainRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    typeof value['name'] === 'string' &&
    Object.hasOwn(value, 'value')
  );
}

function hasToJsonMethod(value: object): boolean {
  return 'toJSON' in value && typeof value.toJSON === 'function';
}

function isSpannerRowArray(row: unknown[]): row is Array<SpannerSdkField> & {
  toJSON?: (options?: {wrapNumbers?: boolean}) => Record<string, unknown>;
} {
  return row.length > 0 && (hasToJsonMethod(row) || row.every(isSpannerField));
}

function isWrappedSdkNumber(value: object): value is {
  value: unknown;
  valueOf: () => unknown;
} {
  if (value instanceof Date || Buffer.isBuffer(value) || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return (
    proto !== null &&
    proto !== Object.prototype &&
    'value' in value &&
    typeof value.valueOf === 'function' &&
    value.valueOf !== Object.prototype.valueOf &&
    !('toJSON' in value)
  );
}

function isSpannerStruct(value: unknown[]): value is SpannerSdkRow {
  return hasToJsonMethod(value) && value.every(isSpannerField);
}

function unwrapSpannerValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    seen.add(value);
    if (isSpannerStruct(value)) {
      const structObj: Record<string, unknown> = {};
      for (const field of value) {
        Object.defineProperty(structObj, field.name, {
          value: unwrapSpannerValue(field.value, seen),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return structObj;
    }
    return value.map((item) => unwrapSpannerValue(item, seen));
  }
  if (isWrappedSdkNumber(value)) {
    if (typeof value.value === 'string' && /^-?\d+$/.test(value.value)) {
      const parsed = Number(value.value);
      return Number.isSafeInteger(parsed) ? parsed : value.value;
    }
    try {
      const unboxed = value.valueOf();
      if (
        typeof unboxed === 'number' ||
        typeof unboxed === 'string' ||
        typeof unboxed === 'boolean'
      ) {
        return unboxed;
      }
    } catch {
      // Int and PGOid throw when outside Number.isSafeInteger; preserve the
      // exact string representation rather than losing precision.
      if (typeof value.value === 'string' || typeof value.value === 'number') {
        return value.value;
      }
    }
  }
  return value;
}

function toPositionalRow(
  rawRow: unknown,
  columns?: readonly string[],
): unknown[] {
  if (Array.isArray(rawRow)) {
    if (isSpannerRowArray(rawRow)) {
      return rawRow.map((field) => unwrapSpannerValue(field.value));
    }
    return rawRow.map((cell) => unwrapSpannerValue(cell));
  }
  if (typeof rawRow === 'object' && rawRow !== null) {
    const record = rawRow as Record<string, unknown>;
    if (columns) {
      return columns.map((col) => {
        if (Object.hasOwn(record, col)) {
          return unwrapSpannerValue(record[col]);
        }
        const lower = col.toLowerCase();
        return unwrapSpannerValue(
          Object.hasOwn(record, lower) ? record[lower] : undefined,
        );
      });
    }
    return Object.values(record).map((val) => unwrapSpannerValue(val));
  }
  return [unwrapSpannerValue(rawRow)];
}

async function closeQuietly(
  resource: string,
  closeFn: () => unknown,
): Promise<void> {
  try {
    await closeFn();
  } catch (error: unknown) {
    logger.warn(`Failed to close the Spanner ${resource}.`, error);
  }
}

async function resolveDatabaseDialect(
  database: SpannerSdkDatabase,
): Promise<SpannerDatabaseDialect | undefined> {
  if (
    database.databaseDialect &&
    database.databaseDialect !== 'DATABASE_DIALECT_UNSPECIFIED'
  ) {
    return database.databaseDialect;
  }
  if (typeof database.getDatabaseDialect === 'function') {
    try {
      const dialect = await database.getDatabaseDialect();
      if (dialect && dialect !== 'DATABASE_DIALECT_UNSPECIFIED') {
        return dialect;
      }
    } catch (error: unknown) {
      // @google-cloud/spanner's getDatabaseDialect() calls `cb(err)` even when
      // invoked without a callback, turning RPC failures into a TypeError.
      if (
        error instanceof TypeError &&
        typeof database.getMetadata === 'function'
      ) {
        const [metadata] = await database.getMetadata();
        return metadata?.databaseDialect ?? undefined;
      }
      throw error;
    }
  }
  if (typeof database.getMetadata === 'function') {
    const [metadata] = await database.getMetadata();
    return metadata?.databaseDialect ?? undefined;
  }
  return database.databaseDialect ?? undefined;
}

function buildSqlRequest(
  options: SpannerQueryOptions,
): SpannerSdkExecuteSqlRequest {
  const request: SpannerSdkExecuteSqlRequest = {sql: options.sql};
  if (options.params !== undefined) {
    request.params = options.params;
  }
  if (options.types !== undefined) {
    request.types = options.types;
  }
  if (options.paramTypes !== undefined) {
    request.paramTypes = options.paramTypes;
  }
  return request;
}

async function collectRowsFromStream(
  stream: SpannerSdkReadableStream,
  options: SpannerQueryOptions,
): Promise<unknown[][]> {
  const rows: unknown[][] = [];
  const maxRows = options.maxRows;
  if (maxRows !== undefined && maxRows <= 0) {
    stream.on?.('error', noopErrorHandler);
    stream.destroy?.();
    return rows;
  }
  try {
    for await (const rawRow of stream) {
      rows.push(toPositionalRow(rawRow, options.columns));
      if (maxRows !== undefined && rows.length >= maxRows) {
        stream.on?.('error', noopErrorHandler);
        stream.destroy?.();
        break;
      }
    }
  } finally {
    if (stream.destroyed !== true) {
      stream.on?.('error', noopErrorHandler);
      stream.destroy?.();
    }
  }
  return rows;
}

async function executeQueryOnTarget(
  target: SpannerSdkSnapshot | SpannerSdkDatabase,
  options: SpannerQueryOptions,
): Promise<unknown[][]> {
  const request = buildSqlRequest(options);
  if (typeof target.runStream === 'function') {
    return collectRowsFromStream(target.runStream(request), options);
  }
  if (typeof target.run === 'function') {
    const [rawRows] = await target.run(request);
    const limited =
      options.maxRows !== undefined
        ? options.maxRows <= 0
          ? []
          : rawRows.slice(0, options.maxRows)
        : rawRows;
    return limited.map((row) => toPositionalRow(row, options.columns));
  }
  throw new Error('Spanner snapshot does not support runStream() or run().');
}

const WRAPPED_SPANNER_AUTH_CLIENT_SYMBOL = Symbol.for(
  'google.adk.wrappedSpannerAuthClient',
);

function isReadOnlyNonConfigurableOwn(obj: object, prop: PropertyKey): boolean {
  const desc = Object.getOwnPropertyDescriptor(obj, prop);
  return (
    desc !== undefined && desc.configurable === false && desc.writable === false
  );
}

/**
 * Wraps a `GoogleAuthClient` in a non-invasive `Proxy` that preserves
 * `instanceof` and ES `#private` field access while normalizing
 * `getRequestHeaders()` (and any inner client returned by `getClient()`) to a
 * `Headers` instance expected by `@google-cloud/spanner` v9 (`google-gax` v6).
 */
function wrapSpannerAuthClient(authClient: GoogleAuthClient): GoogleAuthClient {
  if (WRAPPED_SPANNER_AUTH_CLIENT_SYMBOL in authClient) {
    return authClient;
  }

  const proxyTarget =
    isReadOnlyNonConfigurableOwn(authClient, 'getRequestHeaders') ||
    isReadOnlyNonConfigurableOwn(authClient, 'getClient')
      ? (Object.create(Object.getPrototypeOf(authClient)) as GoogleAuthClient)
      : authClient;

  return new Proxy(proxyTarget, {
    has(_target, prop): boolean {
      return (
        prop === WRAPPED_SPANNER_AUTH_CLIENT_SYMBOL ||
        Reflect.has(authClient, prop)
      );
    },
    get(_target, prop): unknown {
      if (prop === WRAPPED_SPANNER_AUTH_CLIENT_SYMBOL) {
        return true;
      }
      const value: unknown = Reflect.get(authClient, prop, authClient);
      if (prop === 'getRequestHeaders' && typeof value === 'function') {
        return async (...args: [url?: string | URL]): Promise<Headers> => {
          const raw = (await Reflect.apply(value, authClient, args)) as
            Headers | Record<string, string>;
          return raw instanceof Headers ? raw : new Headers(raw);
        };
      }
      if (prop === 'getClient' && typeof value === 'function') {
        return async (...args: unknown[]): Promise<unknown> => {
          const innerClient: unknown = await Reflect.apply(
            value,
            authClient,
            args,
          );
          return isGoogleAuthClient(innerClient)
            ? wrapSpannerAuthClient(innerClient)
            : innerClient;
        };
      }
      return typeof value === 'function' ? value.bind(authClient) : value;
    },
    set(_target, prop, value): boolean {
      return Reflect.set(authClient, prop, value, authClient);
    },
  });
}

const SPANNER_CLIENT_SIGNATURE_SYMBOL = Symbol.for('google.adk.spannerClient');

/**
 * Type guard checking whether a value is an instance of {@link SpannerClient}.
 */
export function isSpannerClient(obj: unknown): obj is SpannerClient {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    SPANNER_CLIENT_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[SPANNER_CLIENT_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Client wrapper around `@google-cloud/spanner` used by ADK Spanner tools.
 */
export class SpannerClient {
  readonly [SPANNER_CLIENT_SIGNATURE_SYMBOL] = true;

  readonly projectId?: string;
  readonly credentials?: GoogleCredentials;
  readonly userAgent: string;
  readonly disableBuiltInMetrics: boolean;
  private readonly sdkLoader: () => Promise<SpannerSdkModule>;

  constructor(options: GetSpannerClientOptions = {}) {
    this.projectId =
      nonEmptyString(options.projectId) ??
      nonEmptyString(process.env['GOOGLE_CLOUD_PROJECT']);
    this.credentials = options.credentials;
    this.userAgent = buildUserAgent(options.userAgent);
    this.disableBuiltInMetrics = options.disableBuiltInMetrics ?? true;
    this.sdkLoader =
      (options as InternalGetSpannerClientOptions).sdkLoader ??
      (() => importSpannerModule());
  }

  /**
   * Opens a scoped Spanner database handle, passes a {@link SpannerDatabaseContext}
   * to `callback`, and closes the database handle before the underlying SDK
   * client in `finally`.
   */
  async withDatabase<T>(
    target: SpannerDatabaseTarget,
    callback: (database: SpannerDatabaseContext) => Promise<T>,
  ): Promise<T> {
    let sdkClient: SpannerSdkClient | undefined;
    let database: SpannerSdkDatabase | undefined;
    try {
      sdkClient = await this.createSdkClient();
      const instance = sdkClient.instance(target.instanceId);
      database = instance.database(target.databaseId);

      const dbHandle = database;
      const withSnapshot = async <R>(
        snapshotCallback: (snapshot: SpannerSnapshotContext) => Promise<R>,
      ): Promise<R> => {
        if (typeof dbHandle.getSnapshot === 'function') {
          let snapshot: SpannerSdkSnapshot | undefined;
          try {
            const [acquiredSnapshot] = await dbHandle.getSnapshot();
            snapshot = acquiredSnapshot;
            return await snapshotCallback({
              runQuery: (queryOptions) =>
                executeQueryOnTarget(acquiredSnapshot, queryOptions),
            });
          } finally {
            if (snapshot !== undefined && typeof snapshot.end === 'function') {
              const snap = snapshot;
              await closeQuietly('snapshot', () => snap.end?.());
            }
          }
        }
        return await snapshotCallback({
          runQuery: (queryOptions) =>
            executeQueryOnTarget(dbHandle, queryOptions),
        });
      };

      const context: SpannerDatabaseContext = {
        getDialect: () => resolveDatabaseDialect(dbHandle),
        runQuery: (queryOptions) =>
          withSnapshot((snapshot) => snapshot.runQuery(queryOptions)),
        withSnapshot,
      };

      return await callback(context);
    } finally {
      if (database !== undefined && typeof database.close === 'function') {
        const dbToClose = database;
        await closeQuietly('database', () => dbToClose.close?.());
      }
      if (sdkClient !== undefined && typeof sdkClient.close === 'function') {
        const clientToClose = sdkClient;
        await closeQuietly('client', () => clientToClose.close?.());
      }
    }
  }

  /**
   * Returns the SQL dialect for the target Cloud Spanner database.
   */
  async getDatabaseDialect(
    target: SpannerDatabaseTarget,
  ): Promise<SpannerDatabaseDialect | undefined> {
    return this.withDatabase(target, (db) => db.getDialect());
  }

  /**
   * Executes a single read-only SQL query against a Cloud Spanner database and
   * returns positional row arrays while ensuring snapshot, database, and client
   * teardown.
   */
  async runReadOnlyQuery(
    options: SpannerDatabaseQueryOptions,
  ): Promise<unknown[][]> {
    return this.withDatabase(
      {instanceId: options.instanceId, databaseId: options.databaseId},
      (db) => db.runQuery(options),
    );
  }

  private async createSdkClient(): Promise<SpannerSdkClient> {
    const mod = await this.sdkLoader();
    if (typeof mod?.Spanner !== 'function') {
      throw new Error(
        `Missing 'Spanner' export from '${SPANNER_MODULE_SPECIFIER}'.`,
      );
    }

    const clientOptions: Record<string, unknown> = {
      userAgent: this.userAgent,
      disableBuiltInMetrics: this.disableBuiltInMetrics,
    };
    if (this.projectId !== undefined) {
      clientOptions['projectId'] = this.projectId;
    }
    if (this.credentials !== undefined) {
      if (isGoogleAuthClient(this.credentials)) {
        clientOptions['authClient'] = wrapSpannerAuthClient(this.credentials);
      } else if (
        typeof this.credentials.token === 'string' &&
        this.credentials.token.length > 0
      ) {
        const token = this.credentials.token;
        clientOptions['authClient'] = {
          getRequestHeaders: async () =>
            new Headers({Authorization: `Bearer ${token}`}),
          getAccessToken: async () => ({token}),
        };
      } else {
        throw new Error(
          'Configured Spanner credentials must provide a non-empty access token or a getRequestHeaders() method.',
        );
      }
    }

    return new mod.Spanner(clientOptions);
  }
}

/**
 * Creates a {@link SpannerClient} configured with the given project,
 * credentials, and user agent.
 */
export function getSpannerClient(
  options: GetSpannerClientOptions = {},
): SpannerClient {
  return new SpannerClient(options);
}
