/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as readline from 'node:readline';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {runAgent} from '../../src/cli/cli_run.js';
import {AgentFile} from '../../src/utils/agent_loader.js';
import {loadFileData, saveToFile} from '../../src/utils/file_utils.js';

// Mock dependencies
vi.mock('../../src/utils/agent_loader.js', () => ({
  AgentFile: vi.fn(),
}));

vi.mock('../../src/utils/file_utils.js', () => ({
  loadFileData: vi.fn(),
  saveToFile: vi.fn(),
}));

vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    Runner: vi.fn().mockImplementation(() => ({
      runAsync: vi.fn().mockImplementation(async function* () {
        yield {
          author: 'model',
          content: {parts: [{text: 'Response from model'}]},
        };
      }),
    })),
    InMemoryArtifactService: vi.fn(),
    InMemorySessionService: vi.fn().mockImplementation(() => ({
      createSession: vi.fn().mockResolvedValue({
        id: 'session-123',
        appName: 'test-agent',
        userId: 'test_user',
        events: [],
      }),
      appendEvent: vi.fn(),
      getSession: vi.fn().mockResolvedValue({
        id: 'session-123',
        appName: 'test-agent',
        userId: 'test_user',
        events: [],
      }),
    })),
    InMemoryMemoryService: vi.fn(),
  };
});

vi.mock('node:readline', () => ({
  createInterface: vi.fn(),
}));

describe('cli_run', () => {
  let mockAgentFile: any;
  let mockRootAgent: any;
  let mockRl: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    mockRootAgent = {
      name: 'test-agent',
    };

    mockAgentFile = {
      load: vi.fn().mockResolvedValue(mockRootAgent),
      [Symbol.asyncDispose]: vi.fn(),
    };

    (AgentFile as unknown as Mock).mockImplementation(() => mockAgentFile);

    mockRl = {
      question: vi.fn((prompt, cb) => cb('exit')), // Default to exit immediately
      close: vi.fn(),
    };
    (readline.createInterface as Mock).mockReturnValue(mockRl);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should run interactively by default', async () => {
    await runAgent({agentPath: 'agent.ts'});

    expect(AgentFile).toHaveBeenCalledWith(
      expect.stringContaining('agent.ts'),
      undefined,
    );
    expect(mockAgentFile.load).toHaveBeenCalled();
    expect(readline.createInterface).toHaveBeenCalled();
    expect(mockRl.question).toHaveBeenCalled();
  });

  const createMockSessionService = () => ({
    createSession: vi.fn().mockResolvedValue({
      id: 'session-123',
      appName: 'test-agent',
      userId: 'test_user',
      events: [],
    }),
    appendEvent: vi.fn(),
    getSession: vi.fn().mockResolvedValue({
      id: 'session-123',
      appName: 'test-agent',
      userId: 'test_user',
      events: [],
    }),
  });

  it('should run from input file', async () => {
    const inputFileContent = {
      state: {foo: 'bar'},
      queries: ['Hello', 'How are you?'],
    };
    (loadFileData as Mock).mockResolvedValue(inputFileContent);
    const mockSessionService = createMockSessionService();

    await runAgent({
      agentPath: 'agent.ts',
      inputFile: 'input.json',
      sessionService: mockSessionService as any,
    });

    expect(loadFileData).toHaveBeenCalledWith(
      expect.stringContaining('input.json'),
    );
    expect(mockSessionService.createSession).toHaveBeenCalled();
  });

  it('should handle missing input file', async () => {
    (loadFileData as Mock).mockResolvedValue(null);
    const mockSessionService = createMockSessionService();

    await runAgent({
      agentPath: 'agent.ts',
      inputFile: 'input.json',
      sessionService: mockSessionService as any,
    });
    expect(loadFileData).toHaveBeenCalled();
  });

  it('should run from saved session', async () => {
    const sessionContent = {
      id: 'old-session',
      appName: 'test-agent',
      userId: 'test_user',
      events: [
        {author: 'user', content: {parts: [{text: 'Hi'}]}},
        {author: 'model', content: {parts: [{text: 'Hello'}]}},
      ],
    };
    (loadFileData as Mock).mockResolvedValue(sessionContent);
    const mockSessionService = createMockSessionService();

    await runAgent({
      agentPath: 'agent.ts',
      savedSessionFile: 'session.json',
      sessionService: mockSessionService as any,
    });

    expect(loadFileData).toHaveBeenCalledWith('session.json');
    expect(readline.createInterface).toHaveBeenCalled();
  });

  it('should save session when requested', async () => {
    const mockSessionService = createMockSessionService();
    // Run interactively then exit
    await runAgent({
      agentPath: 'agent.ts',
      saveSession: true,
      sessionId: 'my-session',
      sessionService: mockSessionService as any,
    });

    expect(saveToFile).toHaveBeenCalledWith(
      expect.stringContaining('my-session.session.json'),
      expect.anything(),
    );
  });

  it('should prompt for session id if not provided when saving', async () => {
    mockRl.question
      .mockImplementationOnce((prompt: string, cb: any) => cb('exit')) // For the runInteractively loop
      .mockImplementationOnce((prompt: string, cb: any) =>
        cb('prompted-session-id'),
      ); // For saveSession
    const mockSessionService = createMockSessionService();

    await runAgent({
      agentPath: 'agent.ts',
      saveSession: true,
      sessionService: mockSessionService as any,
    });

    expect(saveToFile).toHaveBeenCalledWith(
      expect.stringContaining('prompted-session-id.session.json'),
      expect.anything(),
    );
  });
});
