# ADK Gateway

Connect an ADK agent to a messenger — Telegram today, Slack, Google Chat and WhatsApp next —
without writing the same 600 lines of glue each time.

```ts
import {Agent} from '@google/adk';
import {createGateway} from '@google/adk-gateway';
import {telegram} from '@google/adk-gateway/telegram';

const gateway = createGateway({
  agent: new Agent({
    name: 'support',
    model: 'gemini-2.5-flash',
    instruction: 'You are a helpful support bot.',
  }),
  channels: [telegram({token: process.env.TELEGRAM_BOT_TOKEN!})],
});

await gateway.start();
```

That is a working bot: long-polling, sessions per chat, markdown converted to Telegram's HTML,
answers split at 4096 characters, photos and voice notes passed to the model, a typing indicator,
and `/reset`.

## Try it

A runnable bot lives in [`samples/gateway/telegram`](../samples/gateway/telegram/bot.ts).

```bash
export TELEGRAM_BOT_TOKEN=...   # from @BotFather
export GEMINI_API_KEY=...
npm run build
node --experimental-strip-types samples/gateway/telegram/bot.ts
```

Worth trying once it is up: send a **voice note** (it goes straight to Gemini as audio, with no
transcription service in the path), send a photo and ask about it, send a sticker, ask for
something long enough to be split, and say "delete order 4711" to hit a tool that stops and asks
for confirmation.

## Two surfaces, one engine

The same gateway serves messengers and HTTP. Both sit on one turn engine —
`gateway.run()` — which resolves the session, serializes work on it, runs the agent and streams
events.

```ts
import express from 'express';

const gateway = createGateway({agent, channels: [telegram({token})]});

const app = express();
app.use(express.json()); // the gateway reads req.body
app.use(myAuthMiddleware); // yours runs first
app.use(gateway.router()); // channel webhooks
app.use(gateway.endpoints({resolveUser: myAuth})); // HTTP chat API
app.listen(8080);

await gateway.start(); // channel polling
```

Both are plain middleware typed against the parts of a request and response they touch, so they
drop into Express without casts and work equally with a bare `node:http` server or any framework
exposing the same shape. Express stays an optional peer dependency.

`channels` is optional: a gateway that only serves HTTP has none. A runnable version of the above
is in [`samples/gateway/universal`](../samples/gateway/universal/server.ts).

```
POST   /sessions                  create a conversation
GET    /sessions/:id              its history
DELETE /sessions/:id              start over
POST   /sessions/:id/messages     say something; streams the reply as SSE
GET    /health
```

`POST /messages` streams server-sent events, or returns one JSON body for `Accept:
application/json`. The session is created on first use, the turn is serialized against other work
on it, and a client hanging up aborts the run instead of paying for a reply nobody will read.

### Who is calling

`resolveUser` is required. Sessions are keyed by user, so reading the id from the request body
would let any caller fetch anyone's conversation by changing a string:

```ts
gateway.endpoints({resolveUser: (req) => req.session.user.id});
```

Because this mounts into a server you already have, your existing authentication runs in front of
it — the hook just connects that to session keys. `trustClientUserId: true` takes the id from the
body instead, for local development only.

### Which events a client sees

```ts
gateway.endpoints({filter: 'final'}); // the answer. Default.
gateway.endpoints({filter: 'all'}); // everything, as the debug server does
gateway.endpoints({filter: (e) => redact(e)}); // transform, or drop by returning undefined
```

`'final'` means the answer **plus anything the client must act on** — interrupts and errors — not
"the last event". Filtering an interrupt out is how a UI ends up waiting forever on a question it
was never shown.

## What it does for you

|                   |                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| **Sessions**      | `runAsync` throws on a missing session; the gateway get-or-creates one and records which chat it came from.     |
| **Serialization** | Two fast messages in one chat would otherwise start two invocations racing on one session.                      |
| **Interrupts**    | A paused run hides its prompt in a `functionCall` part, so a bot that renders only text just appears to hang.   |
| **Chunking**      | Model answers routinely exceed a channel's limit; splits fall on line boundaries and never inside a code fence. |
| **Markup**        | Model markdown becomes the channel's dialect, and falls back to plain text rather than losing a message.        |
| **Media**         | Photos, voice, video and documents become model input, with the size and format limits applied.                 |
| **Access**        | Per-channel allowlists, enforced before the agent runs.                                                         |

