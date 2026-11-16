/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {MikroORM, Options} from '@mikro-orm/core';
import {logger} from '../../utils/logger.js';
import {loadOptionalPeer} from '../../utils/optional_peer.js';
import {redactUriPassword} from '../../utils/redact_uri.js';
import {
  ENTITIES,
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  StorageMetadata,
} from './schema.js';

/**
 * The user-facing MikroORM config shape. Since v7 `Options` marks every key
 * that has a default as required, so a partial config has to be described as
 * `Partial<Options>`.
 */
export type MikroORMOptions = Partial<Options>;

/** Describes the optional driver peer backing a connection-string scheme. */
function driverPeer(packageName: string, scheme: string) {
  return {
    packageName,
    feature: `DatabaseSessionService with a "${scheme}" connection string`,
  };
}

interface SocketUriAuthority {
  // No port: the socket path alone is sufficient to dial.
  socketPath: string;
  user?: string;
  password?: string;
  dbName?: string;
  schema?: string;
  extraParams: Record<string, string>;
}

/** Decodes a URI component without throwing on malformed percent-escapes. */
function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function decodeOrRaw(raw: string): string | undefined {
  return (safeDecode(raw) ?? raw) || undefined;
}

function remainingParams(
  params: URLSearchParams,
  exclude: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (!exclude.includes(key)) {
      result[key] = value;
    }
  }
  return result;
}

const RESERVED_OPTION_KEYS = [
  'host',
  'schema',
  'socketPath',
  'driver',
  'entities',
  'user',
  'password',
  'dbName',
  'port',
  'clientUrl',
  'driverOptions',
];

/**
 * Parses Unix-socket connection URIs that `new URL()` cannot represent,
 * including unescaped Cloud SQL instance names and `?host=/...` URIs.
 * Userinfo is split on the last `@` so IAM usernames are handled correctly.
 */
