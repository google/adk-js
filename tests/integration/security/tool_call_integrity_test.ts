/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Red team: `ToolCallIntegrityPlugin` prevents session-store tampering.
 *
 * Threat model: an attacker with write access to the session store rewrites a
 * pending human-in-the-loop tool call between the moment the human reviews it
 * and the moment the agent executes it.
 *
 *  1. No plugin: the attacker tampers the amount 10 -> 10000 and the tool
 *     executes with the tampered amount.
 *  2. HMAC plugin: the same tamper is detected and the run is rejected.
 *  3. Key rotation, tampered: minted with the old key, validated with
 *     [new, old], and the tamper is still detected.
 *  4. Key rotation, clean: the same setup without tampering executes the
 *     approved call.
 *
 * This mirrors adk-python's `redteam_tool_call_integrity` script, with a
 * scripted model in place of a live Gemini call so the model's tool call is
 * exact and the test is hermetic.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BasePlugin,
  Event,
  FunctionTool,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  Runner,
  Session,
  ToolCallIntegrityError,
  ToolCallIntegrityPlugin,
} from '@google/adk';
import {Content, createUserContent, FunctionCall} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v3';

const APP = 'redteam';
const USER = 'attacker';
const TAMPERED_AMOUNT = 10000;

/** A model that replays a fixed script, so a turn's tool calls are exact. */
class ScriptedLlm extends BaseLlm {
  private index = 0;

  constructor(private readonly script: LlmResponse[]) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield this.script[this.index++] ?? {
      content: {role: 'model', parts: [{text: 'Done.'}]},
    };
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connections are not used in this test.');
  }
}

interface Transfer {
  amount: number;
  recipient: string;
}

/** A bank-teller agent whose only tool moves money and requires approval. */
function createBankAgent(): {agent: LlmAgent; transfers: Transfer[]} {
  const transfers: Transfer[] = [];
  const transferMoney = new FunctionTool({
    name: 'transfer_money',
    description: "Transfer money to a recipient's account.",
    parameters: z.object({amount: z.number(), recipient: z.string()}),
    requireConfirmation: true,
    execute: (input) => {
      transfers.push(input);
      return `Transferred $${input.amount} to ${input.recipient}`;
    },
  });

  const agent = new LlmAgent({
    name: 'bank_agent',
    model: new ScriptedLlm([
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'transfer_money',
                args: {amount: 10, recipient: 'Alice'},
              },
            },
          ],
        },
      },
    ]),
    instruction:
      'You are a bank teller. When the user asks you to transfer money, ' +
      'call the transfer_money tool with the exact amount and recipient.',
    tools: [transferMoney],
  });

  return {agent, transfers};
}

function functionCalls(event: Event): FunctionCall[] {
  return (event.content?.parts ?? [])
    .map((part) => part.functionCall)
    .filter((fc): fc is FunctionCall => fc !== undefined);
}

function findConfirmationCall(events: Event[]): FunctionCall | undefined {
  return events
    .flatMap(functionCalls)
    .find((fc) => fc.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME);
}

/**
 * Rewrites every stored `transfer_money` amount to {@link TAMPERED_AMOUNT},
 * reaching past the service API into the store the way an attacker would.
 */
function tamperSession(
  sessionService: InMemorySessionService,
  sessionId: string,
): void {
  const store = (
    sessionService as unknown as {
      sessions: Record<string, Record<string, Record<string, Session>>>;
    }
  ).sessions;
  for (const event of store[APP][USER][sessionId].events) {
    for (const fc of functionCalls(event)) {
      if (fc.name === 'transfer_money') {
        fc.args!['amount'] = TAMPERED_AMOUNT;
      } else if (fc.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
        const original = fc.args?.['originalFunctionCall'] as
          FunctionCall | undefined;
        if (original?.args) {
          original.args['amount'] = TAMPERED_AMOUNT;
        }
      }
    }
  }
}

function approval(confirmationCall: FunctionCall): Content {
  return {
    role: 'user',
    parts: [
      {
        functionResponse: {
          name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
          id: confirmationCall.id,
          response: {confirmed: true},
        },
      },
    ],
  };
}

async function collect(
  runner: Runner,
  sessionId: string,
  newMessage: Content,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: USER,
    sessionId,
    newMessage,
  })) {
    events.push(event);
  }
  return events;
}

interface CaseResult {
  transfers: Transfer[];
  error?: Error;
}

/**
 * Requests a transfer under `mintPlugin`, optionally tampers the store, then
 * approves it under `validatePlugin` (defaulting to `mintPlugin`) on a fresh
 * runner that shares the session store.
 */
async function runCase({
  mintPlugin,
  validatePlugin = mintPlugin,
  tamper = true,
}: {
  mintPlugin?: BasePlugin;
  validatePlugin?: BasePlugin;
  tamper?: boolean;
}): Promise<CaseResult> {
  const sessionService = new InMemorySessionService();
  const {agent, transfers} = createBankAgent();
  const session = await sessionService.createSession({
    appName: APP,
    userId: USER,
  });

  const mintRunner = new Runner({
    appName: APP,
    agent,
    sessionService,
    plugins: mintPlugin ? [mintPlugin] : [],
  });
  const opened = await collect(
    mintRunner,
    session.id,
    createUserContent('Transfer $10 to Alice'),
  );
  const confirmationCall = findConfirmationCall(opened);
  expect(confirmationCall, 'expected a confirmation request').toBeDefined();
  expect(transfers).toEqual([]);

  if (tamper) {
    tamperSession(sessionService, session.id);
  }

  const validateRunner = new Runner({
    appName: APP,
    agent,
    sessionService,
    plugins: validatePlugin ? [validatePlugin] : [],
  });
  try {
    await collect(validateRunner, session.id, approval(confirmationCall!));
    return {transfers};
  } catch (e) {
    return {transfers, error: e as Error};
  }
}

describe('ToolCallIntegrityPlugin', () => {
  it('case 1: without the plugin, the tampered call executes', async () => {
    const {transfers, error} = await runCase({});

    expect(error).toBeUndefined();
    expect(transfers).toEqual([{amount: TAMPERED_AMOUNT, recipient: 'Alice'}]);
  });

  it('case 2: with the plugin, tampering is detected', async () => {
    const {transfers, error} = await runCase({
      mintPlugin: new ToolCallIntegrityPlugin({secretKey: 'redteam-secret'}),
    });

    expect(error?.cause).toBeInstanceOf(ToolCallIntegrityError);
    expect((error?.cause as Error).message).toMatch(/HMAC mismatch/);
    expect(transfers).toEqual([]);
  });

  it('case 3: after key rotation, tampering is still detected', async () => {
    const {transfers, error} = await runCase({
      mintPlugin: new ToolCallIntegrityPlugin({secretKey: 'old-key'}),
      validatePlugin: new ToolCallIntegrityPlugin({
        secretKey: ['new-key', 'old-key'],
      }),
      tamper: true,
    });

    expect(error?.cause).toBeInstanceOf(ToolCallIntegrityError);
    expect(transfers).toEqual([]);
  });

  it('case 4: after key rotation, the untampered call executes', async () => {
    const {transfers, error} = await runCase({
      mintPlugin: new ToolCallIntegrityPlugin({secretKey: 'old-key'}),
      validatePlugin: new ToolCallIntegrityPlugin({
        secretKey: ['new-key', 'old-key'],
      }),
      tamper: false,
    });

    expect(error).toBeUndefined();
    expect(transfers).toEqual([{amount: 10, recipient: 'Alice'}]);
  });
});
