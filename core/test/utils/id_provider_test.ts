/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  DatabaseSessionService,
  InMemorySessionService,
  newId,
  resetIdProvider,
  setIdProvider,
} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {newInvocationContextId} from '../../src/agents/invocation_context.js';
import {createNewEventId} from '../../src/events/event.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// A provider like the one a platform would install when many runtimes are
// restored from one memory snapshot: the random state is cloned, so uniqueness
// has to come from something each clone gets after restore, such as its VM id.
function sequentialProvider(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${next++}`;
}

describe('id provider', () => {
  afterEach(() => {
    resetIdProvider();
    vi.restoreAllMocks();
  });

  it('returns distinct v4 UUIDs by default', () => {
    const first = newId();
    const second = newId();

    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(first).not.toBe(second);
  });

  it('returns the ids of an installed provider', () => {
    setIdProvider(sequentialProvider('vm-a'));

    expect([newId(), newId(), newId()]).toEqual(['vm-a-0', 'vm-a-1', 'vm-a-2']);
  });

  it('goes back to v4 UUIDs after reset', () => {
    setIdProvider(() => 'fixed');
    resetIdProvider();

    expect(newId()).toMatch(UUID_V4);
  });

  it('mints event ids from the provider', () => {
    setIdProvider(sequentialProvider('vm-a'));

    expect(createNewEventId()).toBe('vm-a-0');
    expect(createEvent({author: 'user'}).id).toBe('vm-a-1');
  });

  it('keeps an explicit event id', () => {
    setIdProvider(sequentialProvider('vm-a'));

    expect(createEvent({id: 'given', author: 'user'}).id).toBe('given');
  });

  it('mints invocation ids from the provider', () => {
    setIdProvider(sequentialProvider('vm-a'));

    expect(newInvocationContextId()).toBe('e-vm-a-0');
  });

  it('mints in-memory session ids from the provider', async () => {
    setIdProvider(sequentialProvider('vm-a'));
    const service = new InMemorySessionService();

    const session = await service.createSession({
      appName: 'app',
      userId: 'user',
    });

    expect(session.id).toBe('vm-a-0');
  });

  it('mints database session ids from the provider', async () => {
    setIdProvider(sequentialProvider('vm-a'));
    const service = new DatabaseSessionService({
      dbName: ':memory:',
      driver: SqliteDriver,
      allowGlobalContext: true,
    });
    try {
      const session = await service.createSession({
        appName: 'app',
        userId: 'user',
      });

      expect(session.id).toBe('vm-a-0');
    } finally {
      await (service as unknown as {orm?: MikroORM}).orm?.close();
    }
  });

  it('keeps ids apart for two clones that share the same random state', async () => {
    // Both "clones" draw the same values from the cloned random state, but
    // each installs a provider keyed by its own VM id after restore.
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-4000-8000-000000000000',
    );
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const cloneA = new InMemorySessionService();
    setIdProvider(sequentialProvider('vm-a'));
    const sessionA = await cloneA.createSession({appName: 'app', userId: 'u'});
    const eventA = createNewEventId();

    const cloneB = new InMemorySessionService();
    setIdProvider(sequentialProvider('vm-b'));
    const sessionB = await cloneB.createSession({appName: 'app', userId: 'u'});
    const eventB = createNewEventId();

    expect(sessionA.id).not.toBe(sessionB.id);
    expect(eventA).not.toBe(eventB);
  });
});
