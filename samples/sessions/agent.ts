/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sessions (`Session`, `State`, and `InMemorySessionService`)
 * ../../docs/guides/sessions/index.md
 *
 * A deterministic `BaseAgent` that reads `ctx.session.state` and emits one
 * event whose `EventActions.stateDelta` writes four kinds of key: a session
 * key (`turnCount`), a `user:` key (`user:visits`), an `app:` key
 * (`app:totalTurns`) and a `temp:` key (`temp:lastMessage`). The session
 * service stores each scope separately: `user:` and `app:` keys carry over to
 * a new session, the session key starts again, and the `temp:` key is never
 * stored.
 *
 * This sample exports `rootAgent` for `adk web` and `npm run sample`, and also
 * includes a direct `InMemoryRunner` driver (`main()`) because the CLI only
 * prints conversational text. Running the file directly creates a session
 * with a padded id to show that the id is trimmed, runs turns in two sessions
 * for one user, and prints the state that `getSession` returns after each
 * turn.
 *
 * Run (offline, no API key):
 *   npx tsx samples/sessions/agent.ts
 *   npm run sample -- samples/sessions/agent.ts
 */

import {
  BaseAgent,
  createEvent,
  createEventActions,
  Event,
  InMemoryRunner,
  InvocationContext,
  State,
  stringifyContent,
} from '@google/adk';
import {fileURLToPath} from 'node:url';

const TURN_COUNT = 'turnCount';
const USER_VISITS = `${State.USER_PREFIX}visits`;
const APP_TOTAL_TURNS = `${State.APP_PREFIX}totalTurns`;
const TEMP_LAST_MESSAGE = `${State.TEMP_PREFIX}lastMessage`;

function readCount(state: Record<string, unknown>, key: string): number {
  const value = state[key];
  return typeof value === 'number' ? value : 0;
}

class SessionStateAgent extends BaseAgent {
  constructor() {
    super({
      name: 'session_state_agent',
      description:
        'Counts turns at session, user and app scope through stateDelta.',
    });
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const state = ctx.session.state;
    const turnCount = readCount(state, TURN_COUNT) + 1;
    const userVisits = readCount(state, USER_VISITS) + 1;
    const appTotalTurns = readCount(state, APP_TOTAL_TURNS) + 1;
    const message =
      ctx.userContent?.parts?.map((part) => part.text ?? '').join('') ?? '';

    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      content: {
        role: 'model',
        parts: [
          {
            text:
              `Session ${ctx.session.id}: turn ${turnCount} of this session, ` +
              `visit ${userVisits} for user ${ctx.session.userId}, ` +
              `turn ${appTotalTurns} for app ${ctx.appName}.`,
          },
        ],
      },
      actions: createEventActions({
        stateDelta: {
          [TURN_COUNT]: turnCount,
          [USER_VISITS]: userVisits,
          [APP_TOTAL_TURNS]: appTotalTurns,
          [TEMP_LAST_MESSAGE]: message,
        },
      }),
    });
  }

  protected override async *runLiveImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(ctx);
  }
}

export const rootAgent = new SessionStateAgent();

async function runTurn(
  runner: InMemoryRunner,
  userId: string,
  sessionId: string,
  text: string,
): Promise<void> {
  for await (const event of runner.runAsync({
    userId,
    sessionId,
    newMessage: {role: 'user', parts: [{text}]},
  })) {
    process.stdout.write(`[${event.author}]: ${stringifyContent(event)}\n`);
  }

  const session = await runner.sessionService.getSession({
    appName: runner.appName,
    userId,
    sessionId,
  });
  process.stdout.write(`  state: ${JSON.stringify(session?.state)}\n`);
}

async function main() {
  const appName = 'sessions_sample_app';
  const userId = 'user-1';
  const runner = new InMemoryRunner({agent: rootAgent, appName});

  const first = await runner.sessionService.createSession({
    appName,
    userId,
    sessionId: '  first-session  ',
  });
  process.stdout.write(`Created session id: ${JSON.stringify(first.id)}\n`);

  await runTurn(runner, userId, first.id, 'Hello');
  await runTurn(runner, userId, first.id, 'Hello again');

  const second = await runner.sessionService.createSession({appName, userId});
  process.stdout.write(`Created session id: ${JSON.stringify(second.id)}\n`);
  await runTurn(runner, userId, second.id, 'Hello from a new session');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
