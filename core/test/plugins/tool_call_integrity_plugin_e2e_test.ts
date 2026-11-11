/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end tests for ToolCallIntegrityPlugin, through Runner.runAsync with a
 * scripted model and a real confirmation flow.
 */

import {
  AgentTool,
  App,
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  createEvent,
  Event,
  FunctionTool,
  getFunctionCalls,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  markRestored,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  RESTORED_EVENT_KEY,
  Runner,
  Session,
  START,
  StreamingMode,
  ToolCallIntegrityError,
  ToolCallIntegrityPlugin,
  Workflow,
} from '@google/adk';
import {Content, FunctionCall} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v3';
import {TOOL_CALL_HMAC_METADATA_KEY as HMAC_KEY} from '../../src/plugins/tool_call_integrity_plugin.js';

const KEY = new TextEncoder().encode('test-secret-key');
const APP = 'app';
const USER = 'user';
const AGENT = 'bank_agent';
const CONFIRM = REQUEST_CONFIRMATION_FUNCTION_CALL_NAME;

/** Returns canned responses in order, then a plain text reply. */
class ScriptedLlm extends BaseLlm {
  private index = 0;

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'scripted'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield this.responses[this.index++] ?? textResponse('Done.');
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connections are not used in this test.');
  }
}

interface Transfer {
  amount: number;
  recipient: string;
}

function transferTool(transfers: Transfer[], requireConfirmation = false) {
  return new FunctionTool({
    name: 'transfer_money',
    description: 'Transfers money.',
    parameters: z.object({amount: z.number(), recipient: z.string()}),
    requireConfirmation,
    execute: (input) => {
      transfers.push(input);
      return {status: 'done'};
    },
  });
}

function transferResponse(
  amount = 2,
  recipient = 'bob',
  id?: string,
): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: [
        {functionCall: {id, name: 'transfer_money', args: {amount, recipient}}},
      ],
    },
  };
}

function textResponse(text = 'ok'): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}};
}

function userMessage(text = 'hi'): Content {
  return {role: 'user', parts: [{text}]};
}

function plugin(allowUnstampedCalls = false): ToolCallIntegrityPlugin {
  return new ToolCallIntegrityPlugin({secretKey: KEY, allowUnstampedCalls});
}

function makeRunner(
  agent: LlmAgent | BaseAgent | Workflow,
  integrity: ToolCallIntegrityPlugin | undefined = plugin(),
): {runner: Runner; sessionService: InMemorySessionService} {
  const sessionService = new InMemorySessionService();
  const runner = new Runner({
    app: new App({
      name: APP,
      rootAgent: agent,
      plugins: integrity ? [integrity] : [],
    }),
    sessionService,
  });
  return {runner, sessionService};
}

function bankRunner({
  transfers,
  responses,
  requireConfirmation = false,
  integrity,
}: {
  transfers: Transfer[];
  responses: LlmResponse[];
  requireConfirmation?: boolean;
  integrity?: ToolCallIntegrityPlugin;
}) {
  return makeRunner(
    new LlmAgent({
      name: AGENT,
      model: new ScriptedLlm(responses),
      tools: [transferTool(transfers, requireConfirmation)],
    }),
    integrity,
  );
}

async function run(
  runner: Runner,
  sessionId: string,
  newMessage: Content,
  streamingMode?: StreamingMode,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: USER,
    sessionId,
    newMessage,
    runConfig: streamingMode ? {streamingMode} : undefined,
  })) {
    events.push(event);
  }
  return events;
}

/** The events as stored, reached past the service API as an attacker would. */
function storedEvents(
  sessionService: InMemorySessionService,
  sessionId: string,
): Event[] {
  const store = (
    sessionService as unknown as {
      sessions: Record<string, Record<string, Record<string, Session>>>;
    }
  ).sessions;
  return store[APP][USER][sessionId].events;
}

async function newSession(sessionService: InMemorySessionService) {
  return sessionService.createSession({appName: APP, userId: USER});
}

/** Runs until the agent asks for approval; returns the session and call IDs. */
async function requestConfirmation(
  runner: Runner,
  sessionService: InMemorySessionService,
): Promise<{sessionId: string; callId: string}> {
  const session = await newSession(sessionService);
  const events = await run(runner, session.id, userMessage('Pay alice 10'));
  const confirmations = events
    .flatMap((e) => getFunctionCalls(e))
    .filter((fc) => fc.name === CONFIRM);
  expect(confirmations).toHaveLength(1);
  return {sessionId: session.id, callId: confirmations[0].id!};
}

