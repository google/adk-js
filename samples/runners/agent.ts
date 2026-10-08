/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Archive a finished conversation with memoryService.addSessionToMemory
 * ../../docs/guides/runners/index.md
 *
 * `addSessionToMemory` hands a finished session to the memory service, which is
 * what makes the conversation searchable later. The call produces no output of
 * its own, so this sample archives a past conversation at startup and gives the
 * agent a tool that searches the same memory service.
 *
 * A real caller reaches the same place by running a conversation with
 * `runAsync` and calling `addSessionToMemory` when it ends. The transcript is
 * replayed from a file here so the sample stays deterministic and needs no
 * second model call.
 *
 * REQUIRES an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/runners/agent.ts
 */

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  createEvent,
  FunctionTool,
  InMemoryMemoryService,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';
import {z} from 'zod';

const APP_NAME = 'conversation_archive';
const USER_ID = 'sample_user';

const transcriptSchema = z.array(
  z.object({author: z.string(), text: z.string()}),
);

const transcriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'transcript.json',
);

const transcript = transcriptSchema.parse(
  JSON.parse(readFileSync(transcriptPath, 'utf8')),
);

/** The store `addSessionToMemory` archives into and the tool below searches. */
const memoryService = new InMemoryMemoryService();

const searchArchive = new FunctionTool({
  name: 'search_archive',
  description: 'Searches the archived conversation and returns matching turns.',
  parameters: z.object({
    query: z
      .string()
      .describe('Keywords to look for, such as "hotel" or "flight".'),
  }),
  execute: async ({query}) => {
    const {memories} = await memoryService.searchMemory({
      appName: APP_NAME,
      userId: USER_ID,
      query,
    });
    return {
      matches: memories.map((memory) => ({
        author: memory.author,
        text: memory.content.parts
          ?.map((part) => part.text)
          .filter((text) => !!text)
          .join(' '),
      })),
    };
  },
});

export const rootAgent = new LlmAgent({
  name: 'archive_assistant',
  model: 'gemini-flash-latest',
  description: 'Answers questions from an archived conversation.',
  instruction:
    'Answer every question from the archived conversation. Call the ' +
    'search_archive tool first, quote what it returns, and say the archive ' +
    'holds nothing on the subject when the search returns no match.',
  tools: [searchArchive],
});

/** Archives the past conversation. It never runs the agent a `Runner` requires. */
const archiveRunner = new Runner({
  appName: APP_NAME,
  agent: rootAgent,
  sessionService: new InMemorySessionService(),
  memoryService,
});

/** Replays the transcript into a session, then archives that session. */
async function archivePastConversation(): Promise<void> {
  const session = await archiveRunner.sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });

  for (const turn of transcript) {
    await archiveRunner.sessionService.appendEvent({
      session,
      event: createEvent({
        author: turn.author,
        content: {
          role: turn.author === 'user' ? 'user' : 'model',
          parts: [{text: turn.text}],
        },
      }),
    });
  }

  await memoryService.addSessionToMemory(session);
}

await archivePastConversation();
