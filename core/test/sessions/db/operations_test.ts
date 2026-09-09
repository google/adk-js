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
  EVENT_TIMESTAMP_PRECISION,
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  STORAGE_KEY_COLUMN_LENGTH,
  StorageEvent,
  StorageMetadata,
} from '../../../src/sessions/db/schema.js';
import {logger} from '../../../src/utils/logger.js';

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

      const eventProperties = orm.getMetadata().get(StorageEvent)
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

    it('requests sub-second precision for event timestamps', async () => {
      orm = await MikroORM.init({
        dbName: ':memory:',
        driver: SqliteDriver,
        entities: ENTITIES,
      });

      expect(
        orm.getMetadata().get(StorageEvent).properties.timestamp.length,
      ).toBe(EVENT_TIMESTAMP_PRECISION);
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

    it('should let MikroORM handle query params for TCP URIs', async () => {
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

    it('should resolve a percent-encoded Unix-socket host with escaped colons via explicit options, not a portless clientUrl', async () => {
      const uri =
        'postgresql://user:pass@%2Fcloudsql%2Fmy-project%3Aus-central1%3Amy-instance/mydb';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.driver).toBeDefined();
      expect(options).not.toHaveProperty('clientUrl');
      expect(options.host).toBe('/cloudsql/my-project:us-central1:my-instance');
      expect(options.dbName).toBe('mydb');
    });

    it('should resolve a Unix-socket host with an explicit pg port via explicit options', async () => {
      const uri = 'postgresql://user:pass@%2Fvar%2Frun%2Fpostgresql:5433/mydb';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options).not.toHaveProperty('clientUrl');
      expect(options.host).toBe('/var/run/postgresql');
      expect(options.port).toBe(5433);
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

    it('should split userinfo on the last @ so an IAM username containing @ still parses', async () => {
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
        'postgresql://user:pass@localhost:5433/mydb?host=/cloudsql/proj:region:inst';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.host).toBe('/cloudsql/proj:region:inst');
      expect(options.dbName).toBe('mydb');
      expect(options.port).toBe(5433);
    });

    it('should preserve the schema query param for Unix-socket URIs', async () => {
      const uri =
        'postgresql://user:pass@%2Fcloudsql%2Fproj:region:inst/mydb?schema=custom';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.schema).toBe('custom');
    });

    it('should forward extra query params for a percent-encoded Unix-socket URI under driverOptions.connection', async () => {
      const uri =
        'postgresql://u:p@%2Fcloudsql%2Fproj:region:inst/db?schema=custom&sslmode=require&connect_timeout=10';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.schema).toBe('custom');
      expect(options.driverOptions).toEqual({
        connection: {sslmode: 'require', connect_timeout: '10'},
      });
    });

    it('should forward extra query params for a Unix-socket URI via the host query param under driverOptions.connection', async () => {
      const uri =
        'postgresql://user:pass@localhost:5433/mydb?host=/cloudsql/proj:region:inst&sslmode=require';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.host).toBe('/cloudsql/proj:region:inst');
      expect(options.driverOptions).toEqual({
        connection: {sslmode: 'require'},
      });
    });

    it('should not let a query param override canonical connection options', async () => {
      const uri =
        'postgresql://user:pass@%2Fcloudsql%2Fproj:region:inst/db?dbName=evil&driver=evil&port=9999&entities=evil';
      const options = (await getConnectionOptionsFromUri(
        uri,
      )) as unknown as Record<string, unknown>;
      expect(options.host).toBe('/cloudsql/proj:region:inst');
      expect(options.dbName).toBe('db');
      expect(options.driver).not.toBe('evil');
      expect(options).not.toHaveProperty('port');
      expect(options.entities).not.toBe('evil');
    });

    it('should bound userinfo to the authority so an @ later in the query does not get swallowed into it', async () => {
      const uri = 'postgresql://%2Fcloudsql%2Fproj:region:inst/db?opt=x@y';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.host).toBe('/cloudsql/proj:region:inst');
      expect(options.user).toBeUndefined();
      expect(options.dbName).toBe('db');
    });

    it('should warn when ?host= overrides a real TCP hostname', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const uri =
        'postgresql://u:secret@real-db.example.com:5432/db?host=/tmp/evil';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.host).toBe('/tmp/evil');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('real-db.example.com'),
      );
      warnSpy.mockRestore();
    });

    it('should handle malformed percent-encoding in the manual parser', async () => {
      // %ZZ is not a valid percent-escape; new URL() rejects the unescaped
      // colons here too, so this hits parseSocketUri()'s decode fallback.
      const uri = 'postgresql://u:p@%2Fcloudsql%2Fproj:region:inst/db%ZZ';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.host).toBe('/cloudsql/proj:region:inst');
      expect(options.dbName).toBe('db%ZZ');
    });

    it('should handle malformed percent-encoding in the URL parser', async () => {
      // new URL() parses this fine (?host= makes it a valid URL); the
      // malformed escape is only in the path, which used to be decoded
      // unguarded even on this branch.
      const uri =
        'postgresql://u:p@localhost:5432/db%ZZ?host=/cloudsql/proj:region:inst';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.host).toBe('/cloudsql/proj:region:inst');
      expect(options.dbName).toBe('db%ZZ');
    });

    it('should keep the raw value for malformed percent-encoding in userinfo, rather than silently dropping the credential', async () => {
      const uri = 'postgresql://u:' + 'p%ZZ@%2Fcloudsql%2Fproj:region:inst/db';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.user).toBe('u');
      expect((options as {password?: string}).password).toBe('p%ZZ');
    });

    it('should throw a clear error, naming the URI, for a bare socket authority with no colon boundary', async () => {
      const uri = 'postgresql://u:p@/var/run/postgresql/db';
      await expect(getConnectionOptionsFromUri(uri)).rejects.toThrow(
        /Unrecognized postgres connection URI: postgresql:\/\//,
      );
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

    it('should parse mysql Unix-socket URI with unescaped colons', async () => {
      const options = await getConnectionOptionsFromUri(
        'mysql://user:pass@%2Fcloudsql%2Fmy-project:us-central1:my-instance/mydb',
      );
      expect(options.driver).toBeDefined();
      const socketPath = '/cloudsql/my-project:us-central1:my-instance';
      expect(options.driverOptions).toEqual({connection: {socketPath}});
      expect(options.user).toBe('user');
      expect(options.password).toBe('pass');
      expect(options.dbName).toBe('mydb');
      expect(options).not.toHaveProperty('clientUrl');
      expect(options).not.toHaveProperty('socketPath');
    });

    it('should parse a bare Unix-socket authority with an unescaped Cloud SQL instance name', async () => {
      const uri = 'mysql://u:p@/cloudsql/proj:region:inst/db';
      const options = await getConnectionOptionsFromUri(uri);

      expect(options.driverOptions?.connection?.socketPath).toBe(
        '/cloudsql/proj:region:inst',
      );
      expect(options.dbName).toBe('db');
    });

    it('should parse mysql Unix-socket URI with query param host', async () => {
      const options = await getConnectionOptionsFromUri(
        'mysql://user:pass@/mydb?host=/cloudsql/my-project:us-central1:my-instance',
      );
      const socketPath = '/cloudsql/my-project:us-central1:my-instance';
      expect(options.driverOptions).toEqual({connection: {socketPath}});
      expect(options.dbName).toBe('mydb');
    });

    it('should parse mariadb Unix-socket URI with unescaped colons', async () => {
      const options = await getConnectionOptionsFromUri(
        'mariadb://user:pass@%2Fcloudsql%2Fmy-project:us-central1:my-instance/mydb',
      );
      expect(options.driver).toBeDefined();
      const socketPath = '/cloudsql/my-project:us-central1:my-instance';
      expect(options.driverOptions).toEqual({connection: {socketPath}});
      expect(options.user).toBe('user');
      expect(options.password).toBe('pass');
      expect(options.dbName).toBe('mydb');
      expect(options).not.toHaveProperty('clientUrl');
      expect(options).not.toHaveProperty('socketPath');
    });

    it('should parse mariadb Unix-socket URI with query param host', async () => {
      const options = await getConnectionOptionsFromUri(
        'mariadb://user:pass@/mydb?host=/cloudsql/my-project:us-central1:my-instance',
      );
      const socketPath = '/cloudsql/my-project:us-central1:my-instance';
      expect(options.driverOptions).toEqual({connection: {socketPath}});
      expect(options.dbName).toBe('mydb');
    });

    it('should warn and prefer the socket for mariadb when ?host= overrides a real TCP authority with a valid port', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const options = await getConnectionOptionsFromUri(
          'mariadb://user:secret@real-db.example.com:3306/db?host=/tmp/evil',
        );
        expect(options.driverOptions).toEqual({
          connection: {socketPath: '/tmp/evil'},
        });
        expect(options).not.toHaveProperty('clientUrl');
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should leave ordinary mysql TCP URIs unchanged as clientUrl', async () => {
      const uri = 'mysql://user:pass@localhost:3306/db';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.clientUrl).toBe(uri);
      expect(options).not.toHaveProperty('driverOptions');
    });

    it('should parse a fully percent-encoded mysql socket URI into socketPath', async () => {
      // new URL() parses this fine, but mysql2 won't auto-detect it as a socket.
      const uri =
        'mysql://user:pass@%2Fcloudsql%2Fmy-project%3Aus-central1%3Amy-instance/mydb';
      const options = await getConnectionOptionsFromUri(uri);
      const socketPath = '/cloudsql/my-project:us-central1:my-instance';
      expect(options.driverOptions).toEqual({connection: {socketPath}});
      expect(options.user).toBe('user');
      expect(options.password).toBe('pass');
      expect(options.dbName).toBe('mydb');
      expect(options).not.toHaveProperty('clientUrl');
    });

    it('should parse a fully percent-encoded mariadb socket URI into socketPath', async () => {
      const uri =
        'mariadb://user:pass@%2Fcloudsql%2Fmy-project%3Aus-central1%3Amy-instance/mydb';
      const options = await getConnectionOptionsFromUri(uri);
      const socketPath = '/cloudsql/my-project:us-central1:my-instance';
      expect(options.driverOptions).toEqual({connection: {socketPath}});
      expect(options).not.toHaveProperty('clientUrl');
    });

    it('should route the real MySqlDriver at a Unix socket for a percent-encoded URI, not a DNS host', async () => {
      const {MySqlDriver} =
        await vi.importActual<typeof import('@mikro-orm/mysql')>(
          '@mikro-orm/mysql',
        );
      const uri =
        'mysql://user:pass@%2Fcloudsql%2Fmy-project%3Aus-central1%3Amy-instance/mydb';
      const options = await getConnectionOptionsFromUri(uri);
      const config = new Configuration(
        {
          ...options,
          driver: MySqlDriver,
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
      const driver = new MySqlDriver(config);
      const knexOptions = (
        driver.getConnection() as unknown as {
          getKnexOptions: (type: string) => {
            connection: Record<string, unknown>;
          };
        }
      ).getKnexOptions('mysql2');
      expect(knexOptions.connection.socketPath).toBe(
        '/cloudsql/my-project:us-central1:my-instance',
      );
    });

    it('should warn and prefer the socket when ?host= overrides a real TCP authority with a valid port', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        // Ensure ?host= is honored even when the TCP authority is valid.
        const options = await getConnectionOptionsFromUri(
          'mysql://user:secret@real-db.example.com:3306/db?host=/tmp/evil',
        );
        expect(options.driverOptions).toEqual({
          connection: {socketPath: '/tmp/evil'},
        });
        expect(options).not.toHaveProperty('clientUrl');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const [message] = warnSpy.mock.calls[0];
        expect(message).toContain('real-db.example.com');
        expect(message).toContain('/tmp/evil');
        expect(message).not.toContain('secret');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should warn and prefer the socket when ?host= overrides a real TCP authority (unescaped-colon fallback path)', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        // Invalid port forces the manual parseSocketUri() fallback.
        const options = await getConnectionOptionsFromUri(
          'mysql://user:secret@real-db.example.com:notaport/db?host=/tmp/evil',
        );
        expect(options.driverOptions).toEqual({
          connection: {socketPath: '/tmp/evil'},
        });
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const [message] = warnSpy.mock.calls[0];
        expect(message).toContain('real-db.example.com');
        expect(message).toContain('/tmp/evil');
        expect(message).not.toContain('secret');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should not warn when ?host= is the only host present', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        await getConnectionOptionsFromUri(
          'mysql://user:pass@/mydb?host=/cloudsql/my-project:us-central1:my-instance',
        );
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should forward extra query params for a percent-encoded Unix-socket URI', async () => {
      const uri =
        'mysql://u:p@%2Fcloudsql%2Fproj:region:inst/db?charset=utf8mb4&connectTimeout=10000';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.driverOptions).toEqual({
        connection: {
          socketPath: '/cloudsql/proj:region:inst',
          charset: 'utf8mb4',
          connectTimeout: '10000',
        },
      });
    });

    it('should forward extra query params for a Unix-socket URI via the host query param', async () => {
      const uri =
        'mysql://u:p@localhost:3306/db?host=/cloudsql/proj:region:inst&charset=utf8mb4';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.driverOptions).toEqual({
        connection: {
          socketPath: '/cloudsql/proj:region:inst',
          charset: 'utf8mb4',
        },
      });
    });

    it('should forward the schema query param for a mysql Unix-socket URI instead of silently dropping it', async () => {
      const uri = 'mysql://u:p@%2Fcloudsql%2Fproj:region:inst/db?schema=custom';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.driverOptions).toEqual({
        connection: {
          socketPath: '/cloudsql/proj:region:inst',
          schema: 'custom',
        },
      });
    });

    it('should not let a query param override the resolved socketPath', async () => {
      const uri =
        'mysql://u:p@%2Fcloudsql%2Fproj:region:inst/db?socketPath=/tmp/evil&dbName=evil';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.driverOptions).toEqual({
        connection: {socketPath: '/cloudsql/proj:region:inst'},
      });
      expect(options.dbName).toBe('db');
    });

    it('should throw a clear error, naming the URI, for a bare mysql socket authority with no colon boundary', async () => {
      const uri = 'mysql://u:p@/var/run/mysqld/mysqld.sock/db';
      await expect(getConnectionOptionsFromUri(uri)).rejects.toThrow(
        /Unrecognized MySQL\/MariaDB connection URI: mysql:\/\//,
      );
    });

    it('should handle malformed percent-encoding in the manual parser (mysql)', async () => {
      const uri = 'mysql://u:p@%2Fcloudsql%2Fproj:region:inst/db%ZZ';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.driverOptions).toEqual({
        connection: {socketPath: '/cloudsql/proj:region:inst'},
      });
      expect(options.dbName).toBe('db%ZZ');
    });

    it('should handle malformed percent-encoding in the URL parser (host param)', async () => {
      const uri =
        'mysql://u:p@localhost:3306/db%ZZ?host=/cloudsql/proj:region:inst';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.driverOptions).toEqual({
        connection: {socketPath: '/cloudsql/proj:region:inst'},
      });
      expect(options.dbName).toBe('db%ZZ');
    });

    it('should handle malformed percent-encoding in the URL parser (percent-encoded host)', async () => {
      const uri =
        'mysql://u:p@%2Fcloudsql%2Fmy-project%3Aus-central1%3Amy-instance/db%ZZ';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.driverOptions).toEqual({
        connection: {
          socketPath: '/cloudsql/my-project:us-central1:my-instance',
        },
      });
      expect(options.dbName).toBe('db%ZZ');
    });

    it('should accept a malformed dbName as the raw undecoded value during MikroORM configuration', async () => {
      const {MySqlDriver} =
        await vi.importActual<typeof import('@mikro-orm/mysql')>(
          '@mikro-orm/mysql',
        );
      const uri = 'mysql://u:p@%2Fcloudsql%2Fproj:region:inst/db%ZZ';
      const options = await getConnectionOptionsFromUri(uri);
      expect(options.dbName).toBe('db%ZZ');
      const config = new Configuration(
        {
          ...options,
          driver: MySqlDriver,
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
      expect(config.get('dbName')).toBe('db%ZZ');
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
      await orm.schema.update();
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
