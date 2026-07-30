/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseNode,
  createSession,
  Event,
  InvocationContext,
  NodeContext,
  PluginManager,
} from '@google/adk';

/** A minimal agent, used only to satisfy `InvocationContext.agent`. */
export class StubAgent extends BaseAgent {
  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {}

  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {}
}

/** Builds an invocation context backed by an in-memory session. */
export function makeInvocationContext(
  overrides: Partial<ConstructorParameters<typeof InvocationContext>[0]> = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new StubAgent({name: 'host'}),
    session: createSession({id: 'test-session', appName: 'test-app'}),
    pluginManager: new PluginManager(),
    ...overrides,
  });
}

/** Builds a node context for a single node run. */
export function makeNodeContext(
  node: BaseNode,
  invocationContext = makeInvocationContext(),
): NodeContext {
  return new NodeContext({invocationContext, node, runId: '1'});
}

/**
 * Runs a node directly through {@link BaseNode.run}, collecting its events.
 *
 * This deliberately bypasses the node runner so node semantics can be tested
 * without retry or timeout handling in the way.
 */
export async function drainNode(
  node: BaseNode,
  nodeInput?: unknown,
  ctx: NodeContext = makeNodeContext(node),
): Promise<{events: Event[]; ctx: NodeContext}> {
  const events: Event[] = [];
  for await (const event of node.run(ctx, nodeInput)) {
    events.push(event);
  }
  return {events, ctx};
}
