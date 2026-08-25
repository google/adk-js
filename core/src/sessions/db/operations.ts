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

/**
 * Manually parses a `postgres://`/`postgresql://` URI that `new URL()`
 * cannot represent at all: an instance connection name with unescaped
 * colons (`project:region:instance`), or the `?host=/cloudsql/...`
 * query-param convention `pg`/`libpq` use for sockets, which `URL` has no
 * concept of. Userinfo is split on the *last* `@` (mirroring the WHATWG
 * URL algorithm) so a userinfo value that itself contains `@` — e.g. a
 * Cloud SQL IAM user in `user@project.iam` form — still parses correctly.
 */
function parsePostgresSocketUri(uri: string): PostgresSocketUri | null {
  const match =
    /^postgres(?:ql)?:\/\/(?:(.*)@)?([^/?]*)(\/[^?]*)?(?:\?(.*))?$/.exec(uri);
  if (!match) {
    return null;
  }
  const [, rawUserinfo, rawAuthority, rawPath, rawQuery] = match;

  const params = new URLSearchParams(rawQuery ?? '');
  const queryHost = params.get('host');

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
    host,
    user,
    password,
    dbName: rawPath
      ? decodeURIComponent(rawPath.slice(1)) || undefined
      : undefined,
    schema: params.get('schema') ?? undefined,
  };
}

/**
 * Builds MikroORM options for a `postgres://`/`postgresql://` URI. A
 * percent-encoded Unix-socket host already round-trips correctly through
 * MikroORM's own `clientUrl` handling (`Connection.getConnectionOptions()`
 * calls `decodeURIComponent(url.hostname)`), so any URI `new URL()` can
 * parse — including ordinary TCP URIs, and sockets with every colon
 * percent-encoded — is left as `clientUrl`, unchanged from before this
 * fix, to avoid diverging from existing port/query-param handling. Only
 * URIs `new URL()` genuinely can't represent fall back to a manual parse.
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
      const schema = parsedUrl.searchParams.get('schema');
      return {
        entities: ENTITIES,
        driver,
        host: queryHost,
        user: parsedUrl.username
          ? decodeURIComponent(parsedUrl.username)
          : undefined,
        password: parsedUrl.password
          ? decodeURIComponent(parsedUrl.password)
          : undefined,
        dbName: decodeURIComponent(parsedUrl.pathname.slice(1)) || undefined,
        ...(schema ? {schema} : {}),
      } as MikroORMOptions;
    }
    return {entities: ENTITIES, clientUrl: uri, driver} as MikroORMOptions;
  }

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
    return {
      entities: ENTITIES,
      clientUrl: uri,
      driver: MySqlDriver,
    } as MikroORMOptions;
  }

  if (uri.startsWith('mariadb://')) {
    const {MariaDbDriver} = await loadOptionalPeer(
      driverPeer('@mikro-orm/mariadb', 'mariadb'),
      () => import('@mikro-orm/mariadb'),
    );
    return {
      entities: ENTITIES,
      clientUrl: uri,
      driver: MariaDbDriver,
    } as MikroORMOptions;
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
