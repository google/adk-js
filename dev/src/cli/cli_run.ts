/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {BaseAgent, BaseArtifactService, BaseMemoryService, BaseSessionService, InMemoryArtifactService, InMemoryMemoryService, InMemorySessionService, Runner, Session} from '@google/adk';
import esbuild from 'esbuild';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';

const dirname = process.cwd();

interface InputFile {
  state: Record<string, unknown>;
  queries: string[];
}

async function loadFileData<T>(filePath: string): Promise<T|undefined> {
  try {
    return JSON.parse(await fs.readFile(
               path.join(dirname, filePath), {encoding: 'utf-8'})) as T;
  } catch (e) {
    console.error(`Failed to read or parse file ${filePath}:`, e);
  }
}

async function saveToFile<T>(filePath: string, data: T): Promise<void> {
  try {
    await fs.writeFile(
        path.join(dirname, filePath), JSON.stringify(data, null, 2),
        {encoding: 'utf-8'});
  } catch (e) {
    console.error(`Failed to write file ${filePath}:`, e);
  }
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

let cleanupFile: string|undefined;
async function loadAgent(filePath: string): Promise<BaseAgent> {
  if (filePath.endsWith('.ts')) {
    const compiledFilePath = filePath.replace('.ts', '.cjs');

    await esbuild.build({
      entryPoints: [filePath],
      outfile: compiledFilePath,
      target: 'node10.4',
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      bundle: true,
    });

    cleanupFile = compiledFilePath;
    filePath = compiledFilePath;
  }

  const jsModule = await import(filePath);

  if (jsModule && jsModule.rootAgent) {
    return jsModule.rootAgent;
  }

  throw new Error(`Failed to load agent ${filePath}: No rootAgent found`);
}

async function cleanupIfRequire(): Promise<void> {
  if (cleanupFile) {
    return fs.unlink(cleanupFile);
  }
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
async function runFromInputFile(options: RunFromInputFileOptions):
    Promise<Session|undefined> {
  const fileContent = await loadFileData<InputFile>(options.filePath);
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

    for await (const event of runner.run(runOptions)) {
      if (event.content && event.content.parts) {
        const text =
            event.content.parts.map((part) => part.text || '').join('');
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
async function runInteractively(options: RunInteractivelyOptions):
    Promise<void> {
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

    for await (const event of runner.run({
      userId: options.session.userId,
      sessionId: options.session.id,
      newMessage: {role: 'user', parts: [{text: query}]},
    })) {
      if (event.content && event.content.parts) {
        const text =
            event.content.parts.map((part) => part.text || '').join('');
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
}
export async function runAgent(options: RunAgentOptions): Promise<void> {
  try {
    const userId = 'test_user';
    const artifactService = new InMemoryArtifactService();
    const sessionService = new InMemorySessionService();
    const memoryService = new InMemoryMemoryService();
    const rootAgent = await loadAgent(path.join(dirname, options.agentPath));

    let session = await sessionService.createSession({
      appName: rootAgent.name,
      userId,
    });

    if (options.inputFile) {
      session = await runFromInputFile({
                  appName: rootAgent.name,
                  userId,
                  agent: rootAgent,
                  artifactService,
                  sessionService,
                  memoryService,
                  filePath: options.inputFile,
                }) ||
          session;
    } else if (options.savedSessionFile) {
      const loadedSession =
          await loadFileData<Session>(options.savedSessionFile);
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
          options.sessionId || await getUserInput('Session ID to save: ');
      const sessionPath =
          path.join(options.agentPath, `${sessionId}.session.json`);
      const sessionToStore = await sessionService.getSession({
        appName: session.appName,
        userId: session.userId,
        sessionId: session.id,
      });
      await saveToFile(sessionPath, sessionToStore);

      console.log('Session saved to', sessionPath);
    }

    await cleanupIfRequire();
  } catch (e) {
    console.log(e);
  }
}