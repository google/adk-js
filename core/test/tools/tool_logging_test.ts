/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InMemoryArtifactService,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LOAD_ARTIFACTS,
  Logger,
  LogLevel,
  PluginManager,
  setLogger,
  setLogLevel,
  VertexAiSearchTool,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
// ScopedArtifactService is how the runner scopes an artifact service to one
// session, and it is not part of the public surface.
import {ScopedArtifactService} from '../../src/artifacts/scoped_artifact_service.js';
import {resetLogger} from '../../src/utils/logger.js';
import {installNodeLogger} from '../../src/utils/logger_node.js';

const APP_NAME = 'logging-test-app';
const USER_ID = 'logging-test-user';

/** A record of one call made on the {@link RecordingLogger}. */
interface LogRecord {
  level: LogLevel;
  message: string;
}

/** A {@link Logger} that keeps every record it is given. */
class RecordingLogger implements Logger {
  readonly records: LogRecord[] = [];

  setLogLevel(_level: LogLevel): void {}

  log(level: LogLevel, ...messages: unknown[]): void {
    this.records.push({level, message: messages.join(' ')});
  }

  debug(...messages: unknown[]): void {
    this.log(LogLevel.DEBUG, ...messages);
  }

  info(...messages: unknown[]): void {
    this.log(LogLevel.INFO, ...messages);
  }

  warn(...messages: unknown[]): void {
    this.log(LogLevel.WARN, ...messages);
  }

  error(...messages: unknown[]): void {
    this.log(LogLevel.ERROR, ...messages);
  }
}

/** Builds a real invocation context backed by the in-memory services. */
async function createInvocationContext(): Promise<InvocationContext> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
  const artifactService = new InMemoryArtifactService();
  await artifactService.saveArtifact({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: session.id,
    filename: 'present.txt',
    artifact: {text: 'hello'},
  });

  return new InvocationContext({
    invocationId: 'logging-test-invocation',
    agent: new LlmAgent({name: 'logging_test_agent'}),
    session,
    sessionService,
    artifactService: new ScopedArtifactService(
      artifactService,
      APP_NAME,
      USER_ID,
      session.id,
    ),
    pluginManager: new PluginManager(),
  });
}

/** A request that asks `load_artifacts` for an artifact that does not exist. */
function createMissingArtifactRequest(): LlmRequest {
  return {
    contents: [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'load_artifacts',
              response: {artifact_names: ['missing.txt']},
            },
          },
        ],
      },
    ],
    toolsDict: {},
    liveConnectConfig: {},
  };
}

describe('tool logging', () => {
  let toolContext: Context;

  beforeEach(async () => {
    toolContext = new Context({
      invocationContext: await createInvocationContext(),
    });
    installNodeLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetLogger();
  });

  describe('LoadArtifactsTool', () => {
    it('sends the missing-artifact warning to the current logger', async () => {
      const recorded = new RecordingLogger();
      setLogger(recorded);

      await LOAD_ARTIFACTS.processLlmRequest({
        toolContext,
        llmRequest: createMissingArtifactRequest(),
      });

      expect(recorded.records).toEqual([
        {
          level: LogLevel.WARN,
          message: 'Artifact "missing.txt" not found, skipping',
        },
      ]);
    });

    it('drops the missing-artifact warning at ERROR level', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setLogLevel(LogLevel.ERROR);

      await LOAD_ARTIFACTS.processLlmRequest({
        toolContext,
        llmRequest: createMissingArtifactRequest(),
      });

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('VertexAiSearchTool', () => {
    it('sends the search-config debug line to the current logger', async () => {
      const recorded = new RecordingLogger();
      setLogger(recorded);

      await new VertexAiSearchTool({dataStoreId: 'ds'}).processLlmRequest({
        toolContext,
        llmRequest: {
          model: 'gemini-2.0-flash',
          contents: [],
          toolsDict: {},
          liveConnectConfig: {},
        },
      });

      expect(recorded.records).toEqual([
        {
          level: LogLevel.DEBUG,
          message: expect.stringContaining(
            'Adding Vertex AI Search tool config to LLM request',
          ),
        },
      ]);
    });
  });
});
