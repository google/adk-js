/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseArtifactService,
  BaseMemoryService,
  BaseSessionService,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  Runner,
  Session,
} from '@google/adk';
import * as path from 'node:path';
import * as readline from 'node:readline';

import {AgentFile} from '../utils/agent_loader';
import {loadFileData, saveToFile} from '../utils/file_utils.js';

const dirname = process.cwd();

interface InputFile {
  state: Record<string, unknown>;
  queries: string[];
}

async function getUserInput(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

interface RunFromInputFileOptions {
  appName: string;
  userId: string;
  agent: BaseAgent;
  artifactService: BaseArtifactService;
  sessionService: BaseSessionService;
  memoryService?: BaseMemoryService;
  filePath: string;
}
async function runFromInputFile(
  options: RunFromInputFileOptions,
): Promise<Session | undefined> {
  const fileContent = await loadFileData<InputFile>(
    path.join(dirname, options.filePath),
  );
  if (!fileContent) {
    return;
  }

  fileContent.state['_time'] = new Date().toISOString();

  const session = await options.sessionService.createSession({
    appName: options.appName,
    userId: options.userId,
    state: fileContent.state,
  });

  const runner = new Runner(options);

  for (const query of fileContent.queries) {
    console.log(`[user]: ${query}`);

    const runOptions = {
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: query}]},
    };

    for await (const event of runner.runAsync(runOptions)) {
      if (event.content && event.content.parts) {
        const text = event.content.parts
          .map((part) => part.text || '')
          .join('');
        if (text) {
          console.log(`[${event.author}]: ${text}`);
        }
      }
    }
  }

  return session;
}

interface RunInteractivelyOptions {
  rootAgent: BaseAgent;
  session: Session;
  artifactService: BaseArtifactService;
  sessionService: BaseSessionService;
  memoryService?: BaseMemoryService;
}
async function runInteractively(
  options: RunInteractivelyOptions,
): Promise<void> {
  const runner = new Runner({
    appName: options.rootAgent.name,
    agent: options.rootAgent,
    artifactService: options.artifactService,
    sessionService: options.sessionService,
    memoryService: options.memoryService,
  });

  while (true) {
    const query = await getUserInput('[user]: ');

    if (!query || !query.trim()) {
      continue;
    }

    if (query === 'exit') {
      break;
    }

    for await (const event of runner.runAsync({
      userId: options.session.userId,
      sessionId: options.session.id,
      newMessage: {role: 'user', parts: [{text: query}]},
    })) {
      if (event.content && event.content.parts) {
        const text = event.content.parts
          .map((part) => part.text || '')
          .join('');
        if (text) {
          console.log(`[${event.author}]: ${text}`);
        }
      }
    }
  }
}

/**
 * Runs an interactive CLI for a certain agent.
 */
export interface RunAgentOptions {
  agentPath: string;
  inputFile?: string;
  savedSessionFile?: string;
  saveSession?: boolean;
  sessionId?: string;
  artifactService?: BaseArtifactService;
  sessionService?: BaseSessionService;
  memoryService?: BaseMemoryService;
  otelToCloud?: boolean;
}
export async function runAgent(options: RunAgentOptions): Promise<void> {
  try {
    const userId = 'test_user';
    const artifactService =
      options.artifactService || new InMemoryArtifactService();
    const sessionService =
      options.sessionService || new InMemorySessionService();
    const memoryService = options.memoryService || new InMemoryMemoryService();
    await using agentFile = new AgentFile(
      path.join(dirname, options.agentPath),
    );
    const rootAgent = await agentFile.load();

    let session = await sessionService.createSession({
      appName: rootAgent.name,
      userId,
    });

    if (options.inputFile) {
      session =
        (await runFromInputFile({
          appName: rootAgent.name,
          userId,
          agent: rootAgent,
          artifactService,
          sessionService,
          memoryService,
          filePath: options.inputFile,
        })) || session;
    } else if (options.savedSessionFile) {
      const loadedSession = await loadFileData<Session>(
        options.savedSessionFile,
      );
      if (loadedSession) {
        for (const event of loadedSession.events) {
          await sessionService.appendEvent({session, event});
          const content = event.content;
          if (content && content.parts?.length) {
            const text = content.parts.map((part) => part.text || '').join('');
            if (text) {
              console.log(`[${event.author}]: ${text}`);
            }
          }
        }
      }

      await runInteractively({
        rootAgent,
        artifactService,
        sessionService,
        memoryService,
        session,
      });
    } else {
      console.log(`Running agent ${rootAgent.name}, type exit to exit.`);
      await runInteractively({
        rootAgent,
        artifactService,
        sessionService,
        memoryService,
        session,
      });
    }

    if (options.saveSession) {
      const sessionId =
        options.sessionId || (await getUserInput('Session ID to save: '));
      const sessionPath = path.join(
        options.agentPath,
        `${sessionId}.session.json`,
      );
      const sessionToStore = await sessionService.getSession({
        appName: session.appName,
        userId: session.userId,
        sessionId: session.id,
      });
      await saveToFile(path.join(dirname, sessionPath), sessionToStore);

      console.log('Session saved to', sessionPath);
    }
  } catch (e) {
    console.log(e);
  }
}
