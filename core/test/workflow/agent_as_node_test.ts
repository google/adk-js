/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {createEvent, Event} from '../../src/events/event.js';
import {node} from '../../src/workflow/node.js';
import {createIc, driveNode, FnNode} from './test_helpers.js';

/**
 * A plain agent that is not an `LlmAgent` — the case the agent wrapper never
 * exercises, and the reason these tests exist.
 */
class EchoAgent extends BaseAgent {
  constructor(
    name: string,
    private readonly reply: string,
    nodeConfig: {timeout?: number; rerunOnResume?: boolean} = {},
  ) {
    super({name, description: `echoes ${reply}`, ...nodeConfig});
  }

  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      author: this.name,
      invocationId: ctx.invocationId,
      content: {role: 'model', parts: [{text: this.reply}]},
      output: this.reply,
    });
  }

  // eslint-disable-next-line require-yield
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
}

describe('an agent is a node', () => {
  it('runs a plain agent directly as a node', async () => {
    const {events, output} = await driveNode(new EchoAgent('echo', 'hi'));

    expect(output).toBe('hi');
    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('echo');
    expect(events[0].nodeInfo?.path).toBe('echo');
  });

  it('runs a non-LlmAgent agent through plain delegation to runAsync', async () => {
    const seen: Array<Event[]> = [];
    class QuietAgent extends BaseAgent {
      protected async *runAsyncImpl(
        ctx: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        seen.push([...ctx.session.events]);
        yield createEvent({
          author: this.name,
          invocationId: ctx.invocationId,
          content: {role: 'model', parts: [{text: 'a reply'}]},
        });
      }
      // eslint-disable-next-line require-yield
      protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
        return;
      }
    }

    const {output} = await driveNode(
      new QuietAgent({name: 'quiet'}),
      'ignored',
    );

    expect(seen[0]).toEqual([]);
    expect(output).toBeUndefined();
  });

  it('runs an agent as a dynamic child via ctx.runNode()', async () => {
    // Before an agent was a node this could not be expressed at all:
    // `runNode` takes a BaseNode, and an agent had no `run()`.
    const specialist = new EchoAgent('specialist', 'answer');
    const coordinator = new FnNode('coordinator', async (ctx) => {
      const child = await ctx.runNode(specialist);
      return `got:${child.output}`;
    });

    const {events, output} = await driveNode(coordinator);

    expect(output).toBe('got:answer');
    // The agent's own event is streamed out through the parent's channel,
    // carrying its nested node path.
    const agentEvent = events.find((e) => e.author === 'specialist');
    expect(agentEvent).toBeDefined();
    expect(agentEvent!.nodeInfo?.path).toBe('coordinator.specialist');
  });

  it('sees the invocation context the node context hands it', async () => {
    let seen: InvocationContext | undefined;
    class CapturingAgent extends BaseAgent {
      // eslint-disable-next-line require-yield
      protected async *runAsyncImpl(
        ctx: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        seen = ctx;
        return;
      }
      // eslint-disable-next-line require-yield
      protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
        return;
      }
    }

    const ic = createIc({greeting: 'hello'});
    await driveNode(new CapturingAgent({name: 'capture'}), undefined, ic);

    expect(seen).toBeDefined();
    expect(seen!.invocationId).toBe(ic.invocationId);
    expect(seen!.session.state['greeting']).toBe('hello');
  });

  it('accepts node configuration on the agent itself', () => {
    class ConfiguredAgent extends BaseAgent {
      // eslint-disable-next-line require-yield
      protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
        return;
      }
      // eslint-disable-next-line require-yield
      protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
        return;
      }
    }

    const agent = new ConfiguredAgent({
      name: 'configured',
      timeout: 5,
      rerunOnResume: true,
      waitForOutput: true,
    });

    expect(agent.timeout).toBe(5);
    expect(agent.rerunOnResume).toBe(true);
    expect(agent.waitForOutput).toBe(true);
  });

  it('places an agent in a graph as itself, unwrapped', () => {
    const agent = new EchoAgent('graphed', 'x');
    expect(node(agent)).toBe(agent);
  });

  it('honours node configuration set on the agent, once it is the node', () => {
    const agent = new EchoAgent('configured', 'x', {
      timeout: 5,
      rerunOnResume: true,
    });
    const built = node(agent);
    expect(built.timeout).toBe(5);
    expect(built.rerunOnResume).toBe(true);
  });

  it('keeps the agent name rules, which are stricter than a node’s', () => {
    expect(() => new EchoAgent('user', 'x')).toThrow();
    expect(() => new EchoAgent('not an identifier', 'x')).toThrow();
  });

  it('defaults description to the empty string, as a node does', () => {
    class Bare extends BaseAgent {
      // eslint-disable-next-line require-yield
      protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
        return;
      }
      // eslint-disable-next-line require-yield
      protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
        return;
      }
    }
    expect(new Bare({name: 'bare'}).description).toBe('');
  });
});
