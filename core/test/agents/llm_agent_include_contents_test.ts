/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v4';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {SequentialAgent} from '../../src/agents/sequential_agent.js';
import {Event} from '../../src/events/event.js';
import {BaseLlm} from '../../src/models/base_llm.js';
import type {BaseLlmConnection} from '../../src/models/base_llm_connection.js';
import type {LlmRequest} from '../../src/models/llm_request.js';
import type {LlmResponse} from '../../src/models/llm_response.js';
import {InMemoryRunner} from '../../src/runner/in_memory_runner.js';
import {FunctionTool} from '../../src/tools/function_tool.js';

const USER_ID = 'test_user';

/** Answers each request with the next scripted part and records the request. */
class ScriptedLlm extends BaseLlm {
  readonly requests: Array<Pick<LlmRequest, 'contents' | 'config'>> = [];
  private next = 0;

  constructor(private readonly responses: Part[]) {
    super({model: 'scripted-llm'});
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push({
      contents: structuredClone(llmRequest.contents),
      config: {...llmRequest.config},
    });
    const part = this.responses[this.next++];
    if (!part) {
      throw new Error(`No scripted response left for request ${this.next}.`);
    }
    yield {content: {role: 'model', parts: [part]}};
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('Live connections are not supported.');
  }
}

/** Reduces request contents to role and text or function call/response. */
function simplifyContents(contents: Content[]): Array<[string, unknown]> {
  return contents.flatMap((content) =>
    (content.parts ?? []).map((part): [string, unknown] => {
      const role = content.role ?? '';
      if (part.functionCall) {
        const {name, args} = part.functionCall;
        return [role, {functionCall: {name, args}}];
      }
      if (part.functionResponse) {
        const {name, response} = part.functionResponse;
        return [role, {functionResponse: {name, response}}];
      }
      return [role, part.text];
    }),
  );
}

/** Builds the scripted model's call to the `simple_tool` tool. */
function toolCall(message: string): Part {
  return {functionCall: {name: 'simple_tool', args: {message}}};
}

/** The simplified call of `simple_tool` as it appears in request contents. */
function simplifiedToolCall(message: string): [string, unknown] {
  return ['model', {functionCall: {name: 'simple_tool', args: {message}}}];
}

/** The simplified response of `simple_tool` as it appears in request contents. */
function simplifiedToolResponse(message: string): [string, unknown] {
  return [
    'user',
    {
      functionResponse: {
        name: 'simple_tool',
        response: {result: `Tool processed: ${message}`},
      },
    },
  ];
}

/** A tool that echoes its message back. */
function createSimpleTool() {
  return new FunctionTool({
    name: 'simple_tool',
    description: 'Processes a message.',
    parameters: z.object({message: z.string()}),
    execute: ({message}) => ({result: `Tool processed: ${message}`}),
  });
}

/** Runs one user turn per message in a single session and returns all events. */
async function runTurns({
  runner,
  messages,
}: {
  runner: InMemoryRunner;
  messages: string[];
}): Promise<Event[]> {
  const session = await runner.sessionService.createSession({
    appName: runner.appName,
    userId: USER_ID,
  });
  const events: Event[] = [];
  for (const text of messages) {
    for await (const event of runner.runAsync({
      userId: USER_ID,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text}]},
    })) {
      events.push(event);
    }
  }
  return events;
}

describe('LlmAgent includeContents', () => {
  it('sends the whole conversation, tool calls included, by default', async () => {
    const model = new ScriptedLlm([
      toolCall('first'),
      {text: 'First response'},
      toolCall('second'),
      {text: 'Second response'},
    ]);
    const agent = new LlmAgent({
      name: 'test_agent',
      model,
      includeContents: 'default',
      instruction: 'You are a helpful assistant',
      tools: [createSimpleTool()],
    });

    await runTurns({
      runner: new InMemoryRunner({agent}),
      messages: ['First message', 'Second message'],
    });

    expect(model.requests).toHaveLength(4);
    expect(simplifyContents(model.requests[0].contents)).toEqual([
      ['user', 'First message'],
    ]);
    expect(simplifyContents(model.requests[1].contents)).toEqual([
      ['user', 'First message'],
      simplifiedToolCall('first'),
      simplifiedToolResponse('first'),
    ]);
    expect(simplifyContents(model.requests[2].contents)).toEqual([
      ['user', 'First message'],
      simplifiedToolCall('first'),
      simplifiedToolResponse('first'),
      ['model', 'First response'],
      ['user', 'Second message'],
    ]);
    expect(simplifyContents(model.requests[3].contents)).toEqual([
      ['user', 'First message'],
      simplifiedToolCall('first'),
      simplifiedToolResponse('first'),
      ['model', 'First response'],
      ['user', 'Second message'],
      simplifiedToolCall('second'),
      simplifiedToolResponse('second'),
    ]);
  });

  it("sends only the current turn, tool calls included, when set to 'none'", async () => {
    const model = new ScriptedLlm([
      toolCall('first'),
      {text: 'First response'},
      {text: 'Second response'},
    ]);
    const agent = new LlmAgent({
      name: 'test_agent',
      model,
      includeContents: 'none',
      instruction: 'You are a helpful assistant',
      tools: [createSimpleTool()],
    });

    await runTurns({
      runner: new InMemoryRunner({agent}),
      messages: ['First message', 'Second message'],
    });

    expect(model.requests).toHaveLength(3);
    expect(simplifyContents(model.requests[0].contents)).toEqual([
      ['user', 'First message'],
    ]);
    expect(simplifyContents(model.requests[1].contents)).toEqual([
      ['user', 'First message'],
      simplifiedToolCall('first'),
      simplifiedToolResponse('first'),
    ]);
    expect(simplifyContents(model.requests[2].contents)).toEqual([
      ['user', 'Second message'],
    ]);
    expect(model.requests[0].config?.systemInstruction).toContain(
      'You are a helpful assistant',
    );
    expect(model.requests[0].config?.tools?.length).toBeGreaterThan(0);
  });

  it("shows a second sequential agent set to 'none' only the first agent's output", async () => {
    const agent1Model = new ScriptedLlm([{text: 'Agent1 response: XYZ'}]);
    const agent2Model = new ScriptedLlm([{text: 'Agent2 final response'}]);
    const agent1 = new LlmAgent({
      name: 'agent1',
      model: agent1Model,
      instruction: 'You are Agent1',
    });
    const agent2 = new LlmAgent({
      name: 'agent2',
      model: agent2Model,
      includeContents: 'none',
      instruction: 'You are Agent2',
    });
    const sequentialAgent = new SequentialAgent({
      name: 'sequential_test_agent',
      subAgents: [agent1, agent2],
    });

    const events = await runTurns({
      runner: new InMemoryRunner({agent: sequentialAgent}),
      messages: ['Original user request'],
    });

    expect(events.map((event) => event.author)).toEqual(['agent1', 'agent2']);
    expect(simplifyContents(agent1Model.requests[0].contents)).toContainEqual([
      'user',
      'Original user request',
    ]);
    const agent2Texts = JSON.stringify(
      simplifyContents(agent2Model.requests[0].contents),
    );
    expect(agent2Texts).not.toContain('Original user request');
    expect(agent2Texts).toContain('Agent1 response');
  });
});
