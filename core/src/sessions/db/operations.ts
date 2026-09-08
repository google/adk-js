/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MikroORM, Options as MikroORMOptions} from '@mikro-orm/core';
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

interface SocketUri {
  socketPath: string;
  user?: string;
  password?: string;
  dbName?: string;
}

/** Parses Unix-socket URIs that `new URL()` cannot represent. */
function parseSocketUri(uri: string): SocketUri | null {
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

  // Malformed percent-encoding falls back to null instead of throwing.
  try {
    const decodedAuthority = decodeURIComponent(rawAuthority);

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
      user = rawUser ? decodeURIComponent(rawUser) : undefined;
      password = rawPassword ? decodeURIComponent(rawPassword) : undefined;
    }

    return {
      socketPath,
      user,
      password,
      dbName: rawPath
        ? decodeURIComponent(rawPath.slice(1)) || undefined
        : undefined,
    };
  } catch {
    return null;
  }
}

/** Builds MikroORM options for MySQL/MariaDB connection URIs. */
function buildMySqlFamilyOptions(uri: string, driver: unknown) {
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(uri);
  } catch {
    // Fall back to manual parsing for socket URIs.
  }

  // ?host= must win even when the rest of the authority parses fine.
  if (parsedUrl) {
    const queryHost = parsedUrl.searchParams.get('host');
    // Ignore malformed percent-encoding when checking for a socket path.
    let decodedHost = '';
    if (parsedUrl.hostname) {
      try {
        decodedHost = decodeURIComponent(parsedUrl.hostname);
      } catch {
        decodedHost = '';
      }
    }

    if (queryHost?.startsWith('/')) {
      // Warn only when ?host= overrides a genuine TCP host.
      if (decodedHost && !decodedHost.startsWith('/')) {
        logger.warn(
          `Connection URI names host "${decodedHost}" but the ?host= ` +
            `parameter overrides it with the Unix socket "${queryHost}"; ` +
            `connecting to the socket instead. URI: ${redactUriPassword(uri)}`,
        );
      }
      return {
        entities: ENTITIES,
        driver,
        user: parsedUrl.username
          ? decodeURIComponent(parsedUrl.username)
          : undefined,
        password: parsedUrl.password
          ? decodeURIComponent(parsedUrl.password)
          : undefined,
        dbName: decodeURIComponent(parsedUrl.pathname.slice(1)) || undefined,
        driverOptions: {
          connection: {socketPath: queryHost},
        },
      } as MikroORMOptions;
    }

    // Route percent-encoded socket authorities through socketPath.
    if (decodedHost.startsWith('/')) {
      return {
        entities: ENTITIES,
        driver,
        user: parsedUrl.username
          ? decodeURIComponent(parsedUrl.username)
          : undefined,
        password: parsedUrl.password
          ? decodeURIComponent(parsedUrl.password)
          : undefined,
        dbName: decodeURIComponent(parsedUrl.pathname.slice(1)) || undefined,
        driverOptions: {
          connection: {socketPath: decodedHost},
        },
      } as MikroORMOptions;
    }

    return {entities: ENTITIES, clientUrl: uri, driver} as MikroORMOptions;
  }

  // new URL() threw -- typically unescaped colons in the socket path.
  const socket = parseSocketUri(uri);
  if (socket) {
    // Pass socketPath through to the underlying driver.
    return {
      entities: ENTITIES,
      driver,
      user: socket.user,
      password: socket.password,
      dbName: socket.dbName,
      driverOptions: {
        connection: {socketPath: socket.socketPath},
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
  let driver: unknown;

  if (uri.startsWith('postgres://') || uri.startsWith('postgresql://')) {
    const {PostgreSqlDriver} = await loadOptionalPeer(
      driverPeer('@mikro-orm/postgresql', 'postgres'),
      () => import('@mikro-orm/postgresql'),
    );
    driver = PostgreSqlDriver;
  } else if (uri.startsWith('mysql://')) {
    const {MySqlDriver} = await loadOptionalPeer(
      driverPeer('@mikro-orm/mysql', 'mysql'),
      () => import('@mikro-orm/mysql'),
    );
    return buildMySqlFamilyOptions(uri, MySqlDriver);
  } else if (uri.startsWith('mariadb://')) {
    const {MariaDbDriver} = await loadOptionalPeer(
      driverPeer('@mikro-orm/mariadb', 'mariadb'),
      () => import('@mikro-orm/mariadb'),
    );
    return buildMySqlFamilyOptions(uri, MariaDbDriver);
  } else if (uri.startsWith('sqlite://')) {
    const {SqliteDriver} = await loadOptionalPeer(
      driverPeer('@mikro-orm/sqlite', 'sqlite'),
      () => import('@mikro-orm/sqlite'),
    );
    driver = SqliteDriver;
  } else if (uri.startsWith('mssql://')) {
    const {MsSqlDriver} = await loadOptionalPeer(
      driverPeer('@mikro-orm/mssql', 'mssql'),
      () => import('@mikro-orm/mssql'),
    );
    driver = MsSqlDriver;
  } else {
    throw new Error(`Unsupported database URI: ${redactUriPassword(uri)}`);
  }

  if (uri.startsWith('sqlite://')) {
    return {
      entities: ENTITIES,
      dbName:
        uri === 'sqlite://:memory:'
          ? ':memory:'
          : uri.substring('sqlite://'.length),
      driver,
    } as MikroORMOptions;
  }

  return {
    entities: ENTITIES,
    clientUrl: uri,
    driver,
  } as MikroORMOptions;
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
