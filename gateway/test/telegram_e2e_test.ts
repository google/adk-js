/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The whole Telegram loop, against a stub Bot API.
 *
 * Drives the real adapter — polling, normalization, media download, rendering,
 * sending — with only `fetch` replaced. What this covers is precisely what a
 * live bot does, minus the network.
 */

import {
  Agent,
  BaseLlm,
  FunctionTool,
  type BaseLlmConnection,
  type LlmResponse,
} from '@google/adk';
import {createGateway} from '@google/adk-gateway';
import {telegram} from '@google/adk-gateway/telegram/index.js';
import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';

import {EchoAgent} from './echo_agent.js';
import {FakeTelegram} from './fake_telegram.js';

/** A model that asks to delete order 4711, then reports success. */
class ScriptedLlm extends BaseLlm {
  private calls = 0;

  constructor() {
    super({model: 'scripted'});
  }

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void, void> {
    this.calls++;
    if (this.calls === 1) {
      yield {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'delete_order',
                args: {orderId: '4711'},
              },
            },
          ],
        },
      };
      return;
    }
    yield {content: {role: 'model', parts: [{text: 'Done.'}]}};
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('not used');
  }
}

/** An agent whose only tool is gated behind a confirmation. */
function confirmingAgent(deleted: string[]): Agent {
  return new Agent({
    name: 'shop',
    model: new ScriptedLlm(),
    instruction: 'Use the tools.',
    tools: [
      new FunctionTool({
        name: 'delete_order',
        description: 'Deletes an order.',
        parameters: z.object({orderId: z.string()}),
        requireConfirmation: true,
        execute: ({orderId}) => {
          deleted.push(orderId);
          return {ok: true};
        },
      }),
    ],
  });
}

