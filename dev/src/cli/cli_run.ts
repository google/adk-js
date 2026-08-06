/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  BaseAgent,
  BaseArtifactService,
  BaseMemoryService,
  BaseSessionService,
  Event,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  isApp,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_EUC_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  Runner,
  Session,
} from '@google/adk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

import {AgentFile, AgentFileOptions} from '../utils/agent_loader.js';
import {loadFileData, saveToFile} from '../utils/file_utils.js';

const dirname = process.cwd();

/**
 * Renders an interrupt (a pause waiting on the user) as human-readable text.
 *
 * A pause is carried in a `functionCall` part, not a text part, so without this
 * the REPL prints nothing and silently returns to the `[user]:` prompt while
 * the run is blocked — the user has no way to know a reply is expected.
 *
 * Returns undefined for anything that is not an interrupt.
 */
function renderInterrupt(
  author: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- genai FunctionCall args are untyped.
  functionCall: {name?: string; args?: Record<string, any>},
): string | undefined {
  // An unnamed call can never be an interrupt; bail before the switch so it
  // cannot accidentally match a constant that failed to resolve.
  if (!functionCall.name) {
    return undefined;
  }

  const args = functionCall.args ?? {};
  const lines: string[] = [];

  switch (functionCall.name) {
    case REQUEST_INPUT_FUNCTION_CALL_NAME: {
      lines.push(`--- [${author}] is waiting for your input ---`);
      if (typeof args['message'] === 'string') {
        lines.push(args['message']);
      }
      if (args['payload'] != null) {
        lines.push(`Payload: ${JSON.stringify(args['payload'])}`);
      }
      if (args['responseSchema'] != null) {
        lines.push(
          `Expected response: ${JSON.stringify(args['responseSchema'])}`,
        );
      }
      lines.push('Type your reply at the next prompt to continue.');
      break;
    }
    case REQUEST_CONFIRMATION_FUNCTION_CALL_NAME: {
      const toolName = args['originalFunctionCall']?.name;
      lines.push(
        `--- [${author}] is waiting for confirmation ---` +
          (toolName ? `\nTool: ${toolName}` : ''),
      );
      const hint = args['toolConfirmation']?.hint;
      if (typeof hint === 'string' && hint.trim()) {
        lines.push(hint);
      }
      lines.push("Reply 'yes' to approve or 'no' to reject.");
      break;
    }
    case REQUEST_EUC_FUNCTION_CALL_NAME: {
      lines.push(`--- [${author}] is waiting for a credential ---`);
      if (typeof args['message'] === 'string') {
        lines.push(args['message']);
      }
      const scheme = args['authConfig']?.authScheme;
      if (scheme?.type) {
        const where =
          scheme.in && scheme.name ? ` (${scheme.in} ${scheme.name})` : '';
        lines.push(`Auth scheme: ${scheme.type}${where}`);
      }
      lines.push('Type the credential at the next prompt to continue.');
      break;
    }
    default:
      return undefined;
  }

  return lines.join('\n');
}

/**
 * Prints one event to the console: its text, plus any interrupt prompt that
 * would otherwise be invisible to an interactive user.
 */
function printEvent(event: Event): void {
  const parts = event.content?.parts;
  if (!parts) {
    return;
  }

  const author = event.author ?? 'agent';
  const text = parts.map((part) => part.text || '').join('');
  if (text) {
    console.log(`[${author}]: ${text}`);
  }

  for (const part of parts) {
    if (!part.functionCall) {
      continue;
    }
    const prompt = renderInterrupt(author, part.functionCall);
    if (prompt) {
      console.log(prompt);
    }
  }
}

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
      // Interactive CLI: let a plain-text "yes"/"no" resolve a pending tool
      // confirmation (opt-in; off by default on non-interactive surfaces).
      runConfig: {plainTextToolConfirmation: true},
    };

    for await (const event of runner.runAsync(runOptions)) {
      printEvent(event);
    }
  }

  return session;
}

interface RunInteractivelyOptions {
  rootAgent?: BaseAgent;
  app?: App;
  session: Session;
  artifactService: BaseArtifactService;
  sessionService: BaseSessionService;
  memoryService?: BaseMemoryService;
  onAgentFileReloaded?: (subscribe: (newAgent: BaseAgent) => void) => void;
}
async function runInteractively(
  options: RunInteractivelyOptions,
): Promise<void> {
  let currentAgent = options.rootAgent || options.app?.rootAgent;
  let runner = new Runner({
    app: options.app,
    appName: options.app?.name ?? currentAgent.name,
    agent: options.app?.rootAgent ?? currentAgent,
    artifactService: options.artifactService,
    sessionService: options.sessionService,
    memoryService: options.memoryService,
  });

  options.onAgentFileReloaded?.((newAgent: BaseAgent) => {
    currentAgent = newAgent;
    runner = new Runner({
      appName: newAgent.name,
      agent: newAgent,
      artifactService: options.artifactService,
      sessionService: options.sessionService,
      memoryService: options.memoryService,
    });
    console.log(`Agent reloaded. New runner created with existing session.`);
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
      // Interactive CLI: let a plain-text "yes"/"no" resolve a pending tool
      // confirmation (opt-in; off by default on non-interactive surfaces).
      runConfig: {plainTextToolConfirmation: true},
    })) {
      printEvent(event);
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
  agentFileLoadOptions?: AgentFileOptions;
  reloadAgents?: boolean;
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
      options.agentFileLoadOptions,
    );
    const loaded = await agentFile.load();
    const rootAgent = isApp(loaded) ? loaded.rootAgent : loaded;
    const app = isApp(loaded) ? loaded : undefined;

    let session = await sessionService.createSession({
      appName: app?.name ?? rootAgent.name,
      userId,
    });

    const reloadSubscribers: Array<(agent: BaseAgent) => void> = [];
    let watcher: fs.FSWatcher | undefined;

    if (options.reloadAgents) {
      const agentFilePath = path.join(dirname, options.agentPath);
      watcher = fs.watch(agentFilePath, async () => {
        try {
          await using reloadedFile = new AgentFile(
            agentFilePath,
            options.agentFileLoadOptions,
          );
          const reloaded = await reloadedFile.load();
          const newAgent = isApp(reloaded) ? reloaded.rootAgent : reloaded;
          for (const subscriber of reloadSubscribers) {
            subscriber(newAgent);
          }
        } catch (err) {
          console.warn('Failed to reload agent:', (err as Error).message);
        }
      });
    }

    const onAgentFileReloaded = (subscribe: (agent: BaseAgent) => void) => {
      reloadSubscribers.push(subscribe);
    };

    try {
      if (options.inputFile) {
        session =
          (await runFromInputFile({
            appName: app?.name ?? rootAgent.name,
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
            printEvent(event);
          }
        }

        await runInteractively({
          rootAgent,
          app,
          artifactService,
          sessionService,
          memoryService,
          session,
          onAgentFileReloaded: options.reloadAgents
            ? onAgentFileReloaded
            : undefined,
        });
      } else {
        console.log(
          `Running ${app ? `app ${app.name}` : `agent ${rootAgent.name}`}, type exit to exit.`,
        );
        await runInteractively({
          rootAgent,
          app,
          artifactService,
          sessionService,
          memoryService,
          session,
          onAgentFileReloaded: options.reloadAgents
            ? onAgentFileReloaded
            : undefined,
        });
      }
    } finally {
      watcher?.close();
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
