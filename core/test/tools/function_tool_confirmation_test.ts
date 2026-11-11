/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BaseTool,
  Context,
  Event,
  EventType,
  FunctionTool,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  RunConfig,
  ToolConfirmation,
  createEvent,
  createSession,
  getFunctionCalls,
  getFunctionResponses,
  isFinalResponse,
  toStructuredEvents,
} from '@google/adk';
import {Content, FunctionCall} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v3';
import {REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR} from '../../src/agents/processors/request_confirmation_llm_request_processor.js';

function makeContext(options: {
  functionCallId?: string;
  toolConfirmation?: ToolConfirmation;
}): Context {
  const session = createSession({
    id: 's1',
    appName: 'app',
    userId: 'u1',
  });
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    // A real agent instance, so the fixture breaks if InvocationContext's
    // contract changes (rather than being silenced by `as never`).
    agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
    session,
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext, ...options});
}

describe('FunctionTool require_confirmation', () => {
  function makeTool() {
    let ran = false;
    const tool = new FunctionTool({
      name: 'delete_file',
      description: 'Deletes a file.',
      parameters: z.object({path: z.string()}),
      execute: () => {
        ran = true;
        return 'deleted';
      },
      requireConfirmation: true,
    });
    return {tool, didRun: () => ran};
  }

  it('pauses and requests confirmation on first call', async () => {
    const {tool, didRun} = makeTool();
    const ctx = makeContext({functionCallId: 'fc-1'});

    const result = await tool.runAsync({
      args: {path: '/tmp/x'},
      toolContext: ctx,
    });

    expect(result).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(didRun()).toBe(false);
    expect(ctx.actions.requestedToolConfirmations['fc-1']).toBeDefined();
    expect(ctx.actions.skipSummarization).toBe(true);
  });

  it('runs the tool once the call is confirmed', async () => {
    const {tool, didRun} = makeTool();
    const ctx = makeContext({
      functionCallId: 'fc-1',
      toolConfirmation: new ToolConfirmation({confirmed: true}),
    });

    const result = await tool.runAsync({
      args: {path: '/tmp/x'},
      toolContext: ctx,
    });

    expect(result).toBe('deleted');
    expect(didRun()).toBe(true);
  });

  it('rejects the tool call when confirmation is denied', async () => {
    const {tool, didRun} = makeTool();
    const ctx = makeContext({
      functionCallId: 'fc-1',
      toolConfirmation: new ToolConfirmation({confirmed: false}),
    });

    const result = await tool.runAsync({
      args: {path: '/tmp/x'},
      toolContext: ctx,
    });

    expect(result).toEqual({error: 'This tool call is rejected.'});
    expect(didRun()).toBe(false);
  });

  it('refuses to run a gated tool with no context to raise the gate on', async () => {
    const {tool, didRun} = makeTool();

    await expect(
      tool.runAsync({args: {path: '/tmp/x'}} as unknown as {
        args: Record<string, unknown>;
        toolContext: Context;
      }),
    ).rejects.toThrow(
      "Error in tool 'delete_file': Tool 'delete_file' requires confirmation" +
        ' but no tool context was provided.',
    );
    expect(didRun()).toBe(false);
  });

  it('runs immediately when confirmation is not required', async () => {
    let ran = false;
    const tool = new FunctionTool({
      name: 'noop',
      description: 'no-op',
      execute: () => {
        ran = true;
        return 'ok';
      },
    });
    const ctx = makeContext({functionCallId: 'fc-1'});

    const result = await tool.runAsync({args: {}, toolContext: ctx});

    expect(result).toBe('ok');
    expect(ran).toBe(true);
  });

  it('supports a predicate to decide confirmation per-args', async () => {
    let ran = false;
    const tool = new FunctionTool({
      name: 'transfer',
      description: 'Transfers money.',
      parameters: z.object({amount: z.number()}),
      execute: () => {
        ran = true;
        return 'sent';
      },
      requireConfirmation: (input) => input.amount > 100,
    });

    // Small amount: no confirmation required, runs directly.
    const smallCtx = makeContext({functionCallId: 'fc-small'});
    expect(
      await tool.runAsync({args: {amount: 10}, toolContext: smallCtx}),
    ).toBe('sent');
    expect(ran).toBe(true);

    // Large amount: confirmation required, pauses.
    ran = false;
    const largeCtx = makeContext({functionCallId: 'fc-large'});
    const result = await tool.runAsync({
      args: {amount: 1000},
      toolContext: largeCtx,
    });
    expect(result).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(ran).toBe(false);
  });
});

