/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  createEvent,
  DatabaseSessionService,
  generateClientFunctionCallId,
  InMemoryRunner,
  InMemorySessionService,
  LlmAgent,
  newId,
  resetIdProvider,
  setIdProvider,
  type BaseLlmConnection,
  type Event,
  type IdProvider,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {newInvocationContextId} from '../../src/agents/invocation_context.js';
import {createNewEventId} from '../../src/events/event.js';

const UUID_V4_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_V4 = new RegExp(`^${UUID_V4_PATTERN}$`);
const INVOCATION_ID = new RegExp(`^e-${UUID_V4_PATTERN}$`);
const FUNCTION_CALL_ID = new RegExp(`^adk-${UUID_V4_PATTERN}$`);
const EVENT_ID = /^[A-Za-z0-9]{8}$/;

// What a platform's provider returns for one runtime: longer than the 8
// characters of a default event id, in mixed case, and not made of letters
// and digits only.
const MICROVM_ID = 'microVM-7F3a9c-0';

const SESSION_OWNER = {appName: 'app', userId: 'user'};

// A provider like the one a platform would install when many runtimes are
// restored from one memory snapshot: the random state is cloned, so uniqueness
// has to come from something each clone gets after restore, such as its VM id.
function sequentialProvider(prefix: string): IdProvider {
  let next = 0;
  return () => `${prefix}-${next++}`;
}

