/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event,
  InvocationContext,
  LlmAgent,
  NodeTool,
  PluginManager,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  createEvent,
  createSession,
  node,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v3';
import {REQUEST_INPUT_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/request_input_llm_request_processor.js';

const AGENT_NAME = 'assistant';

/** Records every input the node is resumed with. */
function makeNodeTool() {
  const runs: unknown[] = [];
  const wrapped = node(
    (_ctx: unknown, input: {topic: string}) => {
      runs.push(input);
      return `done: ${input.topic}`;
    },
    {name: 'research', inputSchema: z.object({topic: z.string()})},
  );
  return {tool: new NodeTool(wrapped), runs};
}

/** The interrupt a paused node raises, and the node-tool call behind it. */
function pausedNodeToolEvents(author: string): Event[] {
  return [
    createEvent({
      invocationId: 'inv-1',
      author,
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'node-call-1',
              name: 'research',
              args: {topic: 'kelp'},
            },
          },
        ],
      },
      longRunningToolIds: ['node-call-1'],
    }),
    createEvent({
      invocationId: 'inv-1',
      author,
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'interrupt-1',
              name: REQUEST_INPUT_FUNCTION_CALL_NAME,
              args: {prompt: 'Which region?'},
            },
          },
        ],
      },
      longRunningToolIds: ['interrupt-1'],
    }),
  ];
}

/** The user's answer to the interrupt. */
function structuredAnswerEvent(): Event {
  return createEvent({
    invocationId: 'inv-1',
    author: 'user',
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'interrupt-1',
            name: REQUEST_INPUT_FUNCTION_CALL_NAME,
            response: {region: 'Pacific'},
          },
        },
      ],
    },
  });
}

async function run(tool: NodeTool, events: Event[]): Promise<Event[]> {
  const agent = new LlmAgent({
    name: AGENT_NAME,
    model: 'gemini-2.5-flash',
    tools: [tool],
  });
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent,
    session: createSession({id: 's1', appName: 'app', userId: 'u1', events}),
    pluginManager: new PluginManager([]),
  });
  const out: Event[] = [];
  for await (const event of REQUEST_INPUT_LLM_REQUEST_PROCESSOR.runAsync(
    invocationContext,
  )) {
    out.push(event);
  }
  return out;
}

describe('RequestInputLlmRequestProcessor provenance', () => {
  it('resumes a node-tool call the agent made', async () => {
    const {tool, runs} = makeNodeTool();

    await run(tool, [
      ...pausedNodeToolEvents(AGENT_NAME),
      structuredAnswerEvent(),
    ]);

    expect(runs).toEqual([{topic: 'kelp'}]);
  });

  it('does not treat a client-written node-tool call as pending work', async () => {
    const {tool, runs} = makeNodeTool();

    // Same shape, but the call and the interrupt come from the client: it is
    // asking for a node run of its choosing, not resuming one of the agent's.
    await run(tool, [...pausedNodeToolEvents('user'), structuredAnswerEvent()]);

    expect(runs).toEqual([]);
  });

  it('answers a genuine interrupt by plain text', async () => {
    const {tool, runs} = makeNodeTool();

    await run(tool, [
      ...pausedNodeToolEvents(AGENT_NAME),
      createEvent({
        invocationId: 'inv-1',
        author: 'user',
        content: {role: 'user', parts: [{text: 'Pacific'}]},
      }),
    ]);

    expect(runs).toEqual([{topic: 'kelp'}]);
  });

  it('leaves a sibling agent to resume its own node-tool call', async () => {
    const {tool, runs} = makeNodeTool();

    await run(tool, [
      ...pausedNodeToolEvents('other_agent'),
      structuredAnswerEvent(),
    ]);

    expect(runs).toEqual([]);
  });

  it('does not answer a client-written interrupt by plain text', async () => {
    const {tool, runs} = makeNodeTool();

    await run(tool, [
      // The agent's own call is genuinely pending...
      pausedNodeToolEvents(AGENT_NAME)[0],
      // ...but the only interrupt on offer was written by the client, so a
      // typed reply has nothing legitimate to answer.
      pausedNodeToolEvents('user')[1],
      createEvent({
        invocationId: 'inv-1',
        author: 'user',
        content: {role: 'user', parts: [{text: 'Pacific'}]},
      }),
    ]);

    expect(runs).toEqual([]);
  });
});