describe('checkRequireConfirmation', () => {
  it('reports the static flag', async () => {
    const gated = new FunctionTool({
      name: 'delete_file',
      description: 'Deletes a file.',
      parameters: z.object({path: z.string()}),
      execute: () => 'deleted',
      requireConfirmation: true,
    });
    const ungated = new FunctionTool({
      name: 'read_file',
      description: 'Reads a file.',
      parameters: z.object({path: z.string()}),
      execute: () => 'contents',
    });

    expect(await gated.checkRequireConfirmation({path: '/tmp/x'})).toBe(true);
    expect(await ungated.checkRequireConfirmation({path: '/tmp/x'})).toBe(
      false,
    );
  });

  it('evaluates a predicate against the validated arguments', async () => {
    const tool = new FunctionTool({
      name: 'transfer',
      description: 'Transfers money.',
      parameters: z.object({amount: z.number()}),
      execute: () => 'sent',
      requireConfirmation: (input) => input.amount > 100,
    });

    expect(await tool.checkRequireConfirmation({amount: 1000})).toBe(true);
    expect(await tool.checkRequireConfirmation({amount: 10})).toBe(false);
  });

  it('passes the tool context through to the predicate', async () => {
    const seen: Array<string | undefined> = [];
    const tool = new FunctionTool({
      name: 'transfer',
      description: 'Transfers money.',
      parameters: z.object({amount: z.number()}),
      execute: () => 'sent',
      requireConfirmation: (_input, toolContext) => {
        seen.push(toolContext?.functionCallId);
        return true;
      },
    });
    const ctx = makeContext({functionCallId: 'fc-1'});

    expect(await tool.checkRequireConfirmation({amount: 1}, ctx)).toBe(true);
    expect(seen).toEqual(['fc-1']);
  });

  it('runs without a parameter schema to validate against', async () => {
    const tool = new FunctionTool({
      name: 'ping',
      description: 'Pings.',
      execute: () => 'pong',
      requireConfirmation: true,
    });

    expect(await tool.checkRequireConfirmation({})).toBe(true);
  });

  it('defaults to false for a tool that has no gate of its own', async () => {
    class BareTool extends BaseTool {
      constructor() {
        super({name: 'bare', description: 'No gate.'});
      }
      override async runAsync(): Promise<unknown> {
        return 'ok';
      }
    }

    expect(await new BareTool().checkRequireConfirmation({})).toBe(false);
  });
});

// --- End-to-end resume through RequestConfirmationLlmRequestProcessor --------
//
// The tests above assert the two ends of the gate in isolation. These drive a
// real session event list back through the processor with a real LlmAgent + a
// real FunctionTool (no mocks), asserting the original tool is actually
// re-invoked with the right decision — the step where an id mismatch on resume
// would show up, and the only coverage of the plain-text fallback.

/** A tool that records whether (and how) it was executed on resume. */
function makeGatedTool() {
  const calls: Array<{path: string}> = [];
  const tool = new FunctionTool({
    name: 'delete_file',
    description: 'Deletes a file.',
    parameters: z.object({path: z.string()}),
    execute: (args) => {
      calls.push(args);
      return `deleted ${args.path}`;
    },
    requireConfirmation: true,
  });
  return {tool, calls};
}

/**
 * The events a pause writes: the agent's own tool call, then the
 * engine-emitted `adk_request_confirmation` call pinning it.
 */
function confirmationRequestEvents(
  confirmId: string,
  originalFunctionCall: FunctionCall,
): Event[] {
  return [
    createEvent({
      invocationId: 'inv-1',
      author: 'agent',
      content: {role: 'model', parts: [{functionCall: originalFunctionCall}]},
    }),
    createEvent({
      invocationId: 'inv-1',
      author: 'agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: confirmId,
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              args: {originalFunctionCall},
            },
          },
        ],
      },
      longRunningToolIds: [confirmId],
    }),
  ];
}

/** A structured user confirmation response addressed to `confirmId`. */
function structuredConfirmationEvent(
  confirmId: string,
  confirmed: boolean,
): Event {
  return createEvent({
    invocationId: 'inv-1',
    author: 'user',
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: confirmId,
            name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
            response: {confirmed, hint: ''},
          },
        },
      ],
    },
  });
}

/** A plain-text user reply. */
function plainTextEvent(text: string): Event {
  return createEvent({
    invocationId: 'inv-1',
    author: 'user',
    content: {role: 'user', parts: [{text}]},
  });
}

async function resume(
  tool: FunctionTool<z.ZodObject<{path: z.ZodString}>>,
  events: Event[],
  runConfig?: RunConfig,
): Promise<Event[]> {
  const agent = new LlmAgent({
    name: 'agent',
    model: 'gemini-2.5-flash',
    tools: [tool],
  });
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent,
    session: createSession({id: 's1', appName: 'app', userId: 'u1', events}),
    pluginManager: new PluginManager([]),
    runConfig,
  });
  const out: Event[] = [];
  for await (const event of REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR.runAsync(
    invocationContext,
  )) {
    out.push(event);
  }
  return out;
}

