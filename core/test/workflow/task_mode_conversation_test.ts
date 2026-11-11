/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A task-mode agent node converses: it may need several user turns before it
 * can finish. A turn where it asks something and produces no output is the task
 * still in progress, so the graph holds at that node rather than failing or
 * running on with nothing.
 */

import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {Event} from '../../src/events/event.js';
import {BaseLlm} from '../../src/models/base_llm.js';
import type {BaseLlmConnection} from '../../src/models/base_llm_connection.js';
import type {LlmRequest} from '../../src/models/llm_request.js';
import type {LlmResponse} from '../../src/models/llm_response.js';
import {LLMRegistry} from '../../src/models/registry.js';
import {InMemoryRunner} from '../../src/runner/in_memory_runner.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {Workflow} from '../../src/workflow/workflow.js';

/** Asks once, then finishes on the next turn. */
class TwoTurnLlm extends BaseLlm {
  static override readonly supportedModels = [/two-turn-.*/];

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const saidName = (llmRequest.contents ?? []).some((c) =>
      (c.parts ?? []).some((p) => p.text?.includes('Ada')),
    );
    yield {
      content: saidName
        ? {
            role: 'model',
            parts: [{functionCall: {name: 'finish_task', args: {name: 'Ada'}}}],
          }
        : {role: 'model', parts: [{text: 'What is your name?'}]},
    } as LlmResponse;
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('not supported');
  }
}
LLMRegistry.register(TwoTurnLlm);

describe('task-mode agent node across turns', () => {
  it('holds the graph while the agent is still asking', async () => {
    const intake = new LlmAgent({
      name: 'intake',
      model: 'two-turn-1',
      mode: 'task',
      instruction: 'Collect the name.',
      outputSchema: {
        type: 'OBJECT',
        properties: {name: {type: 'STRING'}},
      } as never,
    });
    let downstreamRuns = 0;
    const after = node(
      (_c: NodeContext, input: {name?: string}) => {
        downstreamRuns++;
        return `hello ${input?.name}`;
      },
      {name: 'after'},
    );
    const wf = new Workflow({
      name: 'intake_flow',
      edges: [['START', intake, after]],
    });

    const runner = new InMemoryRunner({agent: wf, appName: 'app'});
    const session = await runner.sessionService.createSession({
      appName: 'app',
      userId: 'u',
    });
    const run = async (text: string): Promise<Event[]> => {
      const events: Event[] = [];
      const message: Content = {role: 'user', parts: [{text}]};
      for await (const event of runner.runAsync({
        userId: 'u',
        sessionId: session.id,
        newMessage: message,
      })) {
        events.push(event);
      }
      return events;
    };

    const turn1 = await run('go');
    expect(
      turn1
        .flatMap((e) => e.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join(' '),
    ).toContain('What is your name?');
    expect(downstreamRuns).toBe(0);

    const turn2 = await run('Ada');
    expect(downstreamRuns).toBe(1);
    expect(turn2.some((e) => e.output === 'hello Ada')).toBe(true);
  }, 30000);
});
