/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What an `LlmAgent` sees when it runs as a workflow node: the input the graph
 * handed it, and nothing else. The node input is appended as the agent's user
 * turn and predecessor outputs reach it through the instruction scope, so
 * leaving the surrounding conversation in duplicates the one and leaks the
 * other.
 */

import {describe, expect, it} from 'vitest';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {createEvent, Event} from '../../src/events/event.js';
import {BaseLlm} from '../../src/models/base_llm.js';
import type {BaseLlmConnection} from '../../src/models/base_llm_connection.js';
import type {LlmRequest} from '../../src/models/llm_request.js';
import type {LlmResponse} from '../../src/models/llm_response.js';
import {LLMRegistry} from '../../src/models/registry.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {createIc} from './test_helpers.js';

const requests: LlmRequest[] = [];

/** Captures each request and answers with a fixed reply. */
class CaptureLlm extends BaseLlm {
  static override readonly supportedModels = [/capture-.*/];

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    requests.push(
      structuredClone({contents: llmRequest.contents}) as LlmRequest,
    );
    yield {content: {role: 'model', parts: [{text: 'ok'}]}} as LlmResponse;
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('not supported');
  }
}
LLMRegistry.register(CaptureLlm);

async function drive(wf: Workflow, input: unknown): Promise<void> {
  const channel = new AsyncQueue<Event>();
  const root = new NodeContext({
    invocationContext: createIc(),
    channel,
    nodePath: '',
    runId: 'root',
  });
  const run = root.runNode(wf, input, {useAsOutput: true}).then(
    () => channel.close(),
    (err) => channel.fail(err),
  );
  for await (const _event of channel) {
    // drain
  }
  await run;
}

const texts = (request: LlmRequest): string[] =>
  (request.contents ?? []).flatMap((c) =>
    (c.parts ?? []).map((p) => p.text ?? ''),
  );

describe('LlmAgent as a workflow node — request contents', () => {
  it('sees its node input once, not the user turn as well', async () => {
    requests.length = 0;
    const agent = new LlmAgent({
      name: 'agent',
      model: 'capture-1',
      instruction: 'answer',
    });
    const wf = new Workflow({name: 'wf', edges: [['START', agent]]});

    await drive(wf, 'hello');

    expect(requests).toHaveLength(1);
    expect(texts(requests[0])).toEqual(['hello']);
  });

  it('does not inherit a predecessor node output that emitted no content', async () => {
    requests.length = 0;
    const produce = node(
      (_c: NodeContext, value: string) =>
        createEvent({output: `wrapped:${value}`}),
      {name: 'produce'},
    );
    const agent = new LlmAgent({
      name: 'agent',
      model: 'capture-1',
      instruction: 'answer',
    });
    const wf = new Workflow({name: 'wf', edges: [['START', produce, agent]]});

    await drive(wf, 'hello');

    expect(requests).toHaveLength(1);
    expect(texts(requests[0])).toEqual(['wrapped:hello']);
  });

  it('honours an explicit includeContents', async () => {
    requests.length = 0;
    const agent = new LlmAgent({
      name: 'agent',
      model: 'capture-1',
      instruction: 'answer',
      includeContents: 'default',
    });
    const wf = new Workflow({name: 'wf', edges: [['START', agent]]});

    await drive(wf, 'hello');

    expect(agent.includeContents).toBe('default');
    expect(texts(requests[0])).toContain('hello');
  });
});