const originalCall: FunctionCall = {
  id: 'orig-1',
  name: 'delete_file',
  args: {path: '/tmp/x'},
};

describe('RequestConfirmation resume round-trip', () => {
  it('re-invokes the tool when a structured approval arrives', async () => {
    const {tool, calls} = makeGatedTool();
    const out = await resume(tool, [
      ...confirmationRequestEvents('confirm-1', originalCall),
      structuredConfirmationEvent('confirm-1', true),
    ]);

    expect(calls).toEqual([{path: '/tmp/x'}]);
    expect(out).toHaveLength(1);
    expect(out[0].content?.parts?.[0].functionResponse?.id).toBe('orig-1');
  });

  it('does not run the tool when the structured decision is a denial', async () => {
    const {tool, calls} = makeGatedTool();
    await resume(tool, [
      ...confirmationRequestEvents('confirm-1', originalCall),
      structuredConfirmationEvent('confirm-1', false),
    ]);
    expect(calls).toEqual([]);
  });

  it('ignores a plain-text reply unless the run opts in', async () => {
    const {tool, calls} = makeGatedTool();
    // Same yes reply, but plainTextToolConfirmation is not set.
    await resume(tool, [
      ...confirmationRequestEvents('confirm-1', originalCall),
      plainTextEvent('yes'),
    ]);
    expect(calls).toEqual([]);
  });

  it('resumes on a plain-text approval when opted in', async () => {
    const {tool, calls} = makeGatedTool();
    const out = await resume(
      tool,
      [
        ...confirmationRequestEvents('confirm-1', originalCall),
        plainTextEvent('yes'),
      ],
      {plainTextToolConfirmation: true},
    );
    expect(calls).toEqual([{path: '/tmp/x'}]);
    expect(out).toHaveLength(1);
  });

  it('leaves the gate pending on unrecognized plain text (no silent denial)', async () => {
    const {tool, calls} = makeGatedTool();
    const out = await resume(
      tool,
      [
        ...confirmationRequestEvents('confirm-1', originalCall),
        plainTextEvent('what does that do?'),
      ],
      {plainTextToolConfirmation: true},
    );
    // Unrecognized text is treated as no decision: the tool is neither run nor
    // recorded as rejected — the gate simply stays pending.
    expect(calls).toEqual([]);
    expect(out).toHaveLength(0);
  });

  it('does not broadcast one plain-text reply across multiple pending gates', async () => {
    const {tool, calls} = makeGatedTool();
    const secondCall: FunctionCall = {
      id: 'orig-2',
      name: 'delete_file',
      args: {path: '/tmp/y'},
    };
    // Two separate pending confirmations; a single "yes" must resolve only the
    // most recent one it immediately follows, not both.
    const out = await resume(
      tool,
      [
        ...confirmationRequestEvents('confirm-1', originalCall),
        ...confirmationRequestEvents('confirm-2', secondCall),
        plainTextEvent('yes'),
      ],
      {plainTextToolConfirmation: true},
    );
    expect(calls).toEqual([{path: '/tmp/y'}]);
    expect(out).toHaveLength(1);
    expect(out[0].content?.parts?.[0].functionResponse?.id).toBe('orig-2');
  });
});

// --- Parallel calls where only some need confirmation ------------------------
//
// Driven through a real Runner: the model calls a gated tool and an ungated
// one in the same turn, so the ungated one runs while the gated one waits.

/** Records every request; calls the given tools in parallel, then replies. */
class ParallelCallsLlm extends BaseLlm {
  readonly requests: Content[][] = [];

