/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MikroORM, Options as MikroORMOptions} from '@mikro-orm/core';
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

interface PostgresSocketUri {
  host: string;
  user?: string;
  password?: string;
  dbName?: string;
  schema?: string;
}

function parsePostgresSocketUri(uri: string): PostgresSocketUri | null {
  const match =
    /^postgres(?:ql)?:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^/?]*)(\/[^?]*)?(?:\?(.*))?$/.exec(
      uri,
    );
  if (!match) {
    return null;
  }
  const [, rawUser, rawPassword, rawAuthority, rawPath, rawQuery] = match;

  const params = new URLSearchParams(rawQuery ?? '');
  const queryHost = params.get('host') ?? params.get('socket');

  let host: string | undefined;
  if (queryHost?.startsWith('/')) {
    host = queryHost;
  } else {
    const decodedAuthority = decodeURIComponent(rawAuthority ?? '');
    if (decodedAuthority.startsWith('/')) {
      host = decodedAuthority;
    }
  }
  if (!host) {
    return null;
  }

  return {
    host,
    user: rawUser ? decodeURIComponent(rawUser) : undefined,
    password: rawPassword ? decodeURIComponent(rawPassword) : undefined,
    dbName: rawPath ? decodeURIComponent(rawPath.slice(1)) : undefined,
    schema: params.get('schema') ?? undefined,
  };
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
    driver = MySqlDriver;
  } else if (uri.startsWith('mariadb://')) {
    const {MariaDbDriver} = await loadOptionalPeer(
      driverPeer('@mikro-orm/mariadb', 'mariadb'),
      () => import('@mikro-orm/mariadb'),
    );
    driver = MariaDbDriver;
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

  if (uri.startsWith('postgres://') || uri.startsWith('postgresql://')) {
    const socket = parsePostgresSocketUri(uri);
    if (socket) {
      return {
        entities: ENTITIES,
        driver,
        host: socket.host,
        user: socket.user,
        password: socket.password,
        dbName: socket.dbName,
        ...(socket.schema ? {schema: socket.schema} : {}),
      } as MikroORMOptions;
    }
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
