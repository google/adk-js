/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {createEvent} from '../../src/events/event.js';
import {createEventActions} from '../../src/events/event_actions.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';

const initial = {
  'app:theme': 'dark',
  'user:language': 'en',
  local: 'first',
};

async function seededService() {
  const service = new InMemorySessionService();
  const first = await service.createSession({
    appName: 'app',
    userId: 'user',
    sessionId: 'first',
    state: initial,
  });
  return {service, first};
}

describe('InMemorySessionService initial scoped state', () => {
  it('shares initial app and user state with the next session of the user', async () => {
    const {service} = await seededService();
    const next = await service.createSession({
      appName: 'app',
      userId: 'user',
      sessionId: 'second',
    });
    expect(next.state).toEqual({'app:theme': 'dark', 'user:language': 'en'});
  });

  it('shares only initial app state with another user', async () => {
    const {service} = await seededService();
    const next = await service.createSession({
      appName: 'app',
      userId: 'another-user',
      sessionId: 'second',
    });
    expect(next.state).toEqual({'app:theme': 'dark'});
  });

  it('does not share initial state across applications', async () => {
    const {service} = await seededService();
    const next = await service.createSession({
      appName: 'another-app',
      userId: 'user',
      sessionId: 'second',
    });
    expect(next.state).toEqual({});
  });

  it('returns all initial state to its owning session', async () => {
    const {first} = await seededService();
    expect(first.state).toEqual(initial);
    expect(first.events).toEqual([]);
  });

  it('continues sharing state written through appendEvent', async () => {
    const service = new InMemorySessionService();
    const first = await service.createSession({appName: 'app', userId: 'user'});
    await service.appendEvent({
      session: first,
      event: createEvent({actions: createEventActions({stateDelta: initial})}),
    });
    const next = await service.createSession({appName: 'app', userId: 'user'});
    expect(next.state).toEqual({'app:theme': 'dark', 'user:language': 'en'});
  });

  it('makes newly initialized keys visible when an earlier empty session is read', async () => {
    const service = new InMemorySessionService();
    const key = {appName: 'app', userId: 'user', sessionId: 'earlier'};
    await service.createSession(key);
    await service.createSession({
      appName: 'app',
      userId: 'user',
      sessionId: 'initialized',
      state: initial,
    });
    expect((await service.getSession(key))?.state).toEqual({
      'app:theme': 'dark',
      'user:language': 'en',
    });
  });

  it('keeps existing shared values ahead of conflicting initial values', async () => {
    const service = new InMemorySessionService();
    const first = await service.createSession({appName: 'app', userId: 'user'});
    const existing = Object.fromEntries(
      ['app:', 'user:'].flatMap((prefix) =>
        [undefined, null, false, 0, '', 'existing'].map((value, index) => [
          `${prefix}key${index}`,
          value,
        ]),
      ),
    );
    await service.appendEvent({
      session: first,
      event: createEvent({actions: createEventActions({stateDelta: existing})}),
    });
    const key = {appName: 'app', userId: 'user', sessionId: 'conflicting'};
    const conflicting = await service.createSession({
      ...key,
      state: Object.fromEntries(
        Object.keys(existing).map((name) => [name, 'replacement']),
      ),
    });
    const reread = await service.getSession(key);
    const next = await service.createSession({appName: 'app', userId: 'user'});
    for (const state of [conflicting.state, reread!.state, next.state]) {
      for (const [name, value] of Object.entries(existing)) {
        expect(Object.hasOwn(state, name)).toBe(true);
        expect(state[name]).toBe(value);
      }
    }
  });

  it('keeps event updates authoritative after initialization', async () => {
    const {service, first} = await seededService();
    await service.appendEvent({
      session: first,
      event: createEvent({
        actions: createEventActions({
          stateDelta: {'app:theme': 'light', 'user:language': 'fr'},
        }),
      }),
    });
    const loaded = await service.getSession({
      appName: first.appName,
      userId: first.userId,
      sessionId: first.id,
    });
    expect(loaded?.state).toEqual({
      'app:theme': 'light',
      'user:language': 'fr',
      local: 'first',
    });
    const next = await service.createSession({appName: 'app', userId: 'user'});
    expect(next.state).toEqual({'app:theme': 'light', 'user:language': 'fr'});
  });

  it('filters temporary state while keeping local state in the owning session', async () => {
    const service = new InMemorySessionService();
    const first = await service.createSession({
      appName: 'app',
      userId: 'user',
      state: {'temp:note': 'temporary', local: 'private'},
    });
    expect(first.state).toEqual({local: 'private'});
    const next = await service.createSession({appName: 'app', userId: 'user'});
    expect(next.state).toEqual({});
  });
});