  constructor(private readonly functionCalls: FunctionCall[]) {
    super({model: 'parallel-calls'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(structuredClone(request.contents));
    yield this.requests.length === 1
      ? {
          content: {
            role: 'model',
            parts: this.functionCalls.map((functionCall) => ({functionCall})),
          },
        }
      : {content: {role: 'model', parts: [{text: 'done'}]}};
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('Live connections are not used in this test.');
  }
}

/** The function responses of each content that has some, by tool name. */
function functionResponsesSent(contents: Content[]) {
  return contents
    .map((content) =>
      Object.fromEntries(
        (content.parts ?? [])
          .filter((part) => part.functionResponse)
          .map((part) => [
            part.functionResponse!.name,
            part.functionResponse!.response,
          ]),
      ),
    )
    .filter((responses) => Object.keys(responses).length > 0);
}

describe('confirmation for one of several parallel calls', () => {
  const deleteCall: FunctionCall = {
    id: 'call-delete',
    name: 'delete_file',
    args: {path: '/tmp/x'},
  };
  const listCall: FunctionCall = {
    id: 'call-list',
    name: 'list_files',
    args: {},
  };

  function setUp(functionCalls: FunctionCall[]) {
    const deleted: string[] = [];
    let listRuns = 0;
    const deleteFile = new FunctionTool({
      name: 'delete_file',
      description: 'Deletes a file.',
      parameters: z.object({path: z.string()}),
      requireConfirmation: true,
      execute: ({path}) => {
        deleted.push(path);
        return {deleted: path};
      },
    });
    const listFiles = new FunctionTool({
      name: 'list_files',
      description: 'Lists files.',
      execute: (_args, toolContext) => {
        listRuns++;
        toolContext!.state.set('listed', true);
        return {files: ['x']};
      },
    });
    const llm = new ParallelCallsLlm(functionCalls);
    const runner = new InMemoryRunner({
      agent: new LlmAgent({
        name: 'agent',
        model: llm,
        tools: [deleteFile, listFiles],
      }),
      appName: 'app',
    });
    const sessionPromise = runner.sessionService.createSession({
      appName: 'app',
      userId: 'u1',
    });
    async function send(newMessage: Content): Promise<Event[]> {
      const session = await sessionPromise;
      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage,
      })) {
        events.push(event);
      }
      return events;
    }
    async function storedState() {
      const session = await sessionPromise;
      return (await runner.sessionService.getSession({
        appName: 'app',
        userId: 'u1',
        sessionId: session.id,
      }))!.state;
    }
    return {
      llm,
      send,
      storedState,
      deleted,
      listRuns: () => listRuns,
    };
  }

  function confirmation(confirmationCallId: string, confirmed: boolean) {
    return {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: confirmationCallId,
            name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
            response: {confirmed},
          },
        },
      ],
    };
  }

  it.each([
    {confirmed: true, deleteResponse: {deleted: '/tmp/x'}},
    {confirmed: false, deleteResponse: {error: 'This tool call is rejected.'}},
  ])(
    'keeps the response of the call that ran (confirmed: $confirmed)',
    async ({confirmed, deleteResponse}) => {
      const {llm, send, storedState, deleted, listRuns} = setUp([
        deleteCall,
        listCall,
      ]);

      const paused = await send({role: 'user', parts: [{text: 'clean up'}]});

      const gate = paused.at(-1)!;
      const [confirmationCall] = getFunctionCalls(gate);
      expect(confirmationCall.name).toBe(
        REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
      );
      expect(isFinalResponse(gate)).toBe(true);
      // The ungated call ran once, and its response is stored before the
      // pause, next to the gated call's placeholder.
      const responses = paused.at(-2)!;
      expect(getFunctionResponses(responses).map((r) => r.id)).toEqual([
        'call-delete',
        'call-list',
      ]);
      expect(isFinalResponse(responses)).toBe(false);
      expect(listRuns()).toBe(1);
      expect(deleted).toEqual([]);
      expect((await storedState())['listed']).toBe(true);
      // The state change and the confirmation request are each stored once.
      expect(responses.actions.stateDelta).toEqual({listed: true});
      expect(gate.actions.stateDelta).toEqual({});
      expect(
        paused
          .flatMap((event) => toStructuredEvents(event))
          .filter((event) => event.type === EventType.TOOL_CONFIRMATION),
      ).toHaveLength(1);

      await send(confirmation(confirmationCall.id!, confirmed));

      expect(listRuns()).toBe(1);
      expect(deleted).toEqual(confirmed ? ['/tmp/x'] : []);
      const expected = [
        {delete_file: deleteResponse, list_files: {files: ['x']}},
      ];
      // The resumed request answers both calls of the turn, and so does every
      // later one.
      expect(functionResponsesSent(llm.requests[1])).toEqual(expected);
      await send({role: 'user', parts: [{text: 'thanks'}]});
      expect(functionResponsesSent(llm.requests[2])).toEqual(expected);
    },
  );

  it('pauses on the gate alone when every call waits for confirmation', async () => {
    const {llm, send, deleted} = setUp([deleteCall]);

    const paused = await send({role: 'user', parts: [{text: 'clean up'}]});

    expect(paused).toHaveLength(2);
    expect(getFunctionCalls(paused[0])).toEqual([deleteCall]);
    const [confirmationCall] = getFunctionCalls(paused[1]);
    expect(confirmationCall.name).toBe(REQUEST_CONFIRMATION_FUNCTION_CALL_NAME);
    expect(paused[1].actions.requestedToolConfirmations).toHaveProperty(
      'call-delete',
    );

    await send(confirmation(confirmationCall.id!, true));

    expect(deleted).toEqual(['/tmp/x']);
    expect(functionResponsesSent(llm.requests[1])).toEqual([
      {delete_file: {deleted: '/tmp/x'}},
    ]);
  });
});