function approval(callId: string): Content {
  return {
    role: 'user',
    parts: [
      {
        functionResponse: {
          id: callId,
          name: CONFIRM,
          response: {confirmed: true},
        },
      },
    ],
  };
}

/** PluginManager wraps plugin errors; checks the wrapped one is ours. */
async function expectRejectedByPlugin(
  promise: Promise<unknown>,
  callback: string,
  match: string,
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).toContain(
    `'tool_call_integrity' during '${callback}'`,
  );
  expect(error!.cause).toBeInstanceOf(ToolCallIntegrityError);
  expect((error!.cause as Error).message).toContain(match);
}

function setRestoredMarker(event: Event): void {
  event.customMetadata = {
    ...(event.customMetadata ?? {}),
    [RESTORED_EVENT_KEY]: true,
  };
}

function transferEvent(
  id: string | undefined,
  invocationId = 'old-inv',
): Event {
  return createEvent({
    invocationId,
    author: AGENT,
    content: {
      role: 'model',
      parts: [
        {
          functionCall: {
            id,
            name: 'transfer_money',
            args: {amount: 1, recipient: 'alice'},
          },
        },
      ],
    },
  });
}

function transferResultEvent(id: string | undefined): Event {
  return createEvent({
    invocationId: 'old-inv',
    author: AGENT,
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id,
            name: 'transfer_money',
            response: {ok: true},
          },
        },
      ],
    },
  });
}

