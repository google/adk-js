/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {Event} from '../../src/events/event.js';
import {BaseLlm} from '../../src/models/base_llm.js';
import {BaseLlmConnection} from '../../src/models/base_llm_connection.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {WorkflowAgent} from '../../src/workflow/workflow_agent.js';
import {createIc} from './test_helpers.js';

/** A model that replays canned responses, one per call. */
class MockLlm extends BaseLlm {
  private callCount = 0;

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'mock-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const response = this.responses[this.callCount++];
    if (response) {
      yield response;
    }
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('not implemented');
  }
}

/**
 * A non-LLM agent node that records `session.state['attempts']` as it runs,
 * reading twice across a tick so a mid-run rollback would be visible.
 */
class StateReaderAgent extends BaseAgent {
  constructor(
    config: {name: string},
    private readonly reads: Array<number | undefined>,
  ) {
    super(config);
  }

  // eslint-disable-next-line require-yield
  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.reads.push(ctx.session.state['attempts'] as number | undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.reads.push(ctx.session.state['attempts'] as number | undefined);
    return;
  }

  // eslint-disable-next-line require-yield
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
}

async function drain(gen: AsyncGenerator<Event>): Promise<Event[]> {
  const out: Event[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

async function runOnce(agent: WorkflowAgent, text = 'x') {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'test_app',
    userId: 'u1',
  });
  const runner = new Runner({appName: 'test_app', agent, sessionService});
  const events = await drain(
    runner.runAsync({
      userId: 'u1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text}]},
    }),
  );
  const finalSession = await sessionService.getSession({
    appName: 'test_app',
    userId: 'u1',
    sessionId: session.id,
  });
  return {events, state: finalSession?.state ?? {}};
}

