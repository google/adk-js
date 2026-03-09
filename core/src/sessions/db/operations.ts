/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MikroORM, Options as MikroORMOptions} from '@mikro-orm/core';
import {
  ENTITIES,
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  StorageMetadata,
} from './schema.js';

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
  let driver: unknown | undefined;

  if (uri.startsWith('postgres://') || uri.startsWith('postgresql://')) {
    const {PostgreSqlDriver} = await import('@mikro-orm/postgresql');
    driver = PostgreSqlDriver;
  } else if (uri.startsWith('mysql://')) {
    const {MySqlDriver} = await import('@mikro-orm/mysql');
    driver = MySqlDriver;
  } else if (uri.startsWith('mariadb://')) {
    const {MariaDbDriver} = await import('@mikro-orm/mariadb');
    driver = MariaDbDriver;
  } else if (uri.startsWith('sqlite://')) {
    const {SqliteDriver} = await import('@mikro-orm/sqlite');
    driver = SqliteDriver;
  } else if (uri.startsWith('mssql://')) {
    const {MsSqlDriver} = await import('@mikro-orm/mssql');
    driver = MsSqlDriver;
  } else {
    throw new Error(`Unsupported database URI: ${uri}`);
  }

  if (uri === 'sqlite://:memory:') {
    return {
      entities: ENTITIES,
      dbName: ':memory:',
      driver,
    } as MikroORMOptions;
  }

  const {host, port, username, password, pathname} = new URL(uri);
  const hostName = host.split(':')[0];

  return {
    entities: ENTITIES,
    dbName: pathname.slice(1),
    host: hostName,
    port: port ? parseInt(port) : undefined,
    user: username,
    password,
    driver,
  } as MikroORMOptions;
}

/**
 * Creates a database and tables if they don't exist.
 *
 * @param url The database connection URI (e.g., "postgres://user:password@host:port/database")
 * @returns Promise<void>
 * @throws Error if the URI is invalid or unsupported
 */
export async function ensureDatabaseCreated(
  ormOrUrlOrOptions: MikroORM | MikroORMOptions | string,
): Promise<void> {
  let orm: MikroORM;

  if (ormOrUrlOrOptions instanceof MikroORM) {
    orm = ormOrUrlOrOptions;
  } else if (typeof ormOrUrlOrOptions === 'string') {
    orm = await MikroORM.init(
      await getConnectionOptionsFromUri(ormOrUrlOrOptions),
    );
  } else {
    orm = await MikroORM.init(ormOrUrlOrOptions);
  }

  // creates database if it doesn't exist
  await orm.schema.ensureDatabase();

  // creates tables if they don't exist
  await orm.schema.updateSchema();
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
