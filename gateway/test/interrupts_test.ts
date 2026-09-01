/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Agent,
  BaseLlm,
  FunctionTool,
  InMemorySessionService,
  type BaseLlmConnection,
  type LlmResponse,
} from '@google/adk';
import {
  actionsFor,
  ActionTokenStore,
  answerPart,
  createGateway,
  interruptsIn,
  promptFor,
  renderInterrupt,
} from '@google/adk-gateway';
import {
  memoryChannel,
  MINIMAL,
  TELEGRAM_LIKE,
} from '@google/adk-gateway/testing/index.js';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

/** An event shaped the way ADK raises a tool confirmation. */
function confirmationEvent(hint: string) {
  return {
    id: 'e1',
    invocationId: 'i1',
    author: 'agent',
    actions: {},
    timestamp: Date.now(),
    content: {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: 'interrupt-1',
            name: 'adk_request_confirmation',
            args: {
              originalFunctionCall: {
                id: 'call-1',
                name: 'delete_order',
                args: {orderId: '4711'},
              },
              toolConfirmation: {hint, confirmed: false},
            },
          },
        },
      ],
    },
  } as never;
}

/** The hint ADK writes when a tool does not supply its own. */
const ADK_DEFAULT_HINT =
  'Please approve or reject the tool call delete_order() by responding with ' +
  'a FunctionResponse with an expected ToolConfirmation payload.';

describe('interruptsIn', () => {
  it('finds the pending confirmation', () => {
    const [interrupt] = interruptsIn(confirmationEvent('Delete order 4711?'));

    expect(interrupt).toMatchObject({
      kind: 'confirmation',
      interruptId: 'interrupt-1',
      functionCallName: 'adk_request_confirmation',
      toolName: 'delete_order',
    });
  });

  it('recovers the arguments the tool was called with', () => {
    // `getUserInputRequests` reports the tool name but not its arguments, and
    // the arguments are what make the prompt worth reading.
    const [interrupt] = interruptsIn(confirmationEvent('x'));
    expect(interrupt.toolArgs).toEqual({orderId: '4711'});
  });

  it('keeps a hint written for a human', () => {
    const [interrupt] = interruptsIn(confirmationEvent('Delete order 4711?'));
    expect(interrupt.message).toBe('Delete order 4711?');
  });

  it("discards ADK's internal hint", () => {
    // That text tells a client developer to send a FunctionResponse. Showing
    // it to someone in a chat window is a bug.
    const [interrupt] = interruptsIn(confirmationEvent(ADK_DEFAULT_HINT));
    expect(interrupt.message).toBeUndefined();
  });
});

describe('promptFor', () => {
  it('describes the actual call when there is no usable hint', () => {
    const [interrupt] = interruptsIn(confirmationEvent(ADK_DEFAULT_HINT));

    expect(promptFor(interrupt)).toBe(
      'Run **delete_order**?\n\n• orderId: 4711',
    );
  });

  it('prefers a hint the tool author wrote', () => {
    const [interrupt] = interruptsIn(
      confirmationEvent('Really delete order 4711?'),
    );
    expect(promptFor(interrupt)).toBe('Really delete order 4711?');
  });

  it('never leaks framework vocabulary', () => {
    const [interrupt] = interruptsIn(confirmationEvent(ADK_DEFAULT_HINT));
    const prompt = promptFor(interrupt);

    expect(prompt).not.toMatch(/FunctionResponse|ToolConfirmation|payload/i);
  });
});

describe('actionsFor', () => {
  it('offers approve and reject on a channel with buttons', () => {
    const [interrupt] = interruptsIn(confirmationEvent('ok?'));
    const actions = actionsFor(interrupt, TELEGRAM_LIKE);

    expect(actions.map((a) => a.label)).toEqual(['✅ Approve', '❌ Reject']);
  });

  it('offers none on a channel without them', () => {
    const [interrupt] = interruptsIn(confirmationEvent('ok?'));
    expect(actionsFor(interrupt, MINIMAL)).toEqual([]);
  });
});

describe('renderInterrupt', () => {
  it('puts the buttons on the message', () => {
    const [interrupt] = interruptsIn(confirmationEvent('ok?'));
    const [message] = renderInterrupt(interrupt, TELEGRAM_LIKE);

    expect(message.actions).toHaveLength(2);
  });

  it('tells the user how to answer when there are no buttons', () => {
    const [interrupt] = interruptsIn(confirmationEvent('ok?'));
    const [message] = renderInterrupt(interrupt, MINIMAL);

    expect(message.actions).toBeUndefined();
    expect(message.text).toContain('yes');
  });
});

describe('answerPart', () => {
  it('builds the confirmation response the framework expects', () => {
    const part = answerPart({
      interruptId: 'interrupt-1',
      functionCallName: 'adk_request_confirmation',
      value: true,
    });

    expect(part.functionResponse).toEqual({
      id: 'interrupt-1',
      name: 'adk_request_confirmation',
      response: {confirmed: true},
    });
  });

  it('wraps any other answer as a result', () => {
    const part = answerPart({
      interruptId: 'i',
      functionCallName: 'adk_request_input',
      value: 'Lisbon',
    });

    expect(part.functionResponse?.response).toEqual({result: 'Lisbon'});
  });
});

