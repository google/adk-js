/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event,
  FunctionTool,
  Gemini,
  InMemoryRunner,
  LlmAgent,
  StreamingMode,
} from '@google/adk';
import {
  Candidate,
  Content,
  createUserContent,
  FinishReason,
  GenerateContentParameters,
  GenerateContentResponse,
  GoogleGenAI,
  Part,
} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

/**
 * Gemini 3 streams parallel function calls one per chunk and puts the
 * thoughtSignature only on the first call. These tests drive a full agent run
 * in the default (non-progressive) SSE mode with streams of that shape, and
 * check what the agent executes, what it stores and what it sends back to the
 * model on the next request.
 */

type Chunk = Part[] | Candidate;

/** A Gemini model that streams scripted chunks and records each request. */
class StreamingGemini extends Gemini {
  readonly requests: Content[][] = [];
  private turn = 0;

  constructor(private readonly turns: Chunk[][]) {
    super({apiKey: 'test-key', model: 'gemini-3-flash-preview'});
  }

  override get apiClient(): GoogleGenAI {
    return {
      vertexai: false,
      models: {
        generateContentStream: async (params: GenerateContentParameters) => {
          this.requests.push(structuredClone(params.contents as Content[]));
          const chunks = this.turns[this.turn++];
          if (!chunks) {
            throw new Error(`Unexpected model call #${this.turn}`);
          }
          return (async function* () {
            for (const chunk of chunks) {
              const candidate: Candidate = Array.isArray(chunk)
                ? {content: {role: 'model', parts: chunk}}
                : chunk;
              const response = new GenerateContentResponse();
              response.candidates = [structuredClone(candidate)];
              yield response;
            }
          })();
        },
      },
    } as unknown as GoogleGenAI;
  }
}

function call(name: string, city: string, thoughtSignature?: string): Part {
  return {
    functionCall: {name, args: {city}},
    ...(thoughtSignature ? {thoughtSignature} : {}),
  };
}

const STOP: Candidate = {
  content: {role: 'model', parts: [{text: ''}]},
  finishReason: FinishReason.STOP,
};

function finalText(text: string): Chunk[] {
  return [
    {
      content: {role: 'model', parts: [{text}]},
      finishReason: FinishReason.STOP,
    },
  ];
}

/** Summarizes contents as `role: part | part` lines. */
function summarize(contents: Content[]): string[] {
  return contents.map(
    (content) =>
      `${content.role}: ` +
      (content.parts ?? [])
        .map((p) => {
          if (p.functionCall) {
            const sig = p.thoughtSignature ? `+${p.thoughtSignature}` : '';
            return `call ${p.functionCall.name}(${p.functionCall.args?.city})${sig}`;
          }
          if (p.functionResponse) {
            return `response ${p.functionResponse.name}`;
          }
          return `${p.thought ? 'thought' : 'text'} ${p.text}`;
        })
        .join(' | '),
  );
}

async function runConversation(turns: Chunk[][], prompts: string[]) {
  const executed: string[] = [];
  const tool = (name: string) =>
    new FunctionTool({
      name,
      description: name,
      parameters: z.object({city: z.string()}),
      execute: ({city}) => {
        executed.push(`${name}(${city})`);
        return {city, ok: true};
      },
    });
  const model = new StreamingGemini(turns);
  const agent = new LlmAgent({
    name: 'travel_agent',
    model,
    tools: [tool('get_weather'), tool('get_time')],
  });
  const runner = new InMemoryRunner({agent, appName: 'parallel_calls'});
  const session = await runner.sessionService.createSession({
    appName: 'parallel_calls',
    userId: 'user',
  });

  const events: Event[] = [];
  for (const prompt of prompts) {
    for await (const event of runner.runAsync({
      userId: 'user',
      sessionId: session.id,
      newMessage: createUserContent(prompt),
      runConfig: {streamingMode: StreamingMode.SSE},
    })) {
      events.push(event);
    }
  }
  const stored = await runner.sessionService.getSession({
    appName: 'parallel_calls',
    userId: 'user',
    sessionId: session.id,
  });
  return {executed, events, storedEvents: stored!.events, model};
}