## Configuration

Configuration belongs to the layer whose constraints it encodes.

**Gateway-level** — things that come from ADK and the model, and do not vary by messenger:
`sessionService`, `artifactService`, `commands`, `formatError`, `render`, `onBusy`, and the
model-facing media limits (`maxInlineBytes`, `maxAudioPerTurn`).

**Channel-level** — things shaped by the messenger's own architecture: `access`, `session`,
credentials, `webhook`, and channel-specific media behavior such as what to do with a sticker.

```ts
telegram({
  token,
  session: 'per-conversation', // or per-user, per-thread, ephemeral
  access: {allowGroups: false, allowUsers: ['12345']},
  media: {sticker: 'emoji+thumbnail', videoNote: 'thumbnail'},
});
```

Note the unprefixed user id: inside a channel's config there is nothing else it could mean.

`access` has no gateway-level counterpart on purpose. Two layers of allowlist need precedence
rules, and that is where a bot accidentally opens up. To share one policy, share the object.

### Webhooks

```ts
telegram({
  token,
  webhook: {
    path: '/telegram',
    publicUrl: 'https://bot.example.com/telegram',
    secretToken: process.env.TELEGRAM_WEBHOOK_SECRET!,
  },
});

const server = express();
server.use(express.json());
server.use(gateway.router());
```

`publicUrl` registers the webhook on start. `secretToken` is checked on every delivery, in constant
time — without it the URL is the only thing protecting your bot.

## Testing a bot

`@google/adk-gateway/testing` provides an in-process channel, so a bot can be tested with no network
and no token:

```ts
import {memoryChannel, WHATSAPP_LIKE} from '@google/adk-gateway/testing';

const channel = memoryChannel();
const gateway = createGateway({agent, channels: [channel]});
await gateway.start();

expect((await channel.userSays('hello'))[0].text).toContain('Hi');
```

Pass `TELEGRAM_LIKE`, `WHATSAPP_LIKE` or `MINIMAL` to check a bot degrades properly on channels
without editing, buttons or threads.

## Channel support

|                 | Telegram                                      | Slack      | Google Chat | WhatsApp |
| --------------- | --------------------------------------------- | ---------- | ----------- | -------- |
| Status          | ✅                                            | planned    | planned     | planned  |
| Ingress         | polling + webhook                             |            |             |          |
| Session default | per conversation                              | per thread | per thread  | per user |
| Media in        | photo, voice, audio, video, sticker, document |            |             |          |
| Buttons         | transport ready                               |            |             |          |

## Human-in-the-loop

A tool with `requireConfirmation: true` pauses the run. ADK carries that pause in a `functionCall`
part rather than in text, so a client that renders only text shows nothing and the bot appears to
hang. The gateway turns it into a question:

> Run **delete_order**?
> • orderId: 4711
>
> [ ✅ Approve ] [ ❌ Reject ]

The prompt is built from the tool and its arguments. ADK's stock hint — _"…by responding with a
FunctionResponse with an expected ToolConfirmation payload"_ — is written for whoever is building
the client, so it is detected and replaced rather than shown to a user.

Buttons carry an opaque handle, not the answer. Payloads come back from the client, so a raw one
could be forged to approve something the user was never asked about; a handle is unguessable,
single-use, and remembers which session it was issued for. It also fits Telegram's 64-byte
`callback_data` limit, which the real answer would not.

Typing "yes" works too — being told to press a button after you have already answered is a poor
experience. ADK gates that narrowly (only the most recent pending confirmation, only immediately
after it is asked, only recognized words); set `plainTextConfirmation: false` to require the button.

## Known gaps

- **No streaming yet.** Answers arrive complete. Telegram's native draft API is the intended path in
  direct chats, with throttled edits in groups.
- **Telegram channels are not handled** — the adapter subscribes to `message` and `callback_query`,
  so posts in a Telegram _channel_ are ignored.
- **No proactive messaging yet** — `gateway.send()` and `gateway.trigger()` are designed but not
  implemented.
- **Long conversations grow unbounded.** `/reset` and `idleTtl` help; `ContextCompactorRequestProcessor`
  is the real answer.