function parseSocketUri(uri: string): SocketUriAuthority | null {
  const schemeEnd = uri.indexOf('://');
  if (schemeEnd === -1) {
    return null;
  }
  const afterScheme = uri.slice(schemeEnd + 3);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authorityRegion =
    authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  const rest = authorityEnd === -1 ? '' : afterScheme.slice(authorityEnd);

  const atIndex = authorityRegion.lastIndexOf('@');
  const rawUserinfo =
    atIndex === -1 ? undefined : authorityRegion.slice(0, atIndex);
  const rawAuthority =
    atIndex === -1 ? authorityRegion : authorityRegion.slice(atIndex + 1);

  const restMatch = /^(\/[^?#]*)?(?:\?([^#]*))?/.exec(rest);
  const rawPath = restMatch?.[1];
  const rawQuery = restMatch?.[2];

  const params = new URLSearchParams(rawQuery ?? '');
  const queryHost = params.get('host');
  const decodedAuthority = safeDecode(rawAuthority) ?? '';

  let socketPath: string | undefined;
  let dbNameOverride: string | undefined;
  let matchedBareSocket = false;
  if (queryHost?.startsWith('/')) {
    socketPath = queryHost;
    // Warn when ?host= overrides a real host.
    if (decodedAuthority && !decodedAuthority.startsWith('/')) {
      logger.warn(
        `Connection URI names host "${decodedAuthority}" but the ?host= ` +
          `parameter overrides it with the Unix socket "${queryHost}"; ` +
          `connecting to the socket instead. URI: ${redactUriPassword(uri)}`,
      );
    }
  } else if (decodedAuthority.startsWith('/')) {
    socketPath = decodedAuthority;
  } else if (!decodedAuthority && rawPath) {
    const segments = rawPath.split('/');
    const colonIndex = segments.findIndex((segment) => segment.includes(':'));
    if (colonIndex !== -1) {
      socketPath = segments.slice(0, colonIndex + 1).join('/');
      dbNameOverride = segments[colonIndex + 1];
      matchedBareSocket = true;
    }
  }
  if (!socketPath) {
    return null;
  }

  let user: string | undefined;
  let password: string | undefined;
  if (rawUserinfo) {
    const colonIndex = rawUserinfo.indexOf(':');
    const rawUser =
      colonIndex === -1 ? rawUserinfo : rawUserinfo.slice(0, colonIndex);
    const rawPassword =
      colonIndex === -1 ? undefined : rawUserinfo.slice(colonIndex + 1);
    user = rawUser ? decodeOrRaw(rawUser) : undefined;
    password = rawPassword ? decodeOrRaw(rawPassword) : undefined;
  }

  return {
    socketPath,
    user,
    password,
    dbName: matchedBareSocket
      ? dbNameOverride
        ? decodeOrRaw(dbNameOverride)
        : undefined
      : rawPath
        ? decodeOrRaw(rawPath.slice(1))
        : undefined,
    schema: params.get('schema') ?? undefined,
    extraParams: remainingParams(params, RESERVED_OPTION_KEYS),
  };
}

/**
 * Leaves URLs that `new URL()` can represent as `clientUrl`, preserving
 * MikroORM's existing URL/query-parameter handling. Socket URIs that
 * require manual parsing are converted to explicit connection options.
 */
function buildPostgresOptions(uri: string, driver: unknown): MikroORMOptions {
  let parsedUrl: URL | null;
  try {
    parsedUrl = new URL(uri);
  } catch {
    parsedUrl = null;
  }

  if (parsedUrl) {
    const queryHost = parsedUrl.searchParams.get('host');
    const decodedHostname = parsedUrl.hostname
      ? safeDecode(parsedUrl.hostname)
      : undefined;
    const socketPath = queryHost?.startsWith('/')
      ? queryHost
      : decodedHostname?.startsWith('/')
        ? decodedHostname
        : undefined;

    if (socketPath) {
      if (
        queryHost?.startsWith('/') &&
        decodedHostname &&
        !decodedHostname.startsWith('/')
      ) {
        logger.warn(
          `Connection URI names host "${decodedHostname}" but the ?host= ` +
            `parameter overrides it with the Unix socket "${queryHost}"; ` +
            `connecting to the socket instead. URI: ${redactUriPassword(uri)}`,
        );
      }
      const schema = parsedUrl.searchParams.get('schema');
      const extraParams = remainingParams(
        parsedUrl.searchParams,
        RESERVED_OPTION_KEYS,
      );
      return {
        entities: ENTITIES,
        driver,
        host: socketPath,
        user: parsedUrl.username ? decodeOrRaw(parsedUrl.username) : undefined,
        password: parsedUrl.password
          ? decodeOrRaw(parsedUrl.password)
          : undefined,
        dbName: decodeOrRaw(parsedUrl.pathname.slice(1)),
        ...(parsedUrl.port ? {port: Number(parsedUrl.port)} : {}),
        ...(schema ? {schema} : {}),
        driverOptions: extraParams,
      } as MikroORMOptions;
    }
    return {entities: ENTITIES, clientUrl: uri, driver} as MikroORMOptions;
  }

  const socket = parseSocketUri(uri);
  if (socket) {
    return {
      entities: ENTITIES,
      driver,
      host: socket.socketPath,
      user: socket.user,
      password: socket.password,
      dbName: socket.dbName,
      ...(socket.schema ? {schema: socket.schema} : {}),
      driverOptions: socket.extraParams,
    } as MikroORMOptions;
  }

  throw new Error(
    `Unrecognized postgres connection URI: ${redactUriPassword(uri)}`,
  );
}

/**
 * Builds MikroORM options for MySQL/MariaDB URIs.
 * Socket paths are passed through `driverOptions.socketPath`.
 */
function buildMySqlFamilyOptions(
  uri: string,
  driver: unknown,
): MikroORMOptions {
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(uri);
  } catch {
    // Fall back to manual parsing for socket URIs.
  }

  if (parsedUrl) {
    const queryHost = parsedUrl.searchParams.get('host');
    const decodedHostname = parsedUrl.hostname
      ? safeDecode(parsedUrl.hostname)
      : undefined;

    const socketPath = queryHost?.startsWith('/')
      ? queryHost
      : decodedHostname?.startsWith('/')
        ? decodedHostname
        : undefined;

    if (socketPath) {
      // Warn only when ?host= overrides a genuine TCP host.
      if (
        queryHost?.startsWith('/') &&
        decodedHostname &&
        !decodedHostname.startsWith('/')
      ) {
        logger.warn(
          `Connection URI names host "${decodedHostname}" but the ?host= ` +
            `parameter overrides it with the Unix socket "${queryHost}"; ` +
            `connecting to the socket instead. URI: ${redactUriPassword(uri)}`,
        );
      }
      const schema = parsedUrl.searchParams.get('schema');
      const extraParams = remainingParams(
        parsedUrl.searchParams,
        RESERVED_OPTION_KEYS,
      );
      return {
        entities: ENTITIES,
        driver,
        user: parsedUrl.username ? decodeOrRaw(parsedUrl.username) : undefined,
        password: parsedUrl.password
          ? decodeOrRaw(parsedUrl.password)
          : undefined,
        dbName: decodeOrRaw(parsedUrl.pathname.slice(1)),
        driverOptions: {
          socketPath,
          ...(schema ? {schema} : {}),
          ...extraParams,
        },
      } as MikroORMOptions;
    }

    return {entities: ENTITIES, clientUrl: uri, driver} as MikroORMOptions;
  }

  // new URL() threw -- typically unescaped colons in the socket path.
  const socket = parseSocketUri(uri);
  if (socket) {
    return {
      entities: ENTITIES,
      driver,
      user: socket.user,
      password: socket.password,
      dbName: socket.dbName,
      driverOptions: {
        socketPath: socket.socketPath,
        ...(socket.schema ? {schema: socket.schema} : {}),
        ...socket.extraParams,
      },
    } as MikroORMOptions;
  }

  throw new Error(
    `Unrecognized MySQL/MariaDB connection URI: ${redactUriPassword(uri)}`,
  );
}

/**
 * Parses a database connection URI and returns MikroORM Options.
 *
 * Dialect drivers are imported dynamically so that installing `@google/adk`
 * does not pull in five database drivers. Adding a dialect here therefore also
 * means adding it to core's `peerDependencies` and to dev's `dependencies` (see
 * "Dependency declarations" in CONTRIBUTING.md);
 * `tests/integration/lazy_load_db_drivers/driver_manifest_test.ts` enforces it.
 *
 * @param uri The database connection URI (e.g., "postgres://user:password@host:port/database")
 * @returns MikroORM Options configured for the database
 * @throws Error if the URI is invalid or unsupported
 */
export async function getConnectionOptionsFromUri(
  uri: string,
): Promise<MikroORMOptions> {
  if (uri.startsWith('postgres://') || uri.startsWith('postgresql://')) {
    const {PostgreSqlDriver} = await loadOptionalPeer(
      driverPeer('@mikro-orm/postgresql', 'postgres'),
      () => import('@mikro-orm/postgresql'),
    );
    return buildPostgresOptions(uri, PostgreSqlDriver);
  }

  if (uri.startsWith('mysql://')) {
    const {MySqlDriver} = await loadOptionalPeer(
      driverPeer('@mikro-orm/mysql', 'mysql'),
      () => import('@mikro-orm/mysql'),
    );
    return buildMySqlFamilyOptions(uri, MySqlDriver);
  }

  if (uri.startsWith('mariadb://')) {
    const {MariaDbDriver} = await loadOptionalPeer(
      driverPeer('@mikro-orm/mariadb', 'mariadb'),
      () => import('@mikro-orm/mariadb'),
    );
    return buildMySqlFamilyOptions(uri, MariaDbDriver);
  }

  if (uri.startsWith('sqlite://')) {
    const {SqliteDriver} = await loadOptionalPeer(
      driverPeer('@mikro-orm/sqlite', 'sqlite'),
      () => import('@mikro-orm/sqlite'),
    );
    return {
      entities: ENTITIES,
      dbName:
        uri === 'sqlite://:memory:' || uri === 'sqlite:///:memory:'
          ? ':memory:'
          : uri.substring('sqlite://'.length),
      driver: SqliteDriver,
    } as MikroORMOptions;
  }

  if (uri.startsWith('mssql://')) {
    const {MsSqlDriver} = await loadOptionalPeer(
      driverPeer('@mikro-orm/mssql', 'mssql'),
      () => import('@mikro-orm/mssql'),
    );
    return {
      entities: ENTITIES,
      clientUrl: uri,
      driver: MsSqlDriver,
    } as MikroORMOptions;
  }

  throw new Error(`Unsupported database URI: ${redactUriPassword(uri)}`);
}

/**
 * The subset of a MikroORM SQL schema helper that `ensureDatabaseCreated`
 * uses. It is declared here so `core` does not import `@mikro-orm/sql`.
 */
interface TableListingSchemaHelper {
  getAllTables?: (
    connection: unknown,
  ) => Promise<Array<{table_name: string; schema_name?: string | null}>>;
  tableExists?: (
    connection: unknown,
    tableName: string,
    schemaName?: string,
  ) => Promise<boolean>;
}

/**
 * Creates a database and any missing entity tables without altering existing
 * tables.
 *
 * @param orm The MikroORM instance.
 * @returns Promise<void>
 */
export async function ensureDatabaseCreated(orm: MikroORM): Promise<void> {
  await orm.schema.ensureDatabase();

  const entityMetadata = [...orm.getMetadata().getAll().values()].filter(
    (meta) => !meta.embeddable && !meta.virtual && !meta.view,
  );
  if (entityMetadata.length === 0) {
    return;
  }

  const platform = orm.driver.getPlatform();
  const schemaHelper = platform.getSchemaHelper() as
    TableListingSchemaHelper | undefined;
  if (typeof schemaHelper?.getAllTables !== 'function') {
    await orm.schema.create();
    return;
  }

  const connection = orm.driver.getConnection();
  const defaultSchema = platform.getDefaultSchemaName();
  const configSchema = orm.config.get('schema');
  const dbName = orm.config.get('dbName');

  // A listed table with no schema name is in the connection's current schema.
  // Dialects without a default schema (MySQL, MariaDB) use the database name
  // as the schema name.
  const isCurrentSchema = (schemaName?: string | null): boolean =>
    !schemaName ||
    schemaName === defaultSchema ||
    (defaultSchema === undefined && schemaName === dbName);
  const tableKey = (tableName: string, schemaName?: string | null): string => {
    const schemaPart =
      !schemaName || isCurrentSchema(schemaName) ? '' : schemaName;
    return `${schemaPart}.${tableName}`.toLowerCase();
  };

  // Each SQL dialect implements `getAllTables` with its own catalog query, so
  // one query replaces a `tableExists` round trip per entity.
  const listedTables = await schemaHelper.getAllTables(connection);
  const listedTableKeys = new Set(
    listedTables.map((table) => tableKey(table.table_name, table.schema_name)),
  );

  const seenTableKeys = new Set<string>();
  const existingTableNames: string[] = [];
  let missingCount = 0;

  for (const meta of entityMetadata) {
    const schemaName = meta.schema ?? configSchema;
    const key = tableKey(meta.tableName, schemaName);
    if (seenTableKeys.has(key)) {
      continue;
    }
    seenTableKeys.add(key);

    let exists = listedTableKeys.has(key);
    if (
      !exists &&
      defaultSchema === undefined &&
      !isCurrentSchema(schemaName) &&
      typeof schemaHelper.tableExists === 'function'
    ) {
      // On MySQL and MariaDB a schema is a separate database, and the table
      // listing covers only the current database.
      exists = await schemaHelper.tableExists(
        connection,
        meta.tableName,
        schemaName,
      );
    }

    if (exists) {
      // A bare name in `skipTables` matches the table in every schema, so
      // qualify names outside the default schema.
      existingTableNames.push(
        schemaName && schemaName !== defaultSchema
          ? `${schemaName}.${meta.tableName}`
          : meta.tableName,
      );
    } else {
      missingCount++;
    }
  }

  if (missingCount === 0) {
    return;
  }

  if (existingTableNames.length === 0) {
    await orm.schema.create();
    return;
  }

  // Mutate `skipTables` in place because `SqlSchemaGenerator` caches the
  // `schemaGenerator` config object reference at construction time.
  const schemaGenConfig = orm.config.get('schemaGenerator');
  const previousSkipTables = schemaGenConfig.skipTables;
  schemaGenConfig.skipTables = [
    ...(previousSkipTables ?? []),
    ...existingTableNames,
  ];
  try {
    await orm.schema.create();
  } finally {
    schemaGenConfig.skipTables = previousSkipTables;
  }
}

/**
 * Validates the schema version.
 *
 * @param orm The MikroORM instance.
 * @throws Error if the schema version is not compatible.
 */
export async function validateDatabaseSchemaVersion(orm: MikroORM) {
  const em = orm.em.fork();
  const existing = await em.findOne(StorageMetadata, {
    key: SCHEMA_VERSION_KEY,
  });

  if (existing) {
    if (existing.value !== SCHEMA_VERSION_1_JSON) {
      throw new Error(
        `ADK Database schema version ${existing.value} is not compatible.`,
      );
    }
    return;
  }

  const newVersion = em.create(StorageMetadata, {
    key: SCHEMA_VERSION_KEY,
    value: SCHEMA_VERSION_1_JSON,
  });

  await em.persist(newVersion).flush();
}