describe('Telegram end to end', () => {
  const running: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const stop of running.splice(0)) {
      await stop();
    }
  });

  async function bot(options: {agent?: EchoAgent} = {}) {
    const api = new FakeTelegram();
    const channel = telegram({token: 'test-token', fetch: api.fetch});
    const gateway = createGateway({
      agent: options.agent ?? new EchoAgent('shop', 'you said:'),
      channels: [channel],
    });
    await gateway.start();
    running.push(() => gateway.stop());
    return {api, gateway};
  }

  it('answers a direct message', async () => {
    const {api} = await bot();

    api.userSends({text: 'hello there'});
    await api.settled();

    expect(api.sentTexts).toEqual(['you said: hello there']);
  });

  it('identifies itself and clears any stale webhook before polling', async () => {
    const {api} = await bot();

    // A webhook left from a previous run silently starves getUpdates.
    expect(api.calledMethods).toContain('getMe');
    expect(api.calledMethods).toContain('deleteWebhook');
  });

  it('sends with HTML formatting', async () => {
    const {api} = await bot({agent: new EchoAgent('shop', '**bold**')});

    api.userSends({text: 'hi'});
    await api.settled();

    const call = api.calls.find((c) => c.method === 'sendMessage')!;
    expect(call.params.parse_mode).toBe('HTML');
    expect(call.params.text).toContain('<b>bold</b>');
  });

  it('splits an answer longer than Telegram allows', async () => {
    const long = Array.from(
      {length: 400},
      (_, i) => `Sentence number ${i}.`,
    ).join(' ');
    const {api} = await bot({agent: new EchoAgent('shop', long)});

    api.userSends({text: 'go'});
    await api.settled();

    const sends = api.calls.filter((c) => c.method === 'sendMessage');
    expect(sends.length).toBeGreaterThan(1);
    for (const send of sends) {
      expect(String(send.params.text).length).toBeLessThanOrEqual(4096);
    }
  });

  it('retries without formatting when Telegram rejects the markup', async () => {
    const {api} = await bot();
    api.failNextParse();

    api.userSends({text: 'hi'});
    await api.settled();

    const sends = api.calls.filter((c) => c.method === 'sendMessage');
    expect(sends).toHaveLength(2);
    // Losing the formatting beats losing the answer.
    expect(sends[1].params.parse_mode).toBeUndefined();
    expect(sends[1].params.text).toContain('you said: hi');
  });

  it('shows a typing indicator while it works', async () => {
    const {api} = await bot();

    api.userSends({text: 'hi'});
    await api.settled();

    expect(api.calledMethods).toContain('sendChatAction');
  });

  it('answers a callback query immediately, so the client stops spinning', async () => {
    const {api} = await bot();

    api.userTaps('approve');
    await api.settled();

    expect(api.calledMethods).toContain('answerCallbackQuery');
  });

  it('reads a voice note as audio the model can hear', async () => {
    const agent = new EchoAgent('shop', 'heard:');
    const {api} = await bot({agent});

    api.userSends({
      voice: {file_id: 'voice-1', duration: 3, mime_type: 'audio/ogg'},
    });
    await api.settled();

    expect(api.calledMethods).toContain('getFile');
    expect(api.downloads).toEqual(['voice-1']);
  });

  it('does not download media from a sender who is not allowed', async () => {
    const api = new FakeTelegram();
    const channel = telegram({
      token: 't',
      fetch: api.fetch,
      access: {allowUsers: ['999']},
    });
    const gateway = createGateway({
      agent: new EchoAgent(),
      channels: [channel],
    });
    await gateway.start();
    running.push(() => gateway.stop());

    api.userSends({
      voice: {file_id: 'voice-1', duration: 3, mime_type: 'audio/ogg'},
    });
    await api.settled();

    // Attachments are fetched lazily, so a refused message costs no bandwidth.
    expect(api.downloads).toEqual([]);
    expect(api.sentTexts).toEqual([]);
  });

  it('stays quiet in a group until it is addressed', async () => {
    const {api} = await bot();

    api.userSends(
      {text: 'just chatting'},
      {chat: {id: -100, type: 'supergroup'}},
    );
    await api.settled();
    expect(api.sentTexts).toEqual([]);

    api.userSends(
      {text: 'hey @test_bot'},
      {chat: {id: -100, type: 'supergroup'}},
    );
    await api.settled();
    expect(api.sentTexts).toHaveLength(1);
  });

  it('keeps polling after a transient API failure', async () => {
    const {api} = await bot();
    api.failNextPoll();

    api.userSends({text: 'after the failure'});
    await api.settled();

    expect(api.sentTexts).toEqual(['you said: after the failure']);
  });

  it('handles a /reset command without calling the agent', async () => {
    const {api} = await bot();

    api.userSends({text: '/reset'});
    await api.settled();

    expect(api.sentTexts).toEqual(['Started a new conversation.']);
  });

  describe('a tool confirmation', () => {
    async function confirmingBot() {
      const deleted: string[] = [];
      const api = new FakeTelegram();
      const gateway = createGateway({
        agent: confirmingAgent(deleted),
        channels: [telegram({token: 't', fetch: api.fetch})],
      });
      await gateway.start();
      running.push(() => gateway.stop());
      return {api, deleted};
    }

    it('asks with buttons instead of framework jargon', async () => {
      const {api, deleted} = await confirmingBot();

      api.userSends({text: 'delete order 4711'});
      await api.settled();

      const prompt = api.sentTexts.join('\n');
      expect(prompt).not.toMatch(/FunctionResponse|ToolConfirmation/i);
      expect(prompt).toContain('delete_order');
      expect(api.lastKeyboard.map((b) => b.text)).toEqual([
        '✅ Approve',
        '❌ Reject',
      ]);
      expect(deleted).toEqual([]);
    });

    it("keeps callback_data inside Telegram's 64-byte limit", async () => {
      const {api} = await confirmingBot();

      api.userSends({text: 'delete order 4711'});
      await api.settled();

      for (const button of api.lastKeyboard) {
        expect(
          Buffer.byteLength(button.callback_data ?? ''),
        ).toBeLessThanOrEqual(64);
      }
    });

    it('runs the tool when the user taps approve', async () => {
      const {api, deleted} = await confirmingBot();

      api.userSends({text: 'delete order 4711'});
      await api.settled();
      api.userTaps(api.lastKeyboard[0].callback_data!);
      await api.settled();

      expect(deleted).toEqual(['4711']);
    });

    it('takes the keyboard away once a button is used', async () => {
      const {api} = await confirmingBot();

      api.userSends({text: 'delete order 4711'});
      await api.settled();
      api.userTaps(api.lastKeyboard[0].callback_data!);
      await api.settled();

      // Leaving buttons that no longer work on screen invites a second press.
      expect(api.calledMethods).toContain('editMessageReplyMarkup');
    });
  });
});
