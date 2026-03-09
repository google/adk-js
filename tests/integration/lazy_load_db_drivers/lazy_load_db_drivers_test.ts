/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {DatabaseSessionService} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

// Mock drivers to simulate them not being installed (missing peer dependencies).
const missingDrivers = [
  {name: '@mikro-orm/mariadb', uri: 'mariadb://test:test@localhost/test'},
  {name: '@mikro-orm/mssql', uri: 'mssql://test:test@localhost/test'},
  // secretlint-disable-next-line @secretlint/secretlint-rule-database-connection-string
  {name: '@mikro-orm/mysql', uri: 'mysql://test:test@localhost/test'},
  // secretlint-disable-next-line @secretlint/secretlint-rule-database-connection-string
  {name: '@mikro-orm/postgresql', uri: 'postgres://test:test@localhost/test'},
];

vi.mock('@mikro-orm/mariadb', () => {
  throw new Error("Cannot find module '@mikro-orm/mariadb'");
});
vi.mock('@mikro-orm/mssql', () => {
  throw new Error("Cannot find module '@mikro-orm/mssql'");
});
vi.mock('@mikro-orm/mysql', () => {
  throw new Error("Cannot find module '@mikro-orm/mysql'");
});
vi.mock('@mikro-orm/postgresql', () => {
  throw new Error("Cannot find module '@mikro-orm/postgresql'");
});

describe('Lazy load DB drivers', () => {
  it('should initialize sqlite without throwing on missing peer drivers', async () => {
    // Only sqlite is used, and it is NOT mocked to throw, so it should initialize successfully.
    const svc = new DatabaseSessionService('sqlite://:memory:');

    // We expect successful initialization because it doesn't need the other drivers.
    await expect(svc.init()).resolves.toBeUndefined();
  });

  describe.each(missingDrivers)('Driver: $name', ({uri}) => {
    it('should throw if the specifically requested driver is missing', async () => {
      const svc = new DatabaseSessionService(uri);

      // It should now throw when we init() because it tries to dynamically import the missing driver
      await expect(svc.init()).rejects.toThrow(
        /There was an error when mocking a module/,
      );
    });
  });
});
