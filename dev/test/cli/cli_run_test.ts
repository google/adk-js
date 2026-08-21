/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, BaseSessionService, Runner} from '@google/adk';
import * as path from 'node:path';
import * as readline from 'node:readline';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {runAgent} from '../../src/cli/cli_run.js';
import {AgentFile} from '../../src/utils/agent_loader.js';
import {loadFileData, saveToFile} from '../../src/utils/file_utils.js';

vi.mock('../../src/utils/agent_loader.js', () => ({
  AgentFile: vi.fn(),
}));

// Only the I/O is faked; getAbsolutePath is the real resolver under test.
vi.mock('../../src/utils/file_utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/file_utils.js')>()),
  loadFileData: vi.fn(),
  saveToFile: vi.fn(),
}));

/** Events the mocked Runner yields for a turn; set per test. */
const runnerState = vi.hoisted(() => ({
  events: [
    {author: 'model', content: {parts: [{text: 'Response from model'}]}},
  ] as unknown[],
}));

// Only the Runner and services are faked, so interrupt detection under test is
// the real `getUserInputRequests` rather than a stand-in.
vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/adk')>();
  return {
    ...actual,
    Runner: vi.fn().mockImplementation(() => ({
      runAsync: vi.fn().mockImplementation(async function* () {
        for (const event of runnerState.events) {
          yield event;
        }
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
    isApp: vi.fn().mockReturnValue(false),
  };
});

vi.mock('node:readline', () => ({
  createInterface: vi.fn(),
}));

describe('cli_run', () => {
  let mockAgentFile: AgentFile;
  let mockRootAgent: BaseAgent;
  let mockRl: readline.Interface;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    runnerState.events = [
      {author: 'model', content: {parts: [{text: 'Response from model'}]}},
    ];

    // `restoreAllMocks` in afterEach strips the implementation set in the
    // module factory, so re-establish it for every test.
    (Runner as unknown as Mock).mockImplementation(() => ({
      runAsync: async function* () {
        for (const event of runnerState.events) {
          yield event;
        }
      },
    }));

    mockRootAgent = {
      name: 'test-agent',
    } as unknown as BaseAgent;

    mockAgentFile = {
      load: vi.fn().mockResolvedValue(mockRootAgent),
      [Symbol.asyncDispose]: vi.fn(),
    } as unknown as AgentFile;

    (AgentFile as unknown as Mock).mockImplementation(() => mockAgentFile);

    mockRl = {
      question: vi.fn((query: string, cb: (answer: string) => void) => {
        cb('exit');
      }),
      close: vi.fn(),
    } as unknown as readline.Interface;
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

  const createMockSessionService = () =>
    ({
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
    }) as unknown as BaseSessionService;

  it('keeps the REPL alive when a turn fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let turn = 0;
    (Runner as unknown as Mock).mockImplementation(() => ({
      runAsync: async function* () {
        turn++;
        if (turn === 1) {
          throw new Error('Context variable not found: `my_city`.');
        }
        yield {author: 'model', content: {parts: [{text: 'recovered'}]}};
      },
    }));
    (mockRl.question as Mock)
      .mockImplementationOnce((_p: string, cb: (a: string) => void) =>
        cb('boom'),
      )
      .mockImplementationOnce((_p: string, cb: (a: string) => void) => cb('go'))
      .mockImplementationOnce((_p: string, cb: (a: string) => void) =>
        cb('exit'),
      );

    await runAgent({
      agentPath: 'agent.ts',
      sessionService: createMockSessionService(),
    });

    expect(
      errors.mock.calls.map((call) => call.join(' ')).join('\n'),
    ).toContain('Context variable not found');
    expect(turn).toBe(2);
    expect(
      (console.log as Mock).mock.calls.map((call) => call.join(' ')).join('\n'),
    ).toContain('recovered');
    // Surviving the turn must not cost the cleanup: stdin is still released
    // when the loop finally ends.
    expect(mockRl.close as Mock).toHaveBeenCalledTimes(1);
  });

  it('reuses one readline interface across prompts', async () => {
    (mockRl.question as Mock)
      .mockImplementationOnce((_p: string, cb: (a: string) => void) =>
        cb('hello'),
      )
      .mockImplementationOnce((_p: string, cb: (a: string) => void) => cb('21'))
      .mockImplementationOnce((_p: string, cb: (a: string) => void) =>
        cb('exit'),
      );

    await runAgent({
      agentPath: 'agent.ts',
      sessionService: createMockSessionService(),
    });

    expect(readline.createInterface as Mock).toHaveBeenCalledTimes(1);
    expect(mockRl.question as Mock).toHaveBeenCalledTimes(3);
    expect(mockRl.close as Mock).toHaveBeenCalledTimes(1);
  });

  it('closes the readline interface when a failure escapes the loop', async () => {
    (mockRl.question as Mock).mockImplementation(
      (_p: string, cb: (a: string) => void) => cb('exit'),
    );
    // A failing turn no longer escapes — the REPL reports it and prompts again
    // — so the throw that still has to release stdin comes from the save step.
    (saveToFile as Mock).mockRejectedValue(new Error('save exploded'));

    await expect(
      runAgent({
        agentPath: 'agent.ts',
        saveSession: true,
        sessionId: 'session-123',
        sessionService: createMockSessionService(),
      }),
    ).rejects.toThrow('save exploded');

    expect(mockRl.close as Mock).toHaveBeenCalledTimes(1);
  });

  it('echoes the answer when stdin is not a terminal', async () => {
    const isTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });
    try {
      (mockRl.question as Mock)
        .mockImplementationOnce((_p: string, cb: (a: string) => void) =>
          cb('hi'),
        )
        .mockImplementationOnce((_p: string, cb: (a: string) => void) =>
          cb('exit'),
        );

      await runAgent({
        agentPath: 'agent.ts',
        sessionService: createMockSessionService(),
      });

      expect(
        (console.log as Mock).mock.calls.map((c) => c.join(' ')),
      ).toContain('hi');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: isTTY,
        configurable: true,
      });
    }
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
      sessionService: mockSessionService,
    });

    expect(loadFileData).toHaveBeenCalledWith(
      expect.stringContaining('input.json'),
    );
    expect(mockSessionService.createSession).toHaveBeenCalled();
  });

  it('honours an absolute --replay path instead of rebasing it on cwd', async () => {
    // `path.join(cwd, '/abs/input.json')` silently strips the leading
    // separator and looks for `<cwd>/abs/input.json`, which does not exist.
    const absolute = path.resolve(path.sep, 'tmp', 'replay', 'input.json');
    (loadFileData as Mock).mockResolvedValue({state: {}, queries: ['Hello']});

    await runAgent({
      agentPath: 'agent.ts',
      inputFile: absolute,
      sessionService: createMockSessionService(),
    });

    expect(loadFileData).toHaveBeenCalledWith(absolute);
  });

  it('honours an absolute agent path', async () => {
    const absolute = path.resolve(path.sep, 'tmp', 'agents', 'agent.ts');

    await runAgent({
      agentPath: absolute,
      sessionService: createMockSessionService(),
    });

    expect(AgentFile).toHaveBeenCalledWith(absolute, undefined);
  });

  it('resolves a relative path against the working directory', async () => {
    (loadFileData as Mock).mockResolvedValue({state: {}, queries: ['Hello']});

    await runAgent({
      agentPath: 'agent.ts',
      inputFile: 'input.json',
      sessionService: createMockSessionService(),
    });

    expect(loadFileData).toHaveBeenCalledWith(
      path.join(process.cwd(), 'input.json'),
    );
  });

  it('propagates an unreadable --replay file instead of swallowing it', async () => {
    (loadFileData as Mock).mockRejectedValue(
      new Error('Failed to read or parse file input.json: ENOENT'),
    );

    await expect(
      runAgent({
        agentPath: 'agent.ts',
        inputFile: 'input.json',
        sessionService: createMockSessionService(),
      }),
    ).rejects.toThrow(/Failed to read or parse file input\.json/);
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
      sessionService: mockSessionService,
    });

    expect(loadFileData).toHaveBeenCalledWith('session.json');
    expect(readline.createInterface).toHaveBeenCalled();
  });

  /** An `adk_request_input` interrupt, as a saved transcript records it. */
  const savedInterrupt = (interruptId: string) => ({
    author: 'step1',
    content: {
      parts: [
        {
          functionCall: {
            name: 'adk_request_input',
            id: interruptId,
            args: {interruptId, message: 'Enter a number:'},
          },
        },
      ],
    },
  });

  /** The user's reply to an interrupt, as a saved transcript records it. */
  const savedReply = (interruptId: string) => ({
    author: 'user',
    content: {
      parts: [
        {
          functionResponse: {
            id: interruptId,
            name: 'adk_request_input',
            response: {result: 21},
          },
        },
      ],
    },
  });

  async function replaySavedSession(events: unknown[]): Promise<string> {
    (loadFileData as Mock).mockResolvedValue({
      id: 'old-session',
      appName: 'test-agent',
      userId: 'test_user',
      events,
    });

    await runAgent({
      agentPath: 'agent.ts',
      savedSessionFile: 'session.json',
      sessionService: createMockSessionService(),
    });

    return (console.log as Mock).mock.calls
      .map((call) => call.join(' '))
      .join('\n');
  }

  it('does not re-announce a pause the saved session already answered', async () => {
    const output = await replaySavedSession([
      {author: 'user', content: {parts: [{text: 'start'}]}},
      savedInterrupt('interrupt-1'),
      savedReply('interrupt-1'),
      {author: 'step2', content: {parts: [{text: '42'}]}},
    ]);

    expect(output).toContain('[user]: start');
    expect(output).toContain('[step2]: 42');
    expect(output).not.toContain('is waiting');
  });

  it('announces a pause the saved session left unanswered', async () => {
    const output = await replaySavedSession([
      {author: 'user', content: {parts: [{text: 'start'}]}},
      savedInterrupt('interrupt-1'),
      savedReply('interrupt-1'),
      savedInterrupt('interrupt-2'),
    ]);

    const announcements = output.match(/is waiting for your input/g) ?? [];
    expect(announcements).toHaveLength(1);
    expect(output).toContain('Enter a number:');
  });

  it('should save session when requested', async () => {
    const mockSessionService = createMockSessionService();
    // Run interactively then exit
    await runAgent({
      agentPath: 'agent.ts',
      saveSession: true,
      sessionId: 'my-session',
      sessionService: mockSessionService,
    });

    expect(saveToFile).toHaveBeenCalledWith(
      expect.stringContaining('my-session.session.json'),
      expect.anything(),
    );
  });

  it('saves the session beside the agent file, not inside it', async () => {
    // Joining onto the agent path itself produced
    // `<cwd>/agents/agent.ts/my-session.session.json`; saveToFile does no
    // mkdir and agent.ts is a file, so the write failed with ENOTDIR.
    await runAgent({
      agentPath: path.join('agents', 'agent.ts'),
      saveSession: true,
      sessionId: 'my-session',
      sessionService: createMockSessionService(),
    });

    expect(saveToFile).toHaveBeenCalledWith(
      path.join(process.cwd(), 'agents', 'my-session.session.json'),
      expect.anything(),
    );
  });

  it('should prompt for session id if not provided when saving', async () => {
    (mockRl.question as Mock)
      .mockImplementationOnce((prompt: string, cb: (answer: string) => void) =>
        cb('exit'),
      ) // For the runInteractively loop
      .mockImplementationOnce((prompt: string, cb: (answer: string) => void) =>
        cb('prompted-session-id'),
      ); // For saveSession
    const mockSessionService = createMockSessionService();

    await runAgent({
      agentPath: 'agent.ts',
      saveSession: true,
      sessionService: mockSessionService,
    });

    expect(saveToFile).toHaveBeenCalledWith(
      expect.stringContaining('prompted-session-id.session.json'),
      expect.anything(),
    );
  });

  /**
   * An interrupt has no `text` part, so without explicit rendering the REPL
   * prints nothing and the user never learns a reply is expected.
   */
  describe('interrupt rendering', () => {
    /** Drives one interactive turn, then exits, and returns what was printed. */
    async function runOneTurn(event: unknown): Promise<string> {
      runnerState.events = [event];
      (mockRl.question as Mock)
        .mockImplementationOnce((_p: string, cb: (a: string) => void) =>
          cb('hello'),
        )
        .mockImplementationOnce((_p: string, cb: (a: string) => void) =>
          cb('exit'),
        );

      await runAgent({
        agentPath: 'agent.ts',
        sessionService: createMockSessionService(),
      });

      return (console.log as Mock).mock.calls
        .map((call) => call.join(' '))
        .join('\n');
    }

    it('renders a request-for-input pause with its message and schema', async () => {
      const output = await runOneTurn({
        author: 'step1',
        content: {
          parts: [
            {
              functionCall: {
                name: 'adk_request_input',
                id: 'interrupt-1',
                args: {
                  interruptId: 'interrupt-1',
                  message: 'Enter a number:',
                  payload: {draft: 'hi'},
                  response_schema: {type: 'object'},
                },
              },
            },
          ],
        },
      });

      expect(output).toContain('[step1] is waiting for your input');
      expect(output).toContain('Enter a number:');
      expect(output).toContain('Payload: {"draft":"hi"}');
      expect(output).toContain('Expected response: {"type":"object"}');
      expect(output).toContain('Type your reply at the next prompt');
    });

    it('renders a credential pause with its auth scheme', async () => {
      const output = await runOneTurn({
        author: 'fetch_weather',
        content: {
          parts: [
            {
              functionCall: {
                name: 'adk_request_credential',
                id: 'weather_api_key',
                args: {
                  message: 'Please provide your API key.',
                  authConfig: {
                    authScheme: {
                      type: 'apiKey',
                      in: 'header',
                      name: 'X-Api-Key',
                    },
                  },
                },
              },
            },
          ],
        },
      });

      expect(output).toContain('[fetch_weather] is waiting for a credential');
      expect(output).toContain('Please provide your API key.');
      expect(output).toContain('Auth scheme: apiKey (header X-Api-Key)');
    });

    it('renders a tool-confirmation pause with the tool name and hint', async () => {
      const output = await runOneTurn({
        author: 'generate_instruction',
        content: {
          parts: [
            {
              functionCall: {
                name: 'adk_request_confirmation',
                id: 'confirm-1',
                args: {
                  originalFunctionCall: {name: 'find_orders', args: {}},
                  toolConfirmation: {
                    hint: 'This reads patient records.',
                    confirmed: false,
                  },
                },
              },
            },
          ],
        },
      });

      expect(output).toContain(
        '[generate_instruction] is waiting for confirmation',
      );
      expect(output).toContain('Tool: find_orders');
      expect(output).toContain('This reads patient records.');
      expect(output).toContain("Reply 'yes' to approve or 'no' to reject.");
    });

    it('does not announce a pause for an ordinary function call', async () => {
      const output = await runOneTurn({
        author: 'agent',
        content: {
          parts: [
            {text: 'Looking that up.'},
            {functionCall: {name: 'get_weather', id: 'c1', args: {city: 'SF'}}},
          ],
        },
      });

      expect(output).toContain('[agent]: Looking that up.');
      expect(output).not.toContain('is waiting');
    });

    it('reports an error carried on the event', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await runOneTurn({
        author: 'draft_email',
        errorCode: 'SAFETY',
        errorMessage: 'Blocked by safety filters.',
      });

      const errors = (console.error as Mock).mock.calls
        .map((call) => call.join(' '))
        .join('\n');
      expect(errors).toContain(
        '[draft_email] error: SAFETY: Blocked by safety filters.',
      );
    });

    it('warns when a scripted run ends still waiting on the user', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      (loadFileData as Mock).mockResolvedValue({state: {}, queries: ['start']});
      runnerState.events = [savedInterrupt('interrupt-1')];

      await runAgent({
        agentPath: 'agent.ts',
        inputFile: 'input.json',
        sessionService: createMockSessionService(),
      });

      const errors = (console.error as Mock).mock.calls
        .map((call) => call.join(' '))
        .join('\n');
      expect(errors).toContain(
        'The run ended while still waiting for user input.',
      );
    });

    it('does not announce a pause for an unnamed function call', async () => {
      const output = await runOneTurn({
        author: 'agent',
        content: {parts: [{functionCall: {args: {}}}]},
      });

      expect(output).not.toContain('is waiting');
    });

    it('attributes a node whose response was empty', async () => {
      const output = await runOneTurn({
        author: 'city_generator_agent',
        content: {role: 'model', parts: [{text: ''}]},
        output: '',
      });

      expect(output).toContain('[city_generator_agent]: (empty response)');
    });

    it('stays quiet for an event that carries no output at all', async () => {
      const output = await runOneTurn({
        author: 'bookkeeping',
        content: {role: 'model', parts: []},
      });

      expect(output).not.toContain('[bookkeeping]');
    });

    it("prints an output-only event, the run's actual answer", async () => {
      const output = await runOneTurn({
        author: 'final_answer',
        output: '<<HELLO!>>',
      });

      expect(output).toContain('[final_answer]: <<HELLO!>>');
    });

    it('renders a structured output-only event as JSON', async () => {
      const output = await runOneTurn({
        author: 'lookup',
        output: {timeInfo: '10:10 AM', city: 'Paris'},
      });

      expect(output).toContain(
        '[lookup]: {"timeInfo":"10:10 AM","city":"Paris"}',
      );
    });

    it('does not print a node result twice when it fills content and output', async () => {
      const output = await runOneTurn({
        author: 'echo',
        content: {role: 'model', parts: [{text: 'HELLO'}]},
        output: 'HELLO',
      });

      expect(output.match(/\[echo\]: HELLO/g)).toHaveLength(1);
    });

    it('stays quiet for a partial (streaming) event', async () => {
      const output = await runOneTurn({
        author: 'streamer',
        output: 'partial value',
        partial: true,
      });

      expect(output).not.toContain('[streamer]');
    });
  });
});
