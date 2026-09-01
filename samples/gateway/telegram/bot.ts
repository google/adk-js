/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A Telegram bot, end to end.
 *
 * Setup:
 *   1. Talk to @BotFather on Telegram, `/newbot`, and copy the token.
 *   2. export TELEGRAM_BOT_TOKEN=...
 *      export GEMINI_API_KEY=...        (or put both in the repo's .env)
 *   3. npm run build
 *      node --env-file=.env samples/gateway/telegram/bot.js
 *
 * Or, from a TypeScript checkout without building:
 *   npx tsx --env-file=.env samples/gateway/telegram/bot.ts
 *
 * Then message the bot. Things worth trying:
 *   - Plain questions, and one whose answer runs past 4096 characters
 *     ("write me 2000 words on the history of the bicycle") to watch it split.
 *   - **Send a voice note.** It goes straight to Gemini as audio — no
 *     transcription service anywhere in the path.
 *   - Send a photo and ask what is in it.
 *   - Send a sticker: the bot sees `[sticker 👍]`, because the emoji is what
 *     you meant.
 *   - "delete my last order" — a tool guarded by confirmation, so the bot
 *     stops and asks. Reply "yes" or "no".
 *   - /reset to start the conversation over.
 */

import {Agent, FunctionTool} from '@google/adk';
import {createGateway} from '@google/adk-gateway';
import {telegram} from '@google/adk-gateway/telegram';
import 'dotenv/config';
import {z} from 'zod';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error(
    'TELEGRAM_BOT_TOKEN is not set. Get one from @BotFather, then:\n' +
      '  export TELEGRAM_BOT_TOKEN=...',
  );
  process.exit(1);
}

/** A harmless stand-in for something you would not want done by accident. */
const orders = new Map<string, string>([
  ['4711', 'Espresso machine, delivered 12 March'],
  ['4712', 'Coffee beans (1kg), in transit'],
]);

const listOrders = new FunctionTool({
  name: 'list_orders',
  description: 'Lists the current orders and their status.',
  execute: () =>
    [...orders.entries()].map(([id, description]) => ({id, description})),
});

const deleteOrder = new FunctionTool({
  name: 'delete_order',
  description: 'Permanently deletes an order by its id.',
  parameters: z.object({
    orderId: z.string().describe('The id of the order to delete, e.g. "4711".'),
  }),
  // The gateway turns this into a prompt the user has to answer before the
  // tool runs. Without it the bot would quietly delete things.
  requireConfirmation: true,
  execute: ({orderId}) => {
    if (!orders.delete(orderId)) {
      return {ok: false, reason: `No order ${orderId}.`};
    }
    return {ok: true, deleted: orderId};
  },
});

const agent = new Agent({
  name: 'shop_assistant',
  model: 'gemini-flash-latest',
  instruction: `
    You are a friendly assistant for a small coffee shop.
    Help with orders, and answer questions about anything the customer sends —
    including photos, voice messages and documents.
    Keep replies short and conversational; this is a chat app, not an essay.
    Use markdown for emphasis, lists and code when it helps.
  `,
  tools: [listOrders, deleteOrder],
});

const gateway = createGateway({
  agent,
  channels: [
    telegram({
      token,
      // Everything below is optional; these are the defaults, spelled out.
      session: 'per-conversation',
      media: {
        sticker: 'emoji+thumbnail',
        videoNote: 'thumbnail',
      },
    }),
  ],

  commands: {
    '/start': (context) =>
      context.reply(
        'Hello. Ask me about your orders, send a photo, or record a voice note. /reset starts over.',
      ),
  },
});

try {
  await gateway.start();
} catch (error) {
  // A rejected token is the likeliest first-run failure by some distance, and
  // Telegram reports it as a bare 404 on getMe, which explains nothing.
  const message = error instanceof Error ? error.message : String(error);
  if (/getMe failed \((401|404)\)/.test(message)) {
    console.error(
      'Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN — @BotFather\n' +
        'issues it in the form 123456789:AA...',
    );
    process.exit(1);
  }
  throw error;
}

console.log('Bot is running. Ctrl-C to stop.');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log('\nStopping — letting in-flight replies finish…');
    void gateway.stop().then(() => process.exit(0));
  });
}
