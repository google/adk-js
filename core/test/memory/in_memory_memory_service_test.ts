/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InMemoryMemoryService,
  InMemorySessionService,
  createEvent,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

describe('InMemoryMemoryService', () => {
  let service: InMemoryMemoryService;
  let sessionService: InMemorySessionService;

  beforeEach(() => {
    service = new InMemoryMemoryService();
    sessionService = new InMemorySessionService();
  });

  describe('addSessionToMemory', () => {
    it('stores events that have content parts', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello world'}]},
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });

      expect(result.memories).toHaveLength(1);
      expect(result.memories[0].content).toEqual(event.content);
    });

    it('filters out events with no content parts', async () => {
      const emptyEvent = createEvent({author: 'user'});
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event: emptyEvent});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });

      expect(result.memories).toHaveLength(0);
    });

    it('stores events under the correct appName/userId key', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello world'}]},
      });
      const sessionAlice = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session: sessionAlice, event});

      const sessionBob = await sessionService.createSession({
        appName: 'myApp',
        userId: 'bob',
      });

      await service.addSessionToMemory(sessionAlice);
      await service.addSessionToMemory(sessionBob);

      const aliceResult = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });
      const bobResult = await service.searchMemory({
        appName: 'myApp',
        userId: 'bob',
        query: 'hello',
      });

      expect(aliceResult.memories).toHaveLength(1);
      expect(bobResult.memories).toHaveLength(0);
    });
  });

  describe('searchMemory', () => {
    it('returns empty memories when no session added for user', async () => {
      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'unknown',
        query: 'hello',
      });

      expect(result.memories).toEqual([]);
    });

    it('returns matching memory entries for keyword query', async () => {
      const event = createEvent({
        author: 'agent',
        content: {role: 'model', parts: [{text: 'the weather is sunny today'}]},
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'weather',
      });

      expect(result.memories).toHaveLength(1);
      expect(result.memories[0].author).toBe('agent');
    });

    it('returns no matches when query has no overlapping words', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello world'}]},
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'goodbye',
      });

      expect(result.memories).toHaveLength(0);
    });

    it('matches case-insensitively', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'Hello World'}]},
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });

      expect(result.memories).toHaveLength(1);
    });

    it('does not return memories from a different user', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'secret info'}]},
      });
      const sessionAlice = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session: sessionAlice, event});

      await service.addSessionToMemory(sessionAlice);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'bob',
        query: 'secret',
      });

      expect(result.memories).toHaveLength(0);
    });

    it('does not return memories from a different app', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello world'}]},
      });
      const session = await sessionService.createSession({
        appName: 'appA',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'appB',
        userId: 'alice',
        query: 'hello',
      });

      expect(result.memories).toHaveLength(0);
    });

    it('includes author and ISO timestamp in returned memory entries', async () => {
      const timestamp = new Date('2024-01-15T10:30:00.000Z').getTime();
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello world'}]},
        timestamp,
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });

      expect(result.memories[0].author).toBe('user');
      expect(result.memories[0].timestamp).toBe('2024-01-15T10:30:00.000Z');
    });

    it('matches any word in a multi-word query', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'python programming language'}]},
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'irrelevant python',
      });

      expect(result.memories).toHaveLength(1);
    });
  });
});