// A model that answers once, so that a run produces events without a real LLM.
class AnswerLlm extends BaseLlm {
  constructor() {
    super({model: 'mock-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield {content: {role: 'model', parts: [{text: 'hello back'}]}};
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('live mode is not used');
  }
}

// Runs `body` against a fresh in-memory database and always closes it, so a
// failing assertion cannot leak the connection into the next test.
async function withDatabaseService<T>(
  body: (service: DatabaseSessionService) => Promise<T>,
): Promise<T> {
  const service = new DatabaseSessionService({
    dbName: ':memory:',
    driver: SqliteDriver,
    allowGlobalContext: true,
  });
  try {
    return await body(service);
  } finally {
    await (service as unknown as {orm?: MikroORM}).orm?.close();
  }
}

// The default formats of every id, used while no provider is installed. They
// are checked on a fresh process and again after a provider was installed and
// reset, because resetIdProvider() has to bring back exactly the defaults.
function itMintsDefaultIds() {
  it('returns distinct v4 UUIDs from newId', () => {
    const first = newId();
    const second = newId();

    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(first).not.toBe(second);
  });

  it('mints event ids of 8 letters and digits', () => {
    for (let i = 0; i < 50; i++) {
      expect(createNewEventId()).toMatch(EVENT_ID);
    }
  });

  it('draws the 8 characters of an event id from Math.random over a-z, A-Z and 0-9', () => {
    // Tests that seed Math.random, such as tests/integration/workflows/retry,
    // depend on both the characters and the number of draws (8) of an event id.
    const random = vi.spyOn(Math, 'random');
    // (index + 0.5) / 62 picks the character at that index of a-zA-Z0-9.
    for (const index of [0, 25, 26, 51, 52, 61, 31, 0]) {
      random.mockReturnValueOnce((index + 0.5) / 62);
    }

    expect(createNewEventId()).toBe('azAZ09Fa');
    expect(random).toHaveBeenCalledTimes(8);
  });

  it('gives an event created without an id 8 letters and digits', () => {
    expect(createEvent({author: 'user'}).id).toMatch(EVENT_ID);
  });

  it('mints a different event id on each call', () => {
    const first = createNewEventId();
    const second = createNewEventId();

    expect(first).not.toBe(second);
  });

  it('mints invocation ids of "e-" and a v4 UUID', () => {
    expect(newInvocationContextId()).toMatch(INVOCATION_ID);
  });

  it('mints function-call ids of "adk-" and a v4 UUID', () => {
    expect(generateClientFunctionCallId()).toMatch(FUNCTION_CALL_ID);
  });

  it('mints v4 UUIDs for in-memory sessions created without an id', async () => {
    const service = new InMemorySessionService();

    const session = await service.createSession(SESSION_OWNER);

    expect(session.id).toMatch(UUID_V4);
  });

  it('mints v4 UUIDs for database sessions created without an id', async () => {
    const id = await withDatabaseService(async (service) => {
      const session = await service.createSession(SESSION_OWNER);
      return session.id;
    });

    expect(id).toMatch(UUID_V4);
  });
}

// Ids have their default formats unless a platform installs a provider with
// setIdProvider(). An installed provider supplies the id as it is: nothing is
// cut from it or added to it, apart from the "e-" that starts invocation ids
// and the "adk-" that starts function-call ids.
describe('id provider', () => {
  afterEach(() => {
    resetIdProvider();
    vi.restoreAllMocks();
  });

  describe('with no provider installed', () => {
    itMintsDefaultIds();
  });

  describe('with a provider installed', () => {
    it('returns the ids of the provider from newId', () => {
      setIdProvider(sequentialProvider('vm-a'));

      expect([newId(), newId(), newId()]).toEqual([
        'vm-a-0',
        'vm-a-1',
        'vm-a-2',
      ]);
    });

    it('mints the provider value as the event id, unchanged', () => {
      setIdProvider(() => MICROVM_ID);

      expect(createNewEventId()).toBe(MICROVM_ID);
    });

    it('gives an event created without an id the provider value, unchanged', () => {
      setIdProvider(() => MICROVM_ID);

      expect(createEvent({author: 'user'}).id).toBe(MICROVM_ID);
    });

    it('mints a new event id from the provider on each call', () => {
      setIdProvider(sequentialProvider('vm-a'));

      expect([createNewEventId(), createEvent({author: 'user'}).id]).toEqual([
        'vm-a-0',
        'vm-a-1',
      ]);
    });

    it('keeps an explicit event id', () => {
      setIdProvider(() => MICROVM_ID);

      expect(createEvent({id: 'given', author: 'user'}).id).toBe('given');
    });

    it('does not use up a provider id for an event created with an explicit id', () => {
      setIdProvider(sequentialProvider('vm-a'));

      createEvent({id: 'given', author: 'user'});

      expect(createNewEventId()).toBe('vm-a-0');
    });

    it('prefixes the provider value with "e-" for invocation ids', () => {
      setIdProvider(() => MICROVM_ID);

      expect(newInvocationContextId()).toBe('e-microVM-7F3a9c-0');
    });

    it('prefixes the provider value with "adk-" for function-call ids', () => {
      setIdProvider(() => MICROVM_ID);

      expect(generateClientFunctionCallId()).toBe('adk-microVM-7F3a9c-0');
    });

    it('mints in-memory session ids from the provider', async () => {
      setIdProvider(() => MICROVM_ID);
      const service = new InMemorySessionService();

      const session = await service.createSession(SESSION_OWNER);

      expect(session.id).toBe(MICROVM_ID);
    });

    it('mints database session ids from the provider', async () => {
      setIdProvider(() => MICROVM_ID);

      const id = await withDatabaseService(async (service) => {
        const session = await service.createSession(SESSION_OWNER);
        return session.id;
      });

      expect(id).toBe(MICROVM_ID);
    });

    it('keeps an explicit in-memory session id', async () => {
      setIdProvider(() => MICROVM_ID);
      const service = new InMemorySessionService();

      const session = await service.createSession({
        ...SESSION_OWNER,
        sessionId: 'given',
      });

      expect(session.id).toBe('given');
    });

    it('keeps an explicit database session id', async () => {
      setIdProvider(() => MICROVM_ID);

      const id = await withDatabaseService(async (service) => {
        const session = await service.createSession({
          ...SESSION_OWNER,
          sessionId: 'given',
        });
        return session.id;
      });

      expect(id).toBe('given');
    });

    it('replaces the earlier provider when another one is installed', () => {
      setIdProvider(sequentialProvider('vm-a'));
      expect(newId()).toBe('vm-a-0');

      setIdProvider(sequentialProvider('vm-b'));

      expect(newId()).toBe('vm-b-0');
    });

    it('applies to work that started before it was installed', async () => {
      // Like a request being served when the platform's restore hook installs
      // the provider: that work did not start inside the hook, so a provider
      // kept in the async context of the install call would not reach it.
      const minted = Promise.resolve().then(() => newId());

      setIdProvider(() => MICROVM_ID);

      expect(await minted).toBe(MICROVM_ID);
    });

    it('lets an error from the provider reach the caller instead of falling back to a random id', async () => {
      setIdProvider(() => {
        throw new Error('vm id not available');
      });

      expect(() => newId()).toThrow('vm id not available');
      expect(() => createNewEventId()).toThrow('vm id not available');
      expect(() => newInvocationContextId()).toThrow('vm id not available');
      await expect(
        new InMemorySessionService().createSession(SESSION_OWNER),
      ).rejects.toThrow('vm id not available');
    });
  });

  describe('after resetIdProvider()', () => {
    beforeEach(() => {
      // Use the provider on every path first, so that nothing it touched can
      // outlive the reset.
      setIdProvider(() => MICROVM_ID);
      newId();
      createNewEventId();
      newInvocationContextId();
      resetIdProvider();
    });

    itMintsDefaultIds();
  });

  describe('clones restored from one memory snapshot', () => {
    const SNAPSHOT_UUID = '00000000-0000-4000-8000-000000000000';

    // A restored clone resumes with the random state of the snapshot, so every
    // clone draws the same values from crypto.randomUUID and Math.random.
    beforeEach(() => {
      vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(SNAPSHOT_UUID);
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    // The ids a clone mints while it serves one request. Its session service
    // already existed when the snapshot was taken, before any provider.
    async function mintIds(service: InMemorySessionService) {
      const session = await service.createSession(SESSION_OWNER);
      return {
        session: session.id,
        event: createEvent({author: 'user'}).id,
        invocation: newInvocationContextId(),
        functionCall: generateClientFunctionCallId(),
      };
    }

    it('mint the same ids while no provider is installed', async () => {
      const cloneA = await mintIds(new InMemorySessionService());
      const cloneB = await mintIds(new InMemorySessionService());

      // Session, invocation and function-call ids come from crypto.randomUUID.
      // An event id is 8 characters of a-zA-Z0-9 picked with Math.random, and a
      // draw of 0.5 picks the character at index 31, "F", every time.
      const sharedIds = {
        session: SNAPSHOT_UUID,
        event: 'FFFFFFFF',
        invocation: `e-${SNAPSHOT_UUID}`,
        functionCall: `adk-${SNAPSHOT_UUID}`,
      };
      expect(cloneA).toEqual(sharedIds);
      expect(cloneB).toEqual(sharedIds);
    });

    it('mint distinct ids once each installs a provider keyed by its VM id', async () => {
      const serviceA = new InMemorySessionService();
      const serviceB = new InMemorySessionService();

      setIdProvider(sequentialProvider('vm-a'));
      const cloneA = await mintIds(serviceA);
      setIdProvider(sequentialProvider('vm-b'));
      const cloneB = await mintIds(serviceB);

      expect(cloneA).toEqual({
        session: 'vm-a-0',
        event: 'vm-a-1',
        invocation: 'e-vm-a-2',
        functionCall: 'adk-vm-a-3',
      });
      expect(cloneB).toEqual({
        session: 'vm-b-0',
        event: 'vm-b-1',
        invocation: 'e-vm-b-2',
        functionCall: 'adk-vm-b-3',
      });
    });
  });

  describe('a run of an agent', () => {
    it('puts the provider ids on the session, the invocation and each event the run yields', async () => {
      setIdProvider(sequentialProvider('vm-a'));
      const runner = new InMemoryRunner({
        agent: new LlmAgent({name: 'agent', model: new AnswerLlm()}),
        appName: 'app',
      });
      const session = await runner.sessionService.createSession({
        appName: 'app',
        userId: 'user',
      });

      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: 'user',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'hello'}]},
      })) {
        events.push(event);
      }

      expect(session.id).toBe('vm-a-0');
      expect(events).not.toHaveLength(0);
      for (const event of events) {
        expect(event.id).toMatch(/^vm-a-\d+$/);
        expect(event.invocationId).toMatch(/^e-vm-a-\d+$/);
      }
    });
  });
});
