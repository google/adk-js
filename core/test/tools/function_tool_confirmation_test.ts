/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  Event,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  RunConfig,
  ToolConfirmation,
  createEvent,
  createSession,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
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
