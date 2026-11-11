/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  BaseLlm,
  BaseLlmConnection,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** Parent model: on each user turn, call the child tool once, then answer. */
class ParentLlm extends BaseLlm {
  constructor() {
    super({model: 'parent-llm'});
  }
  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const last = request.contents[request.contents.length - 1];
    if (last.parts?.some((p) => p.functionResponse)) {
      yield {content: {role: 'model', parts: [{text: 'done'}]}};
      return;
    }
    yield {
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'child', args: {request: 'go'}}}],
      },
    };
  }
  async connect(): Promise<BaseLlmConnection> {
    throw new Error('no');
  }
}

class ChildLlm extends BaseLlm {
  instructions: string[] = [];
  constructor() {
    super({model: 'child-llm'});
  }
  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.instructions.push(String(request.config?.systemInstruction ?? ''));
    yield {content: {role: 'model', parts: [{text: 'child answer'}]}};
  }
  async connect(): Promise<BaseLlmConnection> {
    throw new Error('no');
  }
}

describe('AgentTool state', () => {
  it('passes the parent state current at each call to the sub-agent', async () => {
    const childLlm = new ChildLlm();
    const child = new LlmAgent({
      name: 'child',
      model: childLlm,
      instruction: 'counter is {counter}',
    });
    const parent = new LlmAgent({
      name: 'parent',
      model: new ParentLlm(),
      tools: [new AgentTool({agent: child})],
    });
    const runner = new InMemoryRunner({agent: parent, appName: 'app'});
    const session = await runner.sessionService.createSession({
      appName: 'app',
      userId: 'u',
      state: {counter: 1},
    });

    for await (const _ of runner.runAsync({
      userId: 'u',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'one'}]},
    })) {
      // drain
    }
    for await (const _ of runner.runAsync({
      userId: 'u',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'two'}]},
      stateDelta: {counter: 2},
    })) {
      // drain
    }

    const parentSession = await runner.sessionService.getSession({
      appName: 'app',
      userId: 'u',
      sessionId: session.id,
    });
    expect(parentSession!.state['counter']).toBe(2);
    expect(childLlm.instructions.length).toBe(2);
    expect(childLlm.instructions[0]).toContain('counter is 1');
    expect(childLlm.instructions[1]).toContain('counter is 2');
  });
});
