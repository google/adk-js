/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  BaseNode,
  BasePlugin,
  createEvent,
  Event,
  FunctionTool,
  getFunctionCalls,
  getFunctionResponses,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Runner,
  Session,
  Workflow,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';

import {logger} from '../../src/utils/logger.js';
import {NodeContext} from '../../src/workflow/node_context.js';

const APP = 'test_app';
const USER = 'test_user';
const ABORT_MESSAGE = 'Invocation was aborted by client.';

/** Resolves once `signal` aborts, or after a timeout as a safety net. */
function waitForAbort(signal?: AbortSignal, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Yields `script`, then waits for the abort; later turns reply with text. */
class AbortableAgent extends BaseAgent {
  private runs = 0;

  constructor(
    name: string,
    private readonly script: Part[][],
  ) {
    super({name});
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.runs++;
    if (this.runs > 1) {
      yield createEvent({
        invocationId: ctx.invocationId,
        author: this.name,
        content: {role: 'model', parts: [{text: 'Follow-up complete'}]},
      });
      return;
    }
    for (const parts of this.script) {
      yield createEvent({
        invocationId: ctx.invocationId,
        author: this.name,
        content: {role: 'model', parts},
      });
    }
    await waitForAbort(ctx.abortSignal);
  }

  // eslint-disable-next-line require-yield
  protected override async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
}

/** Replays one response per call and records every request. */
class RecordingLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly replies: Array<string | Part>) {
    super({model: 'recording-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(structuredClone(request.contents) as never);
    const reply =
      this.replies[Math.min(this.requests.length - 1, this.replies.length - 1)];
    const part: Part = typeof reply === 'string' ? {text: reply} : reply;
    yield {content: {role: 'model', parts: [part]}};
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('not supported');
  }
}

function slowTool(): FunctionTool {
  return new FunctionTool({
    name: 'slow_tool',
    description: 'Blocks until the invocation is aborted.',
    execute: async (_args, toolContext) => {
      await waitForAbort(toolContext?.abortSignal);
      return {};
    },
  });
}

function llmToolAgent(): {agent: LlmAgent; model: RecordingLlm} {
  const model = new RecordingLlm([
    {functionCall: {name: 'slow_tool', args: {}}},
    'Recovered',
  ]);
  return {
    agent: new LlmAgent({name: 'tool_agent', model, tools: [slowTool()]}),
    model,
  };
}

function legacyToolAgent(): BaseAgent {
  return new AbortableAgent('tool_agent', [
    [{functionCall: {id: 'call_1', name: 'slow_tool', args: {}}}],
  ]);
}

function makeRunner(
  agent: BaseAgent | Workflow,
  options: {
    plugins?: BasePlugin[];
    sessionService?: InMemorySessionService;
  } = {},
): Runner {
  return new Runner({
    appName: APP,
    agent,
    plugins: options.plugins,
    sessionService: options.sessionService ?? new InMemorySessionService(),
  });
}

async function runTurn(
  runner: Runner,
  sessionId: string,
  text: string,
  options: {
    abortWhen?: (event: Event) => boolean;
    closeOnAbort?: boolean;
  } = {},
): Promise<{events: Event[]; session: Session}> {
  const existing = await runner.sessionService.getSession({
    appName: APP,
    userId: USER,
    sessionId,
  });
  if (!existing) {
    await runner.sessionService.createSession({
      appName: APP,
      userId: USER,
      sessionId,
    });
  }
  const controller = new AbortController();
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: USER,
    sessionId,
    newMessage: {role: 'user', parts: [{text}]},
    abortSignal: controller.signal,
  })) {
    events.push(event);
    if (options.abortWhen?.(event)) {
      controller.abort();
      if (options.closeOnAbort) break;
    }
  }
  const session = (await runner.sessionService.getSession({
    appName: APP,
    userId: USER,
    sessionId,
  }))!;
  return {events, session};
}

function abortEvents(events: Event[]): Event[] {
  return events.filter((e) => e.errorCode === 'INVOCATION_ABORTED');
}

function hasFunctionCall(event: Event): boolean {
  return getFunctionCalls(event).length > 0;
}

function texts(contents: Array<Content | undefined>): string[] {
  return contents.flatMap((c) =>
    (c?.parts ?? []).flatMap((p) => (p.text ? [p.text] : [])),
  );
}

function functionResponsesIn(contents: Content[]): unknown[] {
  return contents.flatMap((c) =>
    (c.parts ?? []).flatMap((p) =>
      p.functionResponse ? [p.functionResponse.response] : [],
    ),
  );
}