describe('ActionTokenStore', () => {
  it('issues a handle short enough for a Telegram button', () => {
    const id = new ActionTokenStore().issue({
      sessionId: 's',
      interruptId: 'i',
      functionCallName: 'n',
      value: true,
    });

    expect(Buffer.byteLength(id)).toBeLessThanOrEqual(64);
  });

  it('resolves a handle for the session it was issued to', () => {
    const store = new ActionTokenStore();
    const id = store.issue({
      sessionId: 's1',
      interruptId: 'i',
      functionCallName: 'n',
      value: true,
    });

    expect(store.resolve(id, 's1')).toMatchObject({value: true});
  });

  it('refuses a handle presented by another session', () => {
    // Otherwise a crafted press could answer somebody else's pending question.
    const store = new ActionTokenStore();
    const id = store.issue({
      sessionId: 's1',
      interruptId: 'i',
      functionCallName: 'n',
      value: true,
    });

    expect(store.resolve(id, 's2')).toBeUndefined();
  });

  it('refuses an unknown handle', () => {
    expect(new ActionTokenStore().resolve('made-up', 's')).toBeUndefined();
  });

  it('expires a handle', () => {
    let now = 1000;
    const store = new ActionTokenStore({ttlMs: 100, now: () => now});
    const id = store.issue({
      sessionId: 's',
      interruptId: 'i',
      functionCallName: 'n',
      value: true,
    });

    now = 1200;
    expect(store.resolve(id, 's')).toBeUndefined();
  });

  it('spends a handle so one button cannot be pressed twice', () => {
    // Telegram leaves the keyboard on screen after a press.
    const store = new ActionTokenStore();
    const id = store.issue({
      sessionId: 's',
      interruptId: 'i',
      functionCallName: 'n',
      value: true,
    });

    expect(store.consume(id, 's')).toBeDefined();
    expect(store.consume(id, 's')).toBeUndefined();
  });

  it('does not grow without bound', () => {
    const store = new ActionTokenStore({maxEntries: 10});
    for (let i = 0; i < 50; i++) {
      store.issue({
        sessionId: 's',
        interruptId: `i${i}`,
        functionCallName: 'n',
        value: i,
      });
    }
    expect(store.size).toBeLessThanOrEqual(10);
  });
});

describe('a confirmation, end to end', () => {
  const deleted: string[] = [];

  function bot() {
    deleted.length = 0;
    const deleteOrder = new FunctionTool({
      name: 'delete_order',
      description: 'Deletes an order.',
      parameters: z.object({orderId: z.string()}),
      requireConfirmation: true,
      execute: ({orderId}) => {
        deleted.push(orderId);
        return {ok: true};
      },
    });

    const channel = memoryChannel();
    const gateway = createGateway({
      agent: new Agent({
        name: 'shop',
        model: stubModel(),
        instruction: 'Use the tools.',
        tools: [deleteOrder],
      }),
      channels: [channel],
      sessionService: new InMemorySessionService(),
    });
    return {channel, gateway};
  }

  it('asks before running the tool, in words a person can read', async () => {
    const {channel, gateway} = bot();
    await gateway.start();

    const replies = await channel.userSays('delete order 4711');

    const prompt = replies.map((r) => r.text).join('\n');
    expect(prompt).not.toMatch(/FunctionResponse|ToolConfirmation/i);
    expect(prompt).toContain('delete_order');
    expect(deleted).toEqual([]);
  });

  it('offers buttons that carry an opaque handle, not the raw answer', async () => {
    const {channel, gateway} = bot();
    await gateway.start();

    await channel.userSays('delete order 4711');

    const actions = channel.lastActions;
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      // The payload comes back from the client, so it must be a handle we
      // issued rather than the answer itself.
      expect(typeof action.payload).toBe('string');
      expect(String(action.payload)).not.toMatch(/interruptId|confirmed/);
    }
  });

  it('runs the tool when the user presses approve', async () => {
    const {channel, gateway} = bot();
    await gateway.start();

    await channel.userSays('delete order 4711');
    const approve = channel.lastActions[0];
    await channel.userTaps(approve.payload);

    expect(deleted).toEqual(['4711']);
  });

  it('does not run the tool when the user presses reject', async () => {
    const {channel, gateway} = bot();
    await gateway.start();

    await channel.userSays('delete order 4711');
    const reject = channel.lastActions[1];
    await channel.userTaps(reject.payload);

    expect(deleted).toEqual([]);
  });

  it('runs the tool when the user simply types yes', async () => {
    const {channel, gateway} = bot();
    await gateway.start();

    await channel.userSays('delete order 4711');
    await channel.userSays('yes');

    // Being told to press a button after typing "yes" is a poor experience.
    expect(deleted).toEqual(['4711']);
  });

  it('ignores a button payload it never issued', async () => {
    const {channel, gateway} = bot();
    await gateway.start();

    await channel.userSays('delete order 4711');
    await channel.userTaps('forged-token');

    expect(deleted).toEqual([]);
  });

  it('ignores a second press of the same button', async () => {
    const {channel, gateway} = bot();
    await gateway.start();

    await channel.userSays('delete order 4711');
    const approve = channel.lastActions[0];
    await channel.userTaps(approve.payload);
    await channel.userTaps(approve.payload);

    // Telegram leaves the keyboard on screen after a press.
    expect(deleted).toEqual(['4711']);
  });
});

/**
 * A model that asks to delete order 4711 the first time it is called, then
 * reports success. Enough to drive a real `requireConfirmation` gate without a
 * network call.
 */
class ScriptedLlm extends BaseLlm {
  private calls = 0;

  constructor() {
    super({model: 'scripted'});
  }

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void, void> {
    this.calls++;
    if (this.calls === 1) {
      yield {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'delete_order',
                args: {orderId: '4711'},
              },
            },
          ],
        },
      };
      return;
    }
    yield {content: {role: 'model', parts: [{text: 'Done.'}]}};
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('not used');
  }
}

function stubModel(): BaseLlm {
  return new ScriptedLlm();
}