function callEvents(events: Event[]) {
  return events.filter((e) => e.content?.parts?.some((p) => p.functionCall));
}

describe('Parallel function calls under StreamingMode.SSE', () => {
  it('runs each call once and replays the calls as one model content with a single signature', async () => {
    const {executed, events, storedEvents, model} = await runConversation(
      [
        [
          [{text: 'Looking up both cities.', thought: true}],
          [call('get_weather', 'Paris', 'sig-1')],
          [call('get_time', 'Paris')],
          [call('get_weather', 'Lima')],
          STOP,
        ],
        finalText('Paris is sunny.'),
        finalText('Go to Paris.'),
      ],
      ['Weather and time for Paris and Lima?', 'Where should I go?'],
    );

    expect(executed).toEqual([
      'get_weather(Paris)',
      'get_time(Paris)',
      'get_weather(Lima)',
    ]);

    expect(callEvents(events).filter((e) => e.partial)).toEqual([]);
    expect(callEvents(events)).toHaveLength(1);
    expect(callEvents(storedEvents)).toHaveLength(1);

    const replayedTurn = [
      'model: thought Looking up both cities.',
      'model: call get_weather(Paris)+sig-1 | call get_time(Paris) | call get_weather(Lima)',
      'user: response get_weather | response get_time | response get_weather',
    ];
    // Request after the tools ran, and the next turn's request, which replays
    // the stored history.
    expect(summarize(model.requests[1])).toEqual([
      'user: text Weather and time for Paris and Lima?',
      ...replayedTurn,
    ]);
    expect(summarize(model.requests[2])).toEqual([
      'user: text Weather and time for Paris and Lima?',
      ...replayedTurn,
      'model: text Paris is sunny.',
      'user: text Where should I go?',
    ]);
  });

  it('keeps text streamed before the calls in its own content', async () => {
    const {executed, model} = await runConversation(
      [
        [
          [{text: 'I will check '}],
          [{text: 'both cities.'}],
          [call('get_weather', 'Berlin', 'sig-1')],
          [call('get_weather', 'Madrid')],
          STOP,
        ],
        finalText('Both are sunny.'),
      ],
      ['Weather in Berlin and Madrid?'],
    );

    expect(executed).toEqual(['get_weather(Berlin)', 'get_weather(Madrid)']);
    expect(summarize(model.requests[1])).toEqual([
      'user: text Weather in Berlin and Madrid?',
      'model: text I will check both cities.',
      'model: call get_weather(Berlin)+sig-1 | call get_weather(Madrid)',
      'user: response get_weather | response get_weather',
    ]);
  });

  it('still runs the held calls once when the stream ends with a non-STOP finish reason', async () => {
    const {executed, events, model} = await runConversation(
      [
        [
          [call('get_weather', 'Oslo', 'sig-1')],
          [call('get_time', 'Oslo')],
          {
            content: {role: 'model', parts: [{text: ''}]},
            finishReason: FinishReason.MAX_TOKENS,
          },
        ],
        finalText('Oslo is cold.'),
      ],
      ['Weather and time in Oslo?'],
    );

    expect(executed).toEqual(['get_weather(Oslo)', 'get_time(Oslo)']);
    const [callEvent] = callEvents(events);
    expect(callEvents(events)).toHaveLength(1);
    expect(callEvent.partial).toBe(false);
    expect(callEvent.errorCode).toBe(FinishReason.MAX_TOKENS);
    expect(summarize(model.requests[1])).toEqual([
      'user: text Weather and time in Oslo?',
      'model: call get_weather(Oslo)+sig-1 | call get_time(Oslo)',
      'user: response get_weather | response get_time',
    ]);
  });
});