describe('Runner abort sealing', () => {
  it('seals a dangling call with a synthetic response; the next turn runs cleanly', async () => {
    const runner = makeRunner(legacyToolAgent());

    const {events, session} = await runTurn(runner, 's', 'Run', {
      abortWhen: hasFunctionCall,
    });

    expect(abortEvents(events)).toHaveLength(1);
    const frEvents = session.events.filter(
      (e) => getFunctionResponses(e).length > 0,
    );
    expect(
      frEvents.flatMap((e) => getFunctionResponses(e).map((fr) => fr.id)),
    ).toEqual(['call_1']);
    expect(abortEvents(frEvents)).toEqual(frEvents);

    const next = await runTurn(runner, 's', 'Next question');
    expect(texts(next.events.map((e) => e.content))).toEqual([
      'Follow-up complete',
    ]);
  });

  it('records a single root-agent abort event when nothing is dangling', async () => {
    const runner = makeRunner(
      new AbortableAgent('text_agent', [[{text: 'Generating'}]]),
    );

    const {session} = await runTurn(runner, 's', 'Start', {
      abortWhen: (e) => e.author === 'text_agent',
    });

    const sealed = abortEvents(session.events);
    expect(sealed).toHaveLength(1);
    expect(sealed[0].author).toBe('text_agent');
    expect(sealed[0].errorMessage).toBe(ABORT_MESSAGE);
    expect(sealed[0].content).toBeUndefined();
  });

  it('passes abort events through onEventCallback', async () => {
    const log: string[] = [];
    class LifecyclePlugin extends BasePlugin {
      override async onEventCallback({event}: {event: Event}) {
        log.push(
          event.errorCode === 'INVOCATION_ABORTED'
            ? 'on_event:abort'
            : 'on_event:normal',
        );
        return undefined;
      }
    }
    const runner = makeRunner(legacyToolAgent(), {
      plugins: [new LifecyclePlugin('lifecycle')],
    });

    await runTurn(runner, 's', 'Go', {abortWhen: hasFunctionCall});

    expect(log).toEqual(['on_event:normal', 'on_event:abort']);
  });

  it('propagates a failure appending the abort event', async () => {
    const sessionService = new InMemorySessionService();
    const originalAppend = sessionService.appendEvent.bind(sessionService);
    sessionService.appendEvent = async (params) => {
      if (params.event.errorCode === 'INVOCATION_ABORTED') {
        throw new Error('Simulated DB failure on abort event');
      }
      return originalAppend(params);
    };
    const runner = makeRunner(
      new AbortableAgent('simple_agent', [[{text: 'First'}]]),
      {sessionService},
    );

    await expect(
      runTurn(runner, 's', 'Start', {abortWhen: () => true}),
    ).rejects.toThrow('Simulated DB failure on abort event');
  });

  it('sends the abort error to the model on the next turn for an LlmAgent root', async () => {
    const {agent, model} = llmToolAgent();
    const runner = makeRunner(agent);

    await runTurn(runner, 's', 'Run', {abortWhen: hasFunctionCall});
    const {events} = await runTurn(runner, 's', 'Next question');

    expect(texts(events.map((e) => e.content))).toEqual(['Recovered']);
    const lastRequest = model.requests[model.requests.length - 1];
    expect(functionResponsesIn(lastRequest as unknown as Content[])).toEqual([
      {error: ABORT_MESSAGE},
    ]);
  });

  describe.each([
    ['legacy', legacyToolAgent],
    ['llm', () => llmToolAgent().agent],
  ])('when the caller aborts and stops reading (%s)', (_label, makeAgent) => {
    it('still seals the dangling call', async () => {
      const runner = makeRunner(makeAgent());

      const {events, session} = await runTurn(runner, 's', 'Run', {
        abortWhen: hasFunctionCall,
        closeOnAbort: true,
      });

      expect(abortEvents(events)).toEqual([]);
      const sealed = abortEvents(session.events);
      expect(
        sealed.flatMap((e) => getFunctionResponses(e).map((fr) => fr.name)),
      ).toEqual(['slow_tool']);
    });

    it('logs a sealing failure instead of throwing', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const sessionService = new InMemorySessionService();
      const originalAppend = sessionService.appendEvent.bind(sessionService);
      sessionService.appendEvent = async (params) => {
        if (params.event.errorCode === 'INVOCATION_ABORTED') {
          throw new Error('Simulated DB failure on abort event');
        }
        return originalAppend(params);
      };
      const runner = makeRunner(makeAgent(), {sessionService});

      try {
        await runTurn(runner, 's', 'Run', {
          abortWhen: hasFunctionCall,
          closeOnAbort: true,
        });

        expect(
          errorSpy.mock.calls.some((args) =>
            String(args[0]).includes('Failed to seal aborted invocation'),
          ),
        ).toBe(true);
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  it('yields one abort event when a workflow root is aborted', async () => {
    class LongRunningNode extends BaseNode {
      constructor() {
        super({name: 'LongNode'});
      }
      protected async *runImpl(ctx: NodeContext) {
        await waitForAbort(ctx.invocationContext.abortSignal);
        yield createEvent({output: 'should_not_reach_here'});
      }
    }
    const workflow = new Workflow({
      name: 'wf',
      edges: [['START', new LongRunningNode()]],
    });
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: APP,
      userId: USER,
    });
    const runner = makeRunner(workflow, {sessionService});
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: USER,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'go'}]},
      abortSignal: controller.signal,
    })) {
      events.push(event);
    }

    expect(events.map((e) => e.errorCode)).toEqual(['INVOCATION_ABORTED']);
    expect(events[0].author).toBe('wf');
  });
});
