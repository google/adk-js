/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemorySessionService} from '@google/adk';
import {createGateway, DEFAULT_ERROR_TEXT} from '@google/adk-gateway';
import {
  memoryChannel,
  MINIMAL,
  WHATSAPP_LIKE,
} from '@google/adk-gateway/testing/index.js';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {EchoAgent, FailingAgent, SlowAgent} from './echo_agent.js';

describe('Gateway', () => {
  let channel: ReturnType<typeof memoryChannel>;

  beforeEach(() => {
    channel = memoryChannel();
  });

  async function startWith(
    config: Partial<Parameters<typeof createGateway>[0]> = {},
  ) {
    const gateway = createGateway({
      agent: new EchoAgent(),
      channels: [channel],
      ...config,
    });
    await gateway.start();
    return gateway;
  }

  describe('a turn end to end', () => {
    it('runs the agent and sends the reply back', async () => {
      await startWith();

      const replies = await channel.userSays('hello');

      expect(replies).toHaveLength(1);
      expect(replies[0].text).toBe('echo: hello');
    });

    it('creates the session on first contact', async () => {
      const sessionService = new InMemorySessionService();
      await startWith({sessionService});

      await channel.userSays('hello');

      // `Runner.runAsync` throws on a missing session rather than creating
      // one, so a reply at all proves the gateway made it.
      const {sessions} = await sessionService.listSessions({appName: 'echo'});
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('memory:c:conv-1');
    });

    it('keeps history across turns in one conversation', async () => {
      const sessionService = new InMemorySessionService();
      await startWith({sessionService});

      await channel.userSays('one');
      await channel.userSays('two');

      const session = await sessionService.getSession({
        appName: 'echo',
        userId: 'memory:user-1',
        sessionId: 'memory:c:conv-1',
      });
      const userTexts = session!.events
        .filter((event) => event.author === 'user')
        .map((event) => event.content?.parts?.[0]?.text);
      expect(userTexts).toEqual(['one', 'two']);
    });

    it('separates conversations', async () => {
      const sessionService = new InMemorySessionService();
      await startWith({sessionService});

      await channel.userSays('a', {conversationId: 'x'});
      await channel.userSays('b', {conversationId: 'y'});

      const {sessions} = await sessionService.listSessions({appName: 'echo'});
      expect(sessions.map((s) => s.id).sort()).toEqual([
        'memory:c:x',
        'memory:c:y',
      ]);
    });
  });

  describe('access control', () => {
    it('refuses a sender who is not on the allowlist', async () => {
      const onDenied = vi.fn();
      channel = memoryChannel({access: {allowUsers: ['permitted'], onDenied}});
      await startWith();

      const replies = await channel.userSays('hello', {senderId: 'intruder'});

      expect(replies).toEqual([]);
      expect(onDenied).toHaveBeenCalledWith(
        expect.objectContaining({text: 'hello'}),
        'user-not-allowed',
      );
    });

    it('admits a sender who is', async () => {
      channel = memoryChannel({access: {allowUsers: ['permitted']}});
      await startWith();

      const replies = await channel.userSays('hello', {senderId: 'permitted'});

      expect(replies[0].text).toBe('echo: hello');
    });

    it('refuses groups when they are turned off', async () => {
      channel = memoryChannel({access: {allowGroups: false}});
      await startWith();

      const inGroup = await channel.userSays('hi', {conversationKind: 'group'});
      const inDirect = await channel.userSays('hi');

      expect(inGroup).toEqual([]);
      expect(inDirect).toHaveLength(1);
    });

    it('never tells the sender why they were refused', async () => {
      channel = memoryChannel({access: {allowUsers: ['permitted']}});
      await startWith();

      await channel.userSays('hello', {senderId: 'intruder'});

      // Explaining the refusal would tell an intruder what to try next.
      expect(channel.sent).toEqual([]);
    });
  });

  describe('commands', () => {
    it('resets the session on /reset', async () => {
      const sessionService = new InMemorySessionService();
      await startWith({sessionService});

      await channel.userSays('remember this');
      await channel.userSays('/reset');
      await channel.userSays('and this');

      const session = await sessionService.getSession({
        appName: 'echo',
        userId: 'memory:user-1',
        sessionId: 'memory:c:conv-1',
      });
      const userTexts = session!.events
        .filter((event) => event.author === 'user')
        .map((event) => event.content?.parts?.[0]?.text);
      expect(userTexts).toEqual(['and this']);
    });

    it('runs a custom command instead of the agent', async () => {
      await startWith({
        commands: {
          '/whoami': (context) =>
            context.reply(`you are ${context.message.sender.id}`),
        },
      });

      const replies = await channel.userSays('/whoami');

      expect(replies[0].text).toBe('you are user-1');
    });

    it('accepts a command name with or without its slash', async () => {
      await startWith({commands: {ping: (context) => context.reply('pong')}});

      const replies = await channel.userSays('/ping');

      expect(replies[0].text).toBe('pong');
    });

    it('falls through to the agent for an unknown command', async () => {
      await startWith();

      const replies = await channel.userSays('/unknown');

      expect(replies[0].text).toBe('echo: /unknown');
    });
  });

  describe('the onInbound hook', () => {
    it('stops the message when it returns false', async () => {
      await startWith({onInbound: () => false});

      const replies = await channel.userSays('hello');

      expect(replies).toEqual([]);
    });

    it('lets the message through otherwise', async () => {
      const seen = vi.fn();
      await startWith({
        onInbound: (message) => {
          seen(message.text);
        },
      });

      const replies = await channel.userSays('hello');

      expect(seen).toHaveBeenCalledWith('hello');
      expect(replies).toHaveLength(1);
    });
  });

  describe('failures', () => {
    it('tells the user something went wrong without leaking the error', async () => {
      await startWith({agent: new FailingAgent('secret internal detail')});

      const replies = await channel.userSays('hello');

      expect(replies[0].text).toBe(DEFAULT_ERROR_TEXT);
      expect(replies[0].text).not.toContain('secret internal detail');
    });

    it('uses a custom formatError when given one', async () => {
      await startWith({
        agent: new FailingAgent(),
        formatError: () => 'oops',
      });

      const replies = await channel.userSays('hello');

      expect(replies[0].text).toBe('oops');
    });
  });

  describe('capabilities', () => {
    it('reports the channel profile to the renderer', async () => {
      channel = memoryChannel({capabilities: WHATSAPP_LIKE});
      const seen: Array<string> = [];
      await startWith({
        render: async function* (events, context) {
          seen.push(context.capabilities.streaming);
          for await (const _ of events) {
            // drain
          }
          yield {text: 'rendered'};
        },
      });

      await channel.userSays('hello');

      expect(seen).toEqual(['none']);
    });

    it('gives a minimal channel its own profile', async () => {
      channel = memoryChannel({capabilities: MINIMAL});
      const seen: number[] = [];
      await startWith({
        render: async function* (events, context) {
          seen.push(context.capabilities.maxTextLength);
          for await (const _ of events) {
            // drain
          }
          yield {text: 'rendered'};
        },
      });

      await channel.userSays('hello');

      expect(seen).toEqual([500]);
    });
  });

  describe('serialization', () => {
    it('runs one turn at a time per session', async () => {
      const agent = new SlowAgent(30);
      await startWith({agent});

      await Promise.all([
        channel.userSays('one'),
        channel.userSays('two'),
        channel.userSays('three'),
      ]);

      // All three ran; none was skipped, and none overlapped.
      expect(agent.completed).toBe(3);
      expect(channel.texts).toEqual(['done', 'done', 'done']);
    });

    it('runs different sessions in parallel', async () => {
      const agent = new SlowAgent(40);
      await startWith({agent});

      const start = Date.now();
      await Promise.all([
        channel.userSays('one', {conversationId: 'a'}),
        channel.userSays('two', {conversationId: 'b'}),
      ]);

      expect(agent.completed).toBe(2);
      // Serialized they would take ~80ms; in parallel, about half that.
      expect(Date.now() - start).toBeLessThan(80);
    });

    it('abandons the running turn when the policy says to interrupt', async () => {
      const agent = new SlowAgent(50);
      await startWith({agent, onBusy: 'interrupt'});

      await Promise.all([channel.userSays('one'), channel.userSays('two')]);

      // The first turn was interrupted, so only the second answered. Whether
      // the first got as far as the agent at all depends on how quickly the
      // abort lands — bailing before the model call is a bonus, not a contract.
      expect(agent.completed).toBe(1);
      expect(channel.texts).toEqual(['done']);
    });

    it('drops a message when the policy says to drop', async () => {
      const agent = new SlowAgent(40);
      await startWith({agent, onBusy: 'drop'});

      await Promise.all([channel.userSays('one'), channel.userSays('two')]);

      expect(agent.completed).toBe(1);
      expect(channel.texts).toEqual(['done']);
    });
  });

  describe('lifecycle', () => {
    it('refuses to build without a channel', () => {
      expect(() =>
        createGateway({agent: new EchoAgent(), channels: []}),
      ).toThrow(/at least one channel/);
    });

    it('refuses to build without something to run', () => {
      expect(() => createGateway({channels: [memoryChannel()]})).toThrow(
        /`app` or an `agent`/,
      );
    });

    it('refuses two channels with the same name', () => {
      expect(() =>
        createGateway({
          agent: new EchoAgent(),
          channels: [memoryChannel(), memoryChannel()],
        }),
      ).toThrow(/Duplicate channel name/);
    });

    it('drains in-flight turns on stop', async () => {
      const agent = new SlowAgent(20);
      const gateway = await startWith({agent});

      const inFlight = channel.userSays('hello');
      await gateway.stop();
      await inFlight;

      expect(agent.completed).toBe(1);
    });
  });
});
