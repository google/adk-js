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
import {LLMAgentWrapper} from '../../src/workflow/nodes/llm_agent_wrapper.js';
import {createIc, driveNode, FnNode} from './test_helpers.js';

/**
 * A plain agent that is not an `LlmAgent` — the case the agent wrapper never
 * exercises, and the reason these tests exist.
 */
class EchoAgent extends BaseAgent {
  constructor(
    name: string,
    private readonly reply: string,
  ) {
    super({name, description: `echoes ${reply}`});
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

  it('still wraps an agent that is placed in a graph', () => {
    // An agent is a node now, so `buildNode` would otherwise hand it back
    // as-is and skip the wrapper that drives prompt injection and task mode.
    const built = node(new EchoAgent('graphed', 'x'));
    expect(built).toBeInstanceOf(LLMAgentWrapper);
    expect(built.name).toBe('graphed');
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
