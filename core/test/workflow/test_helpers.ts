/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {createEvent, Event} from '../../src/events/event.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession} from '../../src/sessions/session.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {BaseNode, BaseNodeConfig} from '../../src/workflow/base_node.js';
import {NodeContext} from '../../src/workflow/node_context.js';

/** A minimal concrete {@link BaseAgent} for driving nodes directly in tests. */
class TestAgent extends BaseAgent {
  // eslint-disable-next-line require-yield
  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
  // eslint-disable-next-line require-yield
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
}

/**
 * An agent that replies with `reply` and leaves `output` unset on its event, so
 * a node output can only have come from the wrapper `buildNode` puts around an
 * agent — which is what a caller passing one bare has to still get.
 */
export class ReplyAgent extends BaseAgent {
  constructor(
    name: string,
    private readonly reply = 'ok',
  ) {
    super({name});
  }

  protected async *runAsyncImpl(
    ic: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      author: this.name,
      invocationId: ic.invocationId,
      content: {role: 'model', parts: [{text: this.reply}]},
    });
  }

  // eslint-disable-next-line require-yield
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
}

/** Builds a throwaway InvocationContext for driving nodes directly in tests. */
export function createIc(
  state: Record<string, unknown> = {},
  abortSignal?: AbortSignal,
): InvocationContext {
  const session = createSession({
    id: 's1',
    appName: 'app',
    userId: 'u',
    state,
    lastUpdateTime: Date.now(),
  });
  return new InvocationContext({
    invocationId: 'inv-1',
    session,
    agent: new TestAgent({name: 'wf'}),
    pluginManager: new PluginManager(),
    abortSignal,
  });
}

/** Runs a node (or workflow) to completion, returning its events and output. */
export async function driveNode(
  node: BaseNode,
  input?: unknown,
  ic: InvocationContext = createIc(),
): Promise<{events: Event[]; output: unknown; ctx: NodeContext}> {
  const channel = new AsyncQueue<Event>();
  const root = new NodeContext({
    invocationContext: ic,
    channel,
    nodePath: '',
    runId: 'root',
  });
  const events: Event[] = [];
  const settle = root.runNode(node, input, {useAsOutput: true}).then(
    () => channel.close(),
    (err) => channel.fail(err),
  );
  for await (const ev of channel) {
    events.push(ev);
  }
  await settle;
  return {events, output: root.output, ctx: root};
}

/** Options for {@link driveWorkflow}. */
export interface DriveWorkflowOptions {
  /** InvocationContext to run under (defaults to a fresh {@link createIc}). */
  ic?: InvocationContext;
  /** Resume inputs keyed by interrupt id (for HITL/auth resume). */
  resumeInputs?: Record<string, unknown>;
}

/**
 * Drives a workflow (or any node) to completion and returns its streamed events,
 * final output, and the interrupt ids it is paused on — the shared harness for
 * the workflow-level tests (replaces the per-file `createIc`/`driveWorkflow`
 * copies that reached for `as unknown as Session/BaseAgent`).
 */
export async function driveWorkflow(
  wf: BaseNode,
  input?: unknown,
  options: DriveWorkflowOptions = {},
): Promise<{events: Event[]; output: unknown; interruptIds: string[]}> {
  const channel = new AsyncQueue<Event>();
  const root = new NodeContext({
    invocationContext: options.ic ?? createIc(),
    channel,
    nodePath: '',
    runId: 'root',
    resumeInputs: options.resumeInputs,
  });
  const events: Event[] = [];
  const resultPromise = root.runNode(wf, input, {useAsOutput: true});
  const settle = resultPromise.then(
    () => channel.close(),
    (err) => channel.fail(err),
  );
  for await (const ev of channel) {
    events.push(ev);
  }
  await settle;
  const result = await resultPromise;
  return {events, output: root.output, interruptIds: result.interruptIds};
}

/** A node whose behavior is a plain function returning a value or Event. */
export class FnNode extends BaseNode {
  constructor(
    name: string,
    private readonly fn: (
      ctx: NodeContext,
      input: unknown,
    ) => unknown | Promise<unknown>,
    config: Partial<Omit<BaseNodeConfig, 'name'>> = {},
  ) {
    super({name, ...config});
  }
  protected async *runImpl(ctx: NodeContext, input: unknown) {
    yield await this.fn(ctx, input);
  }
}
