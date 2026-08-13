/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  BaseArtifactService,
  BaseMemoryService,
  BaseSessionService,
  Event,
  getPendingUserInputRequests,
  getUserInputRequests,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  isApp,
  requiresUserInput,
  RunnableRoot,
  Runner,
  Session,
  UserInputKind,
  UserInputRequest,
} from '@google/adk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

import {AgentFile, AgentFileOptions} from '../utils/agent_loader.js';
import {
  getAbsolutePath,
  loadFileData,
  saveToFile,
} from '../utils/file_utils.js';

const HOW_TO_ANSWER: Record<UserInputKind, string> = {
  input: 'Type your reply at the next prompt to continue.',
  credential: 'Type the credential at the next prompt to continue.',
  confirmation: "Reply 'yes' to approve or 'no' to reject.",
};

/**
 * Formatting only — detection lives in `getUserInputRequests`. This decides how
 * the CLI words a pause and how the user is told to answer it.
 */
function renderUserInputRequest(request: UserInputRequest): string {
  const author = request.author ?? 'agent';
  const lines: string[] = [];

  switch (request.kind) {
    case 'input':
      lines.push(`--- [${author}] is waiting for your input ---`);
      break;
    case 'credential':
      lines.push(`--- [${author}] is waiting for a credential ---`);
      break;
    case 'confirmation':
      lines.push(
        `--- [${author}] is waiting for confirmation ---` +
          (request.toolName ? `\nTool: ${request.toolName}` : ''),
      );
      break;
    default:
      break;
  }

  if (request.message) {
    lines.push(request.message);
  }
  if (request.payload != null) {
    lines.push(`Payload: ${JSON.stringify(request.payload)}`);
  }
  if (request.responseSchema != null) {
    lines.push(`Expected response: ${JSON.stringify(request.responseSchema)}`);
  }

  const scheme = request.authConfig?.authScheme as
    | {type?: string; in?: string; name?: string}
    | undefined;
  if (scheme?.type) {
    const where =
      scheme.in && scheme.name ? ` (${scheme.in} ${scheme.name})` : '';
    lines.push(`Auth scheme: ${scheme.type}${where}`);
  }

  lines.push(HOW_TO_ANSWER[request.kind]);

  return lines.join('\n');
}

interface PrintEventOptions {
  /**
   * Whether to announce the pauses this event raised. Off when replaying a
   * saved transcript, where a pause shown per event would re-ask questions the
   * user already answered; the still-open ones are printed once afterwards.
   */
  announcePauses?: boolean;
}

/** Prints one event's text, plus anything the user would otherwise not see. */
function printEvent(event: Event, options: PrintEventOptions = {}): void {
  const {announcePauses = true} = options;
  const author = event.author ?? 'agent';

  const text = (event.content?.parts ?? [])
    .map((part) => part.text || '')
    .join('');
  if (text) {
    console.log(`[${author}]: ${text}`);
  }

  // Reported on the event, not as a text part, so text-only printing drops it.
  if (event.errorCode || event.errorMessage) {
    const detail = [event.errorCode, event.errorMessage]
      .filter(Boolean)
      .join(': ');
    console.error(`[${author}] error: ${detail}`);
  }

  if (!announcePauses) {
    return;
  }

  for (const request of getUserInputRequests(event)) {
    console.log(renderUserInputRequest(request));
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
  agent: RunnableRoot;
  artifactService: BaseArtifactService;
  sessionService: BaseSessionService;
  memoryService?: BaseMemoryService;
  filePath: string;
}
async function runFromInputFile(
  options: RunFromInputFileOptions,
): Promise<Session | undefined> {
  const fileContent = await loadFileData<InputFile>(
    getAbsolutePath(options.filePath),
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
  let waitingOnUser = false;

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

    waitingOnUser = false;
    for await (const event of runner.runAsync(runOptions)) {
      printEvent(event);
      // A scripted run has no prompt to answer at: whatever the pause asked
      // for has to be the next query in the file.
      waitingOnUser = requiresUserInput(event) || waitingOnUser;
    }
  }

  if (waitingOnUser) {
    console.error(
      'The run ended while still waiting for user input. ' +
        'Add the answer as the next query in the input file.',
    );
  }

  return session;
}

interface RunInteractivelyOptions {
  rootAgent?: RunnableRoot;
  app?: App;
  session: Session;
  artifactService: BaseArtifactService;
  sessionService: BaseSessionService;
  memoryService?: BaseMemoryService;
  onAgentFileReloaded?: (subscribe: (newAgent: RunnableRoot) => void) => void;
}
async function runInteractively(
  options: RunInteractivelyOptions,
): Promise<void> {
  const currentRoot = options.rootAgent ?? options.app?.rootAgent;
  if (!currentRoot) {
    throw new Error('cli_run requires a rootAgent or an app.');
  }
  let currentAgent: RunnableRoot = currentRoot;
  let runner = new Runner({
    app: options.app,
    appName: options.app?.name ?? currentAgent.name,
    agent: options.app?.rootAgent ?? currentAgent,
    artifactService: options.artifactService,
    sessionService: options.sessionService,
    memoryService: options.memoryService,
  });

  options.onAgentFileReloaded?.((newAgent: RunnableRoot) => {
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
  const userId = 'test_user';
  const artifactService =
    options.artifactService || new InMemoryArtifactService();
  const sessionService = options.sessionService || new InMemorySessionService();
  const memoryService = options.memoryService || new InMemoryMemoryService();
  await using agentFile = new AgentFile(
    getAbsolutePath(options.agentPath),
    options.agentFileLoadOptions,
  );
  const loaded = await agentFile.load();
  const rootAgent = isApp(loaded) ? loaded.rootAgent : loaded;
  const app = isApp(loaded) ? loaded : undefined;

  let session = await sessionService.createSession({
    appName: app?.name ?? rootAgent.name,
    userId,
  });

  const reloadSubscribers: Array<(agent: RunnableRoot) => void> = [];
  let watcher: fs.FSWatcher | undefined;

  if (options.reloadAgents) {
    const agentFilePath = getAbsolutePath(options.agentPath);
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

  const onAgentFileReloaded = (subscribe: (agent: RunnableRoot) => void) => {
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
          printEvent(event, {announcePauses: false});
        }

        // Only the pauses the transcript never answered are still live, and
        // they are what the prompt below is waiting on.
        for (const request of getPendingUserInputRequests(
          loadedSession.events,
        )) {
          console.log(renderUserInputRequest(request));
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
    // Sibling of the agent file, not inside it: joining onto the agent path
    // itself yields `<cwd>/agent.ts/<id>.session.json`, and saveToFile does
    // no mkdir, so the write failed with ENOTDIR.
    const sessionPath = path.join(
      path.dirname(options.agentPath),
      `${sessionId}.session.json`,
    );
    const sessionToStore = await sessionService.getSession({
      appName: session.appName,
      userId: session.userId,
      sessionId: session.id,
    });
    await saveToFile(getAbsolutePath(sessionPath), sessionToStore);

    console.log('Session saved to', sessionPath);
  }
}
