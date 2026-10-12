/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Memory (`BaseMemoryService`, `InMemoryMemoryService`, and `MemoryEntry`)
 * ../../docs/guides/memory/index.md
 *
 * A deterministic `BaseAgent` that ingests completed prior sessions into
 * `ctx.memoryService` (`InMemoryMemoryService`), queries tenant-scoped
 * `MemoryEntry` items via `searchMemory({appName, userId, query})`, and
 * persists the matched memory digest to `ctx.artifactService` while recording
 * the revision in `EventActions.artifactDelta`.
 *
 * This sample exports `rootAgent` for `adk web` and `npm run sample`, and also
 * includes a direct `InMemoryRunner` driver (`main()`) because the CLI only
 * prints conversational text — running directly lets `main()` inspect the
 * structured `MemoryEntry` fields (`author`, ISO 8601 `timestamp`, and
 * `content`) and verify that searching under a second `userId` returns zero
 * memories from the first user's sessions.
 *
 * Run (offline, no API key):
 *   npx tsx samples/memory/agent.ts
 *   npm run sample -- samples/memory/agent.ts
 */

import {
  BaseAgent,
  createEvent,
  createEventActions,
  createSession,
  Event,
  getFunctionCalls,
  getFunctionResponses,
  InMemoryMemoryService,
  InMemoryRunner,
  InvocationContext,
  isFinalResponse,
  MemoryEntry,
  stringifyContent,
} from '@google/adk';
import {fileURLToPath} from 'node:url';

const MEMORY_DIGEST_FILENAME = 'memory_digest.json';

function extractEntryText(entry: MemoryEntry): string {
  return (
    entry.content.parts
      ?.map((part) => part.text ?? '')
      .filter((text) => text.length > 0)
      .join(' ') ?? ''
  );
}

class MemoryShowcaseAgent extends BaseAgent {
  private readonly fallbackMemoryService = new InMemoryMemoryService();

  constructor() {
    super({
      name: 'memory_showcase_agent',
      description:
        'Demonstrates cross-session memory ingestion and tenant-scoped search via BaseMemoryService.',
    });
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const memoryService = ctx.memoryService ?? this.fallbackMemoryService;
    const userQuery =
      ctx.userContent?.parts
        ?.map((part) => part.text ?? '')
        .join(' ')
        .trim() || 'Lisbon vegetarian hotel';

    const priorTripSession = createSession({
      id: 'prior-session-lisbon',
      appName: ctx.appName,
      userId: ctx.userId,
      events: [
        createEvent({
          author: 'user',
          timestamp: Date.parse('2025-02-10T09:15:00.000Z'),
          content: {
            role: 'user',
            parts: [
              {
                text: 'We booked flights to Lisbon with Nadia for October 14 and requested vegetarian meals.',
              },
            ],
          },
        }),
        createEvent({
          author: 'model',
          timestamp: Date.parse('2025-02-10T09:16:00.000Z'),
          content: {
            role: 'model',
            parts: [
              {
                text: 'Confirmed Lisbon hotel near Rossio Square with late check-in.',
              },
            ],
          },
        }),
      ],
    });

    const otherTenantSession = createSession({
      id: 'prior-session-other-user',
      appName: ctx.appName,
      userId: 'other-user',
      events: [
        createEvent({
          author: 'user',
          timestamp: Date.parse('2025-02-11T14:00:00.000Z'),
          content: {
            role: 'user',
            parts: [
              {
                text: 'Secret Lisbon itinerary belonging to another user.',
              },
            ],
          },
        }),
      ],
    });

    await memoryService.addSessionToMemory(priorTripSession);
    await memoryService.addSessionToMemory(otherTenantSession);

    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call-memory-1',
              name: 'recallUserMemories',
              args: {
                appName: ctx.appName,
                userId: ctx.userId,
                query: userQuery,
              },
            },
          },
        ],
      },
    });

    const searchResult = await memoryService.searchMemory({
      appName: ctx.appName,
      userId: ctx.userId,
      query: userQuery,
    });

    const matchedSummaries = searchResult.memories.map((entry) => ({
      author: entry.author ?? 'unknown',
      timestamp: entry.timestamp ?? '',
      text: extractEntryText(entry),
    }));

    const artifactDelta: Record<string, number> = {};
    if (ctx.artifactService) {
      const rev = await ctx.artifactService.saveArtifact({
        filename: MEMORY_DIGEST_FILENAME,
        artifact: {
          text: JSON.stringify(
            {
              appName: ctx.appName,
              userId: ctx.userId,
              query: userQuery,
              matchCount: matchedSummaries.length,
              memories: matchedSummaries,
            },
            null,
            2,
          ),
        },
      });
      artifactDelta[MEMORY_DIGEST_FILENAME] = rev;
    }

    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-memory-1',
              name: 'recallUserMemories',
              response: {
                appName: ctx.appName,
                userId: ctx.userId,
                query: userQuery,
                matchCount: matchedSummaries.length,
                memories: matchedSummaries,
              },
            },
          },
        ],
      },
      actions: createEventActions({
        stateDelta: {
          lastMemoryQuery: userQuery,
          recalledMemoryCount: matchedSummaries.length,
        },
        artifactDelta,
      }),
    });

    const recalledLines = matchedSummaries
      .map((item) => `[${item.timestamp}] ${item.author}: "${item.text}"`)
      .join(' | ');

    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      branch: ctx.branch,
      content: {
        role: 'model',
        parts: [
          {
            text: `Recalled ${matchedSummaries.length} memory entries for ${ctx.userId} in ${ctx.appName}: ${recalledLines}`,
          },
        ],
      },
    });
  }

  protected override async *runLiveImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(ctx);
  }
}

export const rootAgent = new MemoryShowcaseAgent();

async function main() {
  const appName = 'memory_sample_app';
  const userId = 'user-1';
  const runner = new InMemoryRunner({
    agent: rootAgent,
    appName,
  });

  const session = await runner.sessionService.createSession({
    appName,
    userId,
  });

  for await (const event of runner.runAsync({
    userId,
    sessionId: session.id,
    newMessage: {
      role: 'user',
      parts: [
        {
          text: 'Who am I traveling to Lisbon with and what meal did I request?',
        },
      ],
    },
  })) {
    const calls = getFunctionCalls(event);
    const responses = getFunctionResponses(event);
    process.stdout.write(
      `${JSON.stringify({
        id: event.id,
        author: event.author,
        isFinal: isFinalResponse(event),
        functionCalls: calls.map((c) => c.name),
        functionResponses: responses.map((r) => r.name),
        artifactDelta: event.actions.artifactDelta,
        text: stringifyContent(event),
      })}\n`,
    );
  }

  const unindexedUserCheck = await runner.memoryService?.searchMemory({
    appName,
    userId: 'unindexed-user',
    query: 'Lisbon',
  });
  process.stdout.write(
    `Memories visible to unindexed-user: ${JSON.stringify(unindexedUserCheck?.memories ?? [])}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
