/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {MikroORM, Options as MikroORMOptions} from '@mikro-orm/core';
import {logger} from '../../utils/logger.js';
import {loadOptionalPeer} from '../../utils/optional_peer.js';
import {redactUriPassword} from '../../utils/redact_uri.js';
import {
  ENTITIES,
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  StorageMetadata,
} from './schema.js';

/** Describes the optional driver peer backing a connection-string scheme. */
function driverPeer(packageName: string, scheme: string) {
  return {
    packageName,
    feature: `DatabaseSessionService with a "${scheme}" connection string`,
  };
}

interface SocketUriAuthority {
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
    user = rawUser ? safeDecode(rawUser) : undefined;
    password = rawPassword ? safeDecode(rawPassword) : undefined;
  }

  return {
    socketPath,
    user,
    password,
    dbName: rawPath ? decodeOrRaw(rawPath.slice(1)) : undefined,
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
    if (queryHost?.startsWith('/')) {
      const decodedHostname = parsedUrl.hostname
        ? safeDecode(parsedUrl.hostname)
        : undefined;
      if (decodedHostname && !decodedHostname.startsWith('/')) {
        logger.warn(
          `Connection URI names host '${decodedHostname}' but the ?host= parameter ` +
            `overrides it with the Unix socket '${queryHost}'; connecting to the socket.`,
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
        host: queryHost,
        user: parsedUrl.username ? safeDecode(parsedUrl.username) : undefined,
        password: parsedUrl.password
          ? safeDecode(parsedUrl.password)
          : undefined,
        dbName: decodeOrRaw(parsedUrl.pathname.slice(1)),
        ...(parsedUrl.port ? {port: Number(parsedUrl.port)} : {}),
        ...(schema ? {schema} : {}),
        ...extraParams,
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
      ...socket.extraParams,
    } as MikroORMOptions;
  }

  return {entities: ENTITIES, clientUrl: uri, driver} as MikroORMOptions;
}

/**
 * Builds MikroORM options for MySQL/MariaDB URIs. Socket paths are passed
 * explicitly through `driverOptions.connection.socketPath`.
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
      const extraParams = remainingParams(
        parsedUrl.searchParams,
        RESERVED_OPTION_KEYS,
      );
      return {
        entities: ENTITIES,
        driver,
        user: parsedUrl.username ? safeDecode(parsedUrl.username) : undefined,
        password: parsedUrl.password
          ? safeDecode(parsedUrl.password)
          : undefined,
        dbName: decodeOrRaw(parsedUrl.pathname.slice(1)),
        driverOptions: {
          connection: {socketPath, ...extraParams},
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
        connection: {socketPath: socket.socketPath, ...socket.extraParams},
      },
    } as MikroORMOptions;
  }

  return {entities: ENTITIES, clientUrl: uri, driver} as MikroORMOptions;
}

/**
 * Parses a database connection URI and returns MikroORM Options.
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
        uri === 'sqlite://:memory:'
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
 * Creates a database and tables if they don't exist.
 *
 * @param orm The MikroORM instance.
 * @returns Promise<void>
 */
export async function ensureDatabaseCreated(orm: MikroORM): Promise<void> {
  // creates database if it doesn't exist
  await orm.schema.ensureDatabase();

  // creates tables if they don't exist. Safe mode prevents dropping columns or tables.
  await orm.schema.updateSchema({safe: true});
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
