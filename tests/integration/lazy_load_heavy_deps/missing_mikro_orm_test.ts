/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createSession,
  DatabaseSessionService,
  Session,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

// Simulate a runtime where @mikro-orm/core cannot be resolved. Importing
// @google/adk must still succeed: only DatabaseSessionService needs MikroORM,
// and it reaches for it from init().
vi.mock('@mikro-orm/core', () => {
  throw new Error("Cannot find module '@mikro-orm/core'");
});

// Vitest wraps a throwing mock factory, so the assertions below match its
// wrapper rather than the module resolution error itself.
const MOCK_FAILURE = /There was an error when mocking a module/;

const CONNECTION_STRING = 'sqlite://:memory:';

function staleSession(): Session {
  return createSession({
    id: 'test-session',
    appName: 'test-app',
    userId: 'test-user',
  });
}

/**
 * Every public method funnels through init(), which is what populates the
 * lazily imported MikroORM bindings. A method that skipped init() would read
 * an unset binding instead of reporting the missing package.
 */
const publicCalls: Array<
  [string, (svc: DatabaseSessionService) => Promise<unknown>]
> = [
  [
    'createSession',
    (svc) => svc.createSession({appName: 'test-app', userId: 'test-user'}),
  ],
  [
    'getSession',
    (svc) =>
      svc.getSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
      }),
  ],
  [
    'listSessions',
    (svc) => svc.listSessions({appName: 'test-app', userId: 'test-user'}),
  ],
  [
    'deleteSession',
    (svc) =>
      svc.deleteSession({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
      }),
  ],
  [
    'appendEvent',
    (svc) => svc.appendEvent({session: staleSession(), event: createEvent()}),
  ],
];

describe('DatabaseSessionService without @mikro-orm/core', () => {
  it('constructs without resolving MikroORM', () => {
    expect(() => new DatabaseSessionService(CONNECTION_STRING)).not.toThrow();
  });

  it('rejects init() with the module resolution failure', async () => {
    const service = new DatabaseSessionService(CONNECTION_STRING);

    await expect(service.init()).rejects.toThrow(MOCK_FAILURE);
  });

  it('keeps reporting the same failure on a second init()', async () => {
    const service = new DatabaseSessionService(CONNECTION_STRING);

    await expect(service.init()).rejects.toThrow(MOCK_FAILURE);
    await expect(service.init()).rejects.toThrow(MOCK_FAILURE);
  });

  it.each(publicCalls)('rejects %s', async (_name, call) => {
    const service = new DatabaseSessionService(CONNECTION_STRING);

    await expect(call(service)).rejects.toThrow(MOCK_FAILURE);
  });
});
