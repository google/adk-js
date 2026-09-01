/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One agent, two front doors.
 *
 * The same gateway serves an HTTP API — for a web app, a mobile client, or curl
 * — and a Telegram bot, sharing sessions, tools and configuration. Both mount
 * into an Express app you own, so your own middleware runs in front of them.
 *
 * Run:
 *   export GEMINI_API_KEY=...                     (or use .env)
 *   export TELEGRAM_BOT_TOKEN=...                 (optional; omit for HTTP only)
 *   node --env-file=.env --experimental-strip-types \
 *     samples/gateway/universal/server.ts
 *
 * Then:
 *   curl -N localhost:8080/api/sessions/demo/messages \
 *     -H 'content-type: application/json' -H 'x-user-id: alice' \
 *     -d '{"text":"what is an agent?"}'
 *
 *   curl localhost:8080/api/sessions/demo -H 'x-user-id: alice'
 */

import {Agent} from '@google/adk';
import {createGateway} from '@google/adk-gateway';
import {telegram} from '@google/adk-gateway/telegram';
import express from 'express';

const agent = new Agent({
  name: 'helper',
  model: 'gemini-flash-latest',
  instruction: 'You are a concise, friendly assistant.',
});

const token = process.env.TELEGRAM_BOT_TOKEN;

const gateway = createGateway({
  agent,
  // Optional: the HTTP surface works with no channels at all.
  channels: token ? [telegram({token})] : [],
});

const app = express();

// The gateway reads `req.body`, so a JSON parser goes in front — whichever one
// your app already uses.
app.use(express.json());

// Your own middleware belongs here, ahead of the gateway. Authentication in
// particular: mounting into your server rather than running its own is what
// lets you put this in front.
app.use((req, _res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Inbound webhooks for channels configured to use them. Telegram long-polls by
// default, so this is empty until you set `webhook` on the channel.
app.use(gateway.router());

// The HTTP API. `resolveUser` is what keeps conversations private: sessions are
// keyed by user, so taking the id from the request body would let any caller
// read anyone else's history.
app.use(
  gateway.endpoints({
    basePath: '/api',
    resolveUser: (req) => {
      const header = req.headers['x-user-id'];
      // Demo only — a real deployment reads this from a verified session or
      // token, never from a header the client controls.
      return Array.isArray(header) ? header[0] : header;
    },
    cors: {origin: '*'},
  }),
);

app.use((_req, res) => {
  res.status(404).json({error: 'Not found'});
});

if (token) {
  await gateway.start();
  console.log('Telegram bot is running.');
} else {
  console.log('TELEGRAM_BOT_TOKEN not set — serving HTTP only.');
}

const server = app.listen(8080, () => {
  console.log('HTTP API on http://localhost:8080/api');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log('\nStopping…');
    server.close();
    void gateway.stop().then(() => process.exit(0));
  });
}