describe('ToolCallIntegrityPlugin end to end', () => {
  describe('confirmation flow', () => {
    const confirmationResponses = () => [
      transferResponse(10, 'alice'),
      textResponse('Sent.'),
    ];

    it('runs an untouched approved call', async () => {
      const transfers: Transfer[] = [];
      const {runner, sessionService} = bankRunner({
        transfers,
        responses: confirmationResponses(),
        requireConfirmation: true,
      });
      const {sessionId, callId} = await requestConfirmation(
        runner,
        sessionService,
      );

      await run(runner, sessionId, approval(callId));

      expect(transfers).toEqual([{amount: 10, recipient: 'alice'}]);
    });

    it('blocks a call rewritten everywhere it is stored', async () => {
      const transfers: Transfer[] = [];
      const {runner, sessionService} = bankRunner({
        transfers,
        responses: confirmationResponses(),
        requireConfirmation: true,
      });
      const {sessionId, callId} = await requestConfirmation(
        runner,
        sessionService,
      );

      // Rewrite the amount everywhere it is stored, so ADK's own check that
      // the confirmation matches the original call still passes.
      for (const event of storedEvents(sessionService, sessionId)) {
        for (const fc of getFunctionCalls(event)) {
          if (fc.name === 'transfer_money') {
            fc.args!['amount'] = 10000;
          } else if (fc.name === CONFIRM) {
            const original = fc.args!['originalFunctionCall'] as FunctionCall;
            original.args!['amount'] = 10000;
          }
        }
      }

      await expectRejectedByPlugin(
        run(runner, sessionId, approval(callId)),
        'beforeRunCallback',
        'does not match',
      );
      expect(transfers).toEqual([]);
    });

    it('blocks a rewritten original call, not only the confirmation', async () => {
      const transfers: Transfer[] = [];
      const {runner, sessionService} = bankRunner({
        transfers,
        responses: confirmationResponses(),
        requireConfirmation: true,
      });
      const {sessionId, callId} = await requestConfirmation(
        runner,
        sessionService,
      );

      for (const event of storedEvents(sessionService, sessionId)) {
        for (const fc of getFunctionCalls(event)) {
          if (fc.name === 'transfer_money') {
            fc.args!['recipient'] = 'mallory';
          }
        }
      }

      await expectRejectedByPlugin(
        run(runner, sessionId, approval(callId)),
        'beforeRunCallback',
        'does not match',
      );
      expect(transfers).toEqual([]);
    });

    it('blocks a session whose stamps were stripped', async () => {
      const transfers: Transfer[] = [];
      const {runner, sessionService} = bankRunner({
        transfers,
        responses: confirmationResponses(),
        requireConfirmation: true,
      });
      const {sessionId, callId} = await requestConfirmation(
        runner,
        sessionService,
      );

      for (const event of storedEvents(sessionService, sessionId)) {
        delete event.customMetadata?.[HMAC_KEY];
      }

      await expectRejectedByPlugin(
        run(runner, sessionId, approval(callId)),
        'beforeRunCallback',
        'no integrity stamp',
      );
      expect(transfers).toEqual([]);
    });

    it('blocks an approved call marked restored at execution', async () => {
      const transfers: Transfer[] = [];
      const {runner, sessionService} = bankRunner({
        transfers,
        responses: confirmationResponses(),
        requireConfirmation: true,
      });
      const {sessionId, callId} = await requestConfirmation(
        runner,
        sessionService,
      );

      for (const event of storedEvents(sessionService, sessionId)) {
        if (
          getFunctionCalls(event).some((fc) => fc.name === 'transfer_money')
        ) {
          setRestoredMarker(event);
        }
      }

      await expectRejectedByPlugin(
        run(runner, sessionId, approval(callId)),
        'beforeToolCallback',
        'restored',
      );
      expect(transfers).toEqual([]);
    });
  });

  describe('restored history', () => {
    describe.each([false, true])(
      'allowUnstampedCalls=%s',
      (allowUnstampedCalls) => {
        it.each([
          ['with an ID', 'r-1'],
          ['without an ID', undefined],
        ])('keeps working with restored tool calls %s', async (_label, id) => {
          const transfers: Transfer[] = [];
          const {runner, sessionService} = bankRunner({
            transfers,
            responses: [textResponse(), textResponse()],
            integrity: plugin(allowUnstampedCalls),
          });
          const session = await newSession(sessionService);
          for (const event of [transferEvent(id), transferResultEvent(id)]) {
            await sessionService.appendEvent({
              session,
              event: markRestored(event),
            });
          }

          await run(runner, session.id, userMessage());
          await run(runner, session.id, userMessage('again'));

          expect(transfers).toEqual([]);
        });
      },
    );

    it.each([false, true])(
      'keeps history copied in code only when prepared (prepare=%s)',
      async (prepare) => {
        const transfers: Transfer[] = [];
        const {runner, sessionService} = bankRunner({
          transfers,
          responses: [transferResponse(), textResponse('done'), textResponse()],
        });
        const source = await newSession(sessionService);
        await run(runner, source.id, userMessage('pay bob'));
        expect(transfers).toHaveLength(1);
        const target = await newSession(sessionService);
        for (const event of storedEvents(sessionService, source.id)) {
          await sessionService.appendEvent({
            session: target,
            event: prepare
              ? ToolCallIntegrityPlugin.prepareRestoredEvent(event)
              : createEvent(structuredClone(event)),
          });
        }

        if (!prepare) {
          // The copied stamps are bound to the source session.
          await expectRejectedByPlugin(
            run(runner, target.id, userMessage()),
            'beforeRunCallback',
            'does not match',
          );
          return;
        }
        await run(runner, target.id, userMessage());
        expect(transfers).toHaveLength(1);
      },
    );

    it('runs a new call after a restore', async () => {
      const transfers: Transfer[] = [];
      const {runner, sessionService} = bankRunner({
        transfers,
        responses: [transferResponse(), textResponse('done')],
      });
      const session = await newSession(sessionService);
      await sessionService.appendEvent({
        session,
        event: markRestored(transferEvent('r-1')),
      });

      await run(runner, session.id, userMessage('pay bob'));

      expect(transfers).toEqual([{amount: 2, recipient: 'bob'}]);
    });

    it('lets a model that reuses call IDs across turns call tools', async () => {
      const transfers: Transfer[] = [];
      const {runner, sessionService} = bankRunner({
        transfers,
        responses: [transferResponse(2, 'bob', '0'), textResponse('done')],
      });
      const session = await newSession(sessionService);
      await sessionService.appendEvent({
        session,
        event: markRestored(transferEvent('0')),
      });

      await run(runner, session.id, userMessage('pay bob'));

      expect(transfers).toEqual([{amount: 2, recipient: 'bob'}]);
    });
  });

  it('keeps a session usable when a custom agent emits a call without an ID', async () => {
    class CallWithoutIdAgent extends BaseAgent {
      protected override async *runAsyncImpl(
        context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          content: {
            role: 'model',
            parts: [{functionCall: {name: 'lookup', args: {q: 'x'}}}],
          },
        });
      }

      protected override async *runLiveImpl(): AsyncGenerator<
        Event,
        void,
        void
      > {}
    }
    const {runner, sessionService} = makeRunner(
      new CallWithoutIdAgent({name: 'custom_agent'}),
    );
    const session = await newSession(sessionService);

    await run(runner, session.id, userMessage('first'));
    await run(runner, session.id, userMessage('second'));

    const withCalls = storedEvents(sessionService, session.id).filter(
      (e) => getFunctionCalls(e).length > 0,
    );
    expect(withCalls).toHaveLength(2);
  });

  describe.each([StreamingMode.NONE, StreamingMode.SSE])(
    'streaming mode %s',
    (mode) => {
      it.each([false, true])(
        'refuses a response repeating a call ID and keeps the session usable (allowUnstampedCalls=%s)',
        async (allowUnstampedCalls) => {
          const duplicate: LlmResponse = {
            content: {
              role: 'model',
              parts: [
                transferResponse(2).content!.parts![0],
                transferResponse(999).content!.parts![0],
              ].map((part) => ({
                functionCall: {...part.functionCall!, id: 'dup'},
              })),
            },
          };
          const transfers: Transfer[] = [];
          const {runner, sessionService} = bankRunner({
            transfers,
            responses: [duplicate, transferResponse(3), textResponse('done')],
            integrity: plugin(allowUnstampedCalls),
          });
          const session = await newSession(sessionService);

          await expectRejectedByPlugin(
            run(runner, session.id, userMessage('pay bob'), mode),
            'onEventCallback',
            'repeats function call',
          );
          expect(transfers).toEqual([]);
          expect(
            storedEvents(sessionService, session.id).some(
              (e) => getFunctionCalls(e).length > 0,
            ),
          ).toBe(false);

          await run(runner, session.id, userMessage('pay bob 3'), mode);

          expect(transfers).toEqual([{amount: 3, recipient: 'bob'}]);
        },
      );

      // Fresh calls get an ID before any tool runs, so they pass the gate.
      it('runs a fresh call', async () => {
        const transfers: Transfer[] = [];
        const {runner, sessionService} = bankRunner({
          transfers,
          responses: [transferResponse(), textResponse('done')],
        });
        const session = await newSession(sessionService);

        await run(runner, session.id, userMessage('pay bob'), mode);

        expect(transfers).toEqual([{amount: 2, recipient: 'bob'}]);
      });
    },
  );

  // Needs google/adk-js#978: until then a workflow node runs its tools before
  // the runner has stamped and stored the function-call event, so the gate
  // rejects the call. Re-enable once #978 lands.
  it.skip('runs a fresh call in a workflow node', async () => {
    const transfers: Transfer[] = [];
    const agent = new LlmAgent({
      name: AGENT,
      model: new ScriptedLlm([transferResponse(), textResponse('done')]),
      tools: [transferTool(transfers)],
    });
    const {runner, sessionService} = makeRunner(
      new Workflow({name: 'wf', edges: [[START, agent]]}),
    );
    const session = await newSession(sessionService);

    await run(runner, session.id, userMessage('pay bob'));

    expect(transfers).toEqual([{amount: 2, recipient: 'bob'}]);
  });

  it('runs a fresh call through an AgentTool', async () => {
    const transfers: Transfer[] = [];
    const inner = new LlmAgent({
      name: 'inner_agent',
      description: 'Moves money.',
      model: new ScriptedLlm([transferResponse(), textResponse('moved')]),
      tools: [transferTool(transfers)],
    });
    const outer = new LlmAgent({
      name: 'outer_agent',
      model: new ScriptedLlm([
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'inner_agent',
                  args: {request: 'pay bob'},
                },
              },
            ],
          },
        },
        textResponse('done'),
      ]),
      tools: [new AgentTool({agent: inner})],
    });
    const {runner, sessionService} = makeRunner(outer);
    const session = await newSession(sessionService);

    await run(runner, session.id, userMessage('pay bob'));

    expect(transfers).toEqual([{amount: 2, recipient: 'bob'}]);
  });
});