describe('workflow state consistency across nodes', () => {
  it('a node observes the most recent write to a key, not an earlier one', async () => {
    // Regression: the runner's event commit lags node execution and re-applies
    // each event's stateDelta to the live session state. Re-applying `a`'s
    // delta used to roll back `b`'s write, so `c` read 0 instead of 1.
    const reads: Array<number | undefined> = [];

    const a = new FunctionNode('a', (ctx: NodeContext) => {
      ctx.state.set('attempts', 0);
      return 'a';
    });
    const b = new FunctionNode('b', (ctx: NodeContext) => {
      const seen = ctx.state.get<number>('attempts') ?? -1;
      ctx.state.set('attempts', seen + 1);
      return 'b';
    });
    const c = new FunctionNode('c', (ctx: NodeContext) => {
      reads.push(ctx.state.get<number>('attempts'));
      return 'c';
    });

    const {state} = await runOnce(
      new WorkflowAgent({name: 'state_wf', edges: [['START', a, b, c]]}),
    );

    expect(reads).toEqual([1]);
    // The committed session state still ends up correct.
    expect(state['attempts']).toBe(1);
  });

  it('never rolls a key back in session.state itself', async () => {
    // The overlay keeps *node* reads honest, but everything else reads
    // `session.state` directly — an agent resolving a `{key}` instruction, a
    // callback, a tool. Re-applying `a`'s delta after `b` had written used to
    // roll the key back there for as long as it took `b`'s event to commit, so
    // a reader in that window saw 0. Writes are ordered now, so the stale
    // commit is dropped and the key only ever moves forward.
    const seen: Array<number | undefined> = [];
    const watch = (ctx: NodeContext) =>
      seen.push(ctx.invocationContext.session.state['attempts'] as number);

    const a = new FunctionNode('a', (ctx: NodeContext) => {
      ctx.state.set('attempts', 0);
      return 'a';
    });
    const b = new FunctionNode('b', (ctx: NodeContext) => {
      ctx.state.set('attempts', (ctx.state.get<number>('attempts') ?? -1) + 1);
      watch(ctx);
      return 'b';
    });
    // Reads either side of a tick: the stale commit lands between them.
    const c = new FunctionNode('c', async (ctx: NodeContext) => {
      watch(ctx);
      await new Promise((resolve) => setTimeout(resolve, 0));
      watch(ctx);
      return 'c';
    });

    const {state} = await runOnce(
      new WorkflowAgent({name: 'no_rollback_wf', edges: [['START', a, b, c]]}),
    );

    expect(seen).toEqual([1, 1, 1]);
    expect(state['attempts']).toBe(1);
  });

  it('survives a long read-modify-write chain', async () => {
    const reads: number[] = [];
    const bump = (name: string) =>
      new FunctionNode(name, (ctx: NodeContext) => {
        const next = (ctx.state.get<number>('n') ?? 0) + 1;
        ctx.state.set('n', next);
        reads.push(next);
        return name;
      });

    const nodes = ['n1', 'n2', 'n3', 'n4', 'n5'].map(bump);
    const {state} = await runOnce(
      new WorkflowAgent({name: 'chain_wf', edges: [['START', ...nodes]]}),
    );

    expect(reads).toEqual([1, 2, 3, 4, 5]);
    expect(state['n']).toBe(5);
  });

  it('still reads state that was seeded on the session before the run', async () => {
    const seen: Array<string | undefined> = [];
    const read = new FunctionNode('read', (ctx: NodeContext) => {
      seen.push(ctx.state.get<string>('seeded'));
      return 'read';
    });

    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u1',
      state: {seeded: 'from-before'},
    });
    const agent = new WorkflowAgent({
      name: 'seeded_wf',
      edges: [['START', read]],
    });
    const runner = new Runner({appName: 'test_app', agent, sessionService});
    await drain(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'x'}]},
      }),
    );

    expect(seen).toEqual(['from-before']);
  });

  it('writes remain visible on session.state for instruction templating', async () => {
    // Agent instruction templates resolve `{key}` against
    // `invocationContext.session.state`, so node writes must still land there
    // synchronously — the overlay must not divert them.
    let observed: unknown;
    const write = new FunctionNode('write', (ctx: NodeContext) => {
      ctx.state.set('topic', 'oceans');
      return 'write';
    });
    const peek = new FunctionNode('peek', (ctx: NodeContext) => {
      observed = ctx.invocationContext.session.state['topic'];
      return 'peek';
    });

    await runOnce(
      new WorkflowAgent({name: 'tmpl_wf', edges: [['START', write, peek]]}),
    );

    expect(observed).toBe('oceans');
  });

  it('writes made through update() are visible the same way as set()', async () => {
    // `update` is State's other write path and is public on `ctx.state`, so it
    // has to honour both halves of the contract: later nodes read it back, and
    // it lands on `session.state` for direct readers.
    let readBack: unknown;
    let onSession: unknown;
    const write = new FunctionNode('write', (ctx: NodeContext) => {
      ctx.state.update({topic: 'oceans'});
      return 'write';
    });
    const peek = new FunctionNode('peek', (ctx: NodeContext) => {
      readBack = ctx.state.get<string>('topic');
      onSession = ctx.invocationContext.session.state['topic'];
      return 'peek';
    });

    const {state} = await runOnce(
      new WorkflowAgent({name: 'update_wf', edges: [['START', write, peek]]}),
    );

    expect(readBack).toBe('oceans');
    expect(onSession).toBe('oceans');
    expect(state['topic']).toBe('oceans');
  });

  it('an agent node\u2019s outputKey is visible to the next node', async () => {
    // `outputKey` is the wrapper's own write path into state, so it has to
    // honour the same contract as `ctx.state`: readable by a later node, on
    // `session.state` for direct readers, and committed.
    let readBack: unknown;
    let onSession: unknown;
    const writer = new LlmAgent({
      name: 'writer',
      model: new MockLlm([
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'fc_1',
                  name: 'finish_task',
                  args: {result: 'done'},
                },
              },
            ],
          },
        },
      ]),
      mode: 'task',
      outputKey: 'summary',
    });
    const peek = new FunctionNode('peek', (ctx: NodeContext) => {
      readBack = ctx.state.get('summary');
      onSession = ctx.invocationContext.session.state['summary'];
      return 'peek';
    });

    const {state} = await runOnce(
      new WorkflowAgent({
        name: 'output_key_wf',
        edges: [['START', writer, peek]],
      }),
    );

    expect(readBack).toEqual({result: 'done'});
    expect(onSession).toEqual({result: 'done'});
    expect(state['summary']).toEqual({result: 'done'});
  });

  it('an agent node reads what the preceding nodes wrote', async () => {
    // Nodes read state through `NodeContext.state`, which layers a pending
    // delta over an invocation-wide overlay; an agent reads `session.state`
    // instead. The two only agree because every write through the view is also
    // written through to the session, so this pins that they do.
    const reads: Array<number | undefined> = [];
    const a = new FunctionNode('a', (ctx: NodeContext) => {
      ctx.state.set('attempts', 0);
      return 'a';
    });
    const b = new FunctionNode('b', (ctx: NodeContext) => {
      ctx.state.set('attempts', (ctx.state.get<number>('attempts') ?? -1) + 1);
      return 'b';
    });
    const reader = new StateReaderAgent({name: 'reader'}, reads);

    const {state} = await runOnce(
      new WorkflowAgent({
        name: 'agent_reads_wf',
        edges: [['START', a, b, reader]],
      }),
    );

    // Both reads straddle a tick, so a delta re-applied by the runner's event
    // commit mid-run would show up as a rollback here.
    expect(reads).toEqual([1, 1]);
    expect(state['attempts']).toBe(1);
  });

  it('an agent node reads the surviving write after parallel writers', async () => {
    const reads: Array<number | undefined> = [];
    const slow = new FunctionNode('slow', async (ctx: NodeContext) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      ctx.state.set('attempts', 10);
      return 'slow';
    });
    const quick = new FunctionNode('quick', (ctx: NodeContext) => {
      ctx.state.set('attempts', 20);
      return 'quick';
    });
    const join = new FunctionNode('join', () => 'join');
    const reader = new StateReaderAgent({name: 'reader'}, reads);

    const {state} = await runOnce(
      new WorkflowAgent({
        name: 'parallel_writers_wf',
        edges: [
          ['START', slow, join],
          ['START', quick, join],
          [join, reader],
        ],
      }),
    );

    // Which branch wins is the workflow's business; that the agent and the
    // committed session agree on it is not.
    expect(reads[reads.length - 1]).toBe(state['attempts']);
  });

  it('shows a node what someone outside the workflow wrote mid-run', () => {
    // A node reads `session.state` directly, so a tool, a callback or an agent
    // that writes a key straight to it mid-run is visible to every later node.
    // The write overlay this used to be served from was invisible to outside
    // writers, which shadowed them for the rest of the invocation.
    const ic = createIc();
    const channel = new AsyncQueue<Event>();
    const mkCtx = () =>
      new NodeContext({
        invocationContext: ic,
        channel,
        nodePath: '',
        runId: 'root',
      });

    mkCtx().state.set('k', 'from-a-node');
    expect(mkCtx().state.get('k')).toBe('from-a-node');

    ic.session.state['k'] = 'from-outside';
    expect(mkCtx().state.get('k')).toBe('from-outside');
  });

  it('does not leak one run\u2019s writes into another session', async () => {
    // Node writes land in the session they were made against and nowhere else,
    // so a second, unrelated run starts from a clean slate.
    const seen: Array<number | undefined> = [];
    const bump = new FunctionNode('bump', (ctx: NodeContext) => {
      const next = (ctx.state.get<number>('count') ?? 0) + 1;
      ctx.state.set('count', next);
      seen.push(next);
      return next;
    });
    const agent = new WorkflowAgent({
      name: 'isolated_wf',
      edges: [['START', bump]],
    });

    await runOnce(agent, 'one');
    await runOnce(agent, 'two');

    expect(seen).toEqual([1, 1]);
  });
});
