/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Configuration, MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  ensureDatabaseCreated,
  getConnectionOptionsFromUri,
  validateDatabaseSchemaVersion,
} from '../../../src/sessions/db/operations.js';
import {
  ENTITIES,
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  STORAGE_KEY_COLUMN_LENGTH,
  StorageEvent,
  StorageMetadata,
} from '../../../src/sessions/db/schema.js';

// Mock dynamic imports for drivers that might not be installed in dev
vi.mock('@mikro-orm/postgresql', () => ({
  PostgreSqlDriver: class MockPostgreSqlDriver {},
}));
vi.mock('@mikro-orm/mysql', () => ({
  MySqlDriver: class MockMySqlDriver {},
}));
vi.mock('@mikro-orm/mariadb', () => ({
  MariaDbDriver: class MockMariaDbDriver {},
}));
vi.mock('@mikro-orm/mssql', () => ({
  MsSqlDriver: class MockMsSqlDriver {},
}));

describe('operations', () => {
  describe('storage schema', () => {
    let orm: MikroORM;

    afterEach(async () => {
      if (orm) {
        await orm.close();
      }
    });

    it('keeps events composite key columns within the MySQL index limit', async () => {
      orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: ENTITIES,
      });

      const eventProperties = orm.getMetadata().get(StorageEvent.name)
        .properties as Record<string, {length?: number}>;
      const keyProperties = ['id', 'appName', 'userId', 'sessionId'];

      for (const keyProperty of keyProperties) {
        expect(eventProperties[keyProperty].length).toBe(
          STORAGE_KEY_COLUMN_LENGTH,
        );
      }

      const utf8mb4KeyBytes = keyProperties.reduce((total, keyProperty) => {
        return total + eventProperties[keyProperty].length! * 4;
      }, 0);
      expect(utf8mb4KeyBytes).toBeLessThanOrEqual(3072);
    });
  });

  describe('getConnectionOptionsFromUri', () => {
    it('should parse postgresql URI', async () => {
      const options = await getConnectionOptionsFromUri(
        'postgres://user:pass@localhost:5432/db',
      );
      expect(options.driver).toBeDefined();
      expect(options.clientUrl).toBe('postgres://user:pass@localhost:5432/db');
    });

    it('should parse postgresql URI with query params and preserve them in clientUrl', async () => {
      const uri = 'postgres://user:pass@localhost:5432/db?sslmode=require';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.clientUrl).toBe(uri);
    });

    it('should keep the full URI, including extra query params, intact in clientUrl for TCP URIs', async () => {
      const uri =
        'postgres://user:pass@localhost:5432/db?sslmode=require&connect_timeout=10';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.clientUrl).toBe(uri);
      expect(options).not.toHaveProperty('host');
    });

    it('should drop query params other than schema when MikroORM resolves the real driver connection options', async () => {
      const {PostgreSqlDriver} = await vi.importActual<
        typeof import('@mikro-orm/postgresql')
      >('@mikro-orm/postgresql');
      const uri =
        'postgres://user:pass@localhost:5432/db?sslmode=require&connect_timeout=10';
      const options = await getConnectionOptionsFromUri(uri);
      const config = new Configuration(
        {
          ...options,
          driver: PostgreSqlDriver,
          entities: [],
          metadataProvider: class {
            useCache() {
              return false;
            }
          },
          discovery: {},
        } as unknown as ConstructorParameters<typeof Configuration>[0],
        false,
      );
      const driver = new PostgreSqlDriver(config);
      const resolved = driver.getConnection().getConnectionOptions();
      expect(resolved.port).toBe(5432);
      expect(resolved).not.toHaveProperty('sslmode');
      expect(resolved).not.toHaveProperty('connect_timeout');
    });

    it('should leave a percent-encoded Unix-socket host with escaped colons as clientUrl, since MikroORM already decodes it correctly', async () => {
      const uri =
        'postgresql://user:pass@%2Fcloudsql%2Fmy-project%3Aus-central1%3Amy-instance/mydb';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.driver).toBeDefined();
      expect(options.clientUrl).toBe(uri);
      expect(options).not.toHaveProperty('host');
    });

    it('should leave a Unix-socket host with an explicit pg port as clientUrl, preserving the port MikroORM already resolves', async () => {
      const uri = 'postgresql://user:pass@%2Fvar%2Frun%2Fpostgresql:5433/mydb';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.clientUrl).toBe(uri);
      expect(options).not.toHaveProperty('host');
    });

    it('should resolve a Unix-socket host with unescaped colons in the instance name', async () => {
      const uri =
        'postgresql://user:pass@%2Fcloudsql%2Fmy-project:us-central1:my-instance/mydb';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options).not.toHaveProperty('clientUrl');
      expect(options.host).toBe('/cloudsql/my-project:us-central1:my-instance');
      expect(options.user).toBe('user');
      expect((options as {password?: string}).password).toBe('pass');
      expect(options.dbName).toBe('mydb');
    });

    it('should split userinfo on the last @ so a password containing @ (e.g. a Cloud SQL IAM user) still parses', async () => {
      const uri =
        'postgresql://svc@project.iam:pass@%2Fcloudsql%2Fproj:region:inst/mydb';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.user).toBe('svc@project.iam');
      expect((options as {password?: string}).password).toBe('pass');
      expect(options.host).toBe('/cloudsql/proj:region:inst');
    });

    it('should treat an empty database path as no dbName for Unix-socket URIs', async () => {
      const uri = 'postgresql://u:p@%2Fcloudsql%2Fproj:region:inst/';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.dbName).toBeUndefined();
    });

    it('should resolve a Unix-socket path passed via the host query param', async () => {
      const uri =
        'postgresql://user:pass@/mydb?host=/cloudsql/my-project:us-central1:my-instance';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.host).toBe('/cloudsql/my-project:us-central1:my-instance');
      expect(options.user).toBe('user');
      expect((options as {password?: string}).password).toBe('pass');
      expect(options.dbName).toBe('mydb');
    });

    it('should resolve the host query param even when new URL() otherwise succeeds', async () => {
      const uri =
        'postgresql://user:pass@localhost/mydb?host=/cloudsql/proj:region:inst';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.host).toBe('/cloudsql/proj:region:inst');
      expect(options.dbName).toBe('mydb');
    });

    it('should preserve the schema query param for Unix-socket URIs', async () => {
      const uri =
        'postgresql://user:pass@%2Fcloudsql%2Fproj:region:inst/mydb?schema=custom';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.schema).toBe('custom');
    });

    it('should parse mysql URI', async () => {
      const uri = 'mysql://user:pass@localhost:3306/db';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.driver).toBeDefined();
      expect(options.clientUrl).toBe(uri);
    });

    it('should parse mariadb URI', async () => {
      const options = await getConnectionOptionsFromUri(
        'mariadb://user:pass@localhost:3306/db',
      );
      expect(options.driver).toBeDefined();
    });

    it('should parse mssql URI', async () => {
      const options = await getConnectionOptionsFromUri(
        'mssql://user:pass@localhost:1433/db',
      );
      expect(options.driver).toBeDefined();
    });

    it('should parse sqlite://:memory: special case', async () => {
      const options = await getConnectionOptionsFromUri('sqlite://:memory:');
      expect(options.dbName).toBe(':memory:');
      expect(options.driver).toBe(SqliteDriver);
      // SQLite memory options don't have host/port/etc.
      expect(options).not.toHaveProperty('host');
    });

    it('should parse sqlite filepath URI', async () => {
      const options = await getConnectionOptionsFromUri(
        'sqlite:///tmp/test.db',
      );
      expect(options.dbName).toBe('/tmp/test.db');
      expect(options.driver).toBe(SqliteDriver);
    });

    it('should throw error for unsupported driver', async () => {
      await expect(
        getConnectionOptionsFromUri('invalid://user:pass@localhost/db'),
      ).rejects.toThrow('Unsupported database URI');
    });
  });

  describe('ensureDatabaseCreated', () => {
    let orm: MikroORM;

    afterEach(async () => {
      if (orm) {
        await orm.close();
      }
    });

    it('should run successfully with MikroORM instance', async () => {
      // Create a real SQLite in-memory instance
      orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: [StorageMetadata], // Minimal entities
      });

      // Verify it runs without error
      await expect(ensureDatabaseCreated(orm)).resolves.not.toThrow();
    });
  });

  describe('validateDatabaseSchemaVersion', () => {
    let orm: MikroORM;

    beforeEach(async () => {
      orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: [StorageMetadata],
      });
      // Ensure schema is updated so StorageMetadata table exists
      await orm.schema.updateSchema();
    });

    afterEach(async () => {
      await orm.close();
    });

    it('should initialize schema version if missing', async () => {
      const em = orm.em.fork();
      const initial = await em.find(StorageMetadata, {});
      expect(initial.length).toBe(0);

      await validateDatabaseSchemaVersion(orm);

      const after = await em.find(StorageMetadata, {});
      expect(after.length).toBe(1);
      expect(after[0].key).toBe(SCHEMA_VERSION_KEY);
      expect(after[0].value).toBe(SCHEMA_VERSION_1_JSON);
    });

    it('should do nothing if schema version is correct', async () => {
      const em = orm.em.fork();
      const version = em.create(StorageMetadata, {
        key: SCHEMA_VERSION_KEY,
        value: SCHEMA_VERSION_1_JSON,
      });
      await em.persist(version).flush();

      await expect(validateDatabaseSchemaVersion(orm)).resolves.not.toThrow();
    });

    it('should throw error if schema version is incompatible', async () => {
      const em = orm.em.fork();
      const version = em.create(StorageMetadata, {
        key: SCHEMA_VERSION_KEY,
        value: '999',
      });
      await em.persist(version).flush();

      await expect(validateDatabaseSchemaVersion(orm)).rejects.toThrow(
        'ADK Database schema version 999 is not compatible',
      );
    });
  });
});
