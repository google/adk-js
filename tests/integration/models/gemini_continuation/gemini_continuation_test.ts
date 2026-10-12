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
  LlmAgentConfig,
  StreamingMode,
} from '@google/adk';
import {
  Content,
  createUserContent,
  FinishReason,
  HttpOptions,
  Part,
} from '@google/genai';
import http from 'node:http';
import {AddressInfo} from 'node:net';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';

/** A request the fake Gemini API received. */
interface RecordedRequest {
  path: string;
  body: {contents: Content[]; continuationToken?: string};
}

type RawResponse = Record<string, unknown>;

/**
 * A local HTTP server standing in for the Gemini API. It records each request
 * and answers it with the next canned response, as JSON or as an SSE stream.
 */
class FakeGeminiApi {
  readonly requests: RecordedRequest[] = [];
  private readonly responses: Array<
    {stream: false; body: RawResponse} | {stream: true; chunks: RawResponse[]}
  > = [];
  private server?: http.Server;

  async start(): Promise<string> {
    this.server = http.createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
      }
      this.requests.push({path: request.url ?? '', body: JSON.parse(body)});
      const next = this.responses.shift();
      if (!next) {
        response.writeHead(500, {'content-type': 'application/json'});
        response.end(
          JSON.stringify({error: {code: 500, message: 'No canned response.'}}),
        );
        return;
      }
      if (next.stream) {
        response.writeHead(200, {'content-type': 'text/event-stream'});
        for (const chunk of next.chunks) {
          response.write(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
        }
        response.end();
      } else {
        response.writeHead(200, {'content-type': 'application/json'});
        response.end(JSON.stringify(next.body));
      }
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', resolve),
    );
    const {port} = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }

  reset(): void {
    this.requests.length = 0;
    this.responses.length = 0;
  }

  respond(...bodies: RawResponse[]): void {
    for (const body of bodies) {
      this.responses.push({stream: false, body});
    }
  }

  respondStream(...chunks: RawResponse[]): void {
    this.responses.push({stream: true, chunks});
  }
}

/** A Gemini model that sends its requests to the fake API. */
class LocalGemini extends Gemini {
  constructor(private readonly baseUrl: string) {
    super({model: 'gemini-2.5-flash', apiKey: 'test-key', vertexai: false});
  }

  protected override getHttpOptions(): HttpOptions {
    return {...super.getHttpOptions(), baseUrl: this.baseUrl};
  }
}

function candidateResponse(
  parts: Part[],
  finishReason?: FinishReason,
  continuationToken?: string,
  usageMetadata?: RawResponse,
): RawResponse {
  return {
    candidates: [
      {
        content: parts.length > 0 ? {role: 'model', parts} : undefined,
        finishReason,
        continuationToken,
      },
    ],
    usageMetadata,
  };
}

function paused(token: string, parts: Part[], usage?: RawResponse) {
  return candidateResponse(parts, FinishReason.CONTINUATION, token, usage);
}

function finished(parts: Part[], usage?: RawResponse) {
  return candidateResponse(parts, FinishReason.STOP, undefined, usage);
}

function chunk(parts: Part[]) {
  return candidateResponse(parts);
}

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Returns the weather in a city.',
  parameters: z.object({city: z.string()}),
  execute: ({city}) => `Sunny in ${city}.`,
});

describe('Gemini continuation through the runner', () => {
  const api = new FakeGeminiApi();
  let baseUrl: string;

  beforeAll(async () => {
    baseUrl = await api.start();
  });

  afterAll(async () => {
    await api.stop();
  });

  beforeEach(() => {
    api.reset();
  });

  async function createSession(agent: LlmAgent) {
    const runner = new InMemoryRunner({agent, appName: agent.name});
    const session = await runner.sessionService.createSession({
      appName: agent.name,
      userId: 'user',
    });
    return {
      async run(prompt: string, streamingMode = StreamingMode.NONE) {
        const events: Event[] = [];
        for await (const event of runner.runAsync({
          userId: 'user',
          sessionId: session.id,
          newMessage: createUserContent(prompt),
          runConfig: {streamingMode},
        })) {
          events.push(event);
        }
        return events;
      },
      async history() {
        const stored = await runner.sessionService.getSession({
          appName: agent.name,
          userId: 'user',
          sessionId: session.id,
        });
        return stored!.events;
      },
    };
  }

  function createAgent(tools: LlmAgentConfig['tools'] = []) {
    return new LlmAgent({
      name: 'continuation_agent',
      model: new LocalGemini(baseUrl),
      instruction: 'Answer the question.',
      tools,
    });
  }

  it('resumes a paused generation and stores it as one model turn', async () => {
    api.respond(
      paused('dG9rZW4tMQ==', [{text: 'The answer is'}], {
        promptTokenCount: 10,
        candidatesTokenCount: 3,
        totalTokenCount: 13,
      }),
      finished([{text: ' 42.'}], {
        promptTokenCount: 14,
        candidatesTokenCount: 2,
        totalTokenCount: 16,
      }),
    );
    const session = await createSession(createAgent());

    const events = await session.run('What is the answer?');

    expect(api.requests.map((r) => r.path)).toEqual([
      expect.stringContaining('models/gemini-2.5-flash:generateContent'),
      expect.stringContaining('models/gemini-2.5-flash:generateContent'),
    ]);
    expect(api.requests[0].body.continuationToken).toBeUndefined();
    expect(api.requests[1].body.continuationToken).toBe('dG9rZW4tMQ==');
    expect(api.requests[1].body.contents.at(-1)).toEqual({
      role: 'model',
      parts: [{text: 'The answer is'}],
    });

    expect(events).toHaveLength(1);
    expect(events[0].content?.parts).toEqual([{text: 'The answer is 42.'}]);
    expect(events[0].finishReason).toBe(FinishReason.STOP);
    expect(events[0].errorCode).toBeUndefined();
    expect(events[0].usageMetadata).toMatchObject({
      promptTokenCount: 24,
      candidatesTokenCount: 5,
      totalTokenCount: 29,
    });

    const history = await session.history();
    expect(history.map((e) => e.content?.parts)).toEqual([
      [{text: 'What is the answer?'}],
      [{text: 'The answer is 42.'}],
    ]);
  });

  it('resumes a paused SSE stream as one stream and sends the merged turn next time', async () => {
    api.respondStream(
      chunk([{text: 'The answer'}]),
      paused('dG9rZW4tMQ==', [{text: ' is'}], {candidatesTokenCount: 3}),
    );
    api.respondStream(finished([{text: ' 42.'}], {candidatesTokenCount: 2}));
    api.respondStream(finished([{text: 'You are welcome.'}]));
    const session = await createSession(createAgent());

    const events = await session.run('What is the answer?', StreamingMode.SSE);

    expect(api.requests.map((r) => r.path)).toEqual([
      expect.stringContaining(':streamGenerateContent?alt=sse'),
      expect.stringContaining(':streamGenerateContent?alt=sse'),
    ]);
    expect(api.requests[1].body.continuationToken).toBe('dG9rZW4tMQ==');
    expect(api.requests[1].body.contents.at(-1)).toEqual({
      role: 'model',
      parts: [{text: 'The answer is'}],
    });

    expect(events.map((e) => e.partial)).toEqual([true, true, true, false]);
    // A resumed pause is not the end of the generation, so no event reports it.
    expect(events.map((e) => e.finishReason)).not.toContain(
      FinishReason.CONTINUATION,
    );
    expect(events.some((e) => e.errorCode)).toBe(false);
    const final = events.at(-1)!;
    expect(final.content?.parts).toEqual([{text: 'The answer is 42.'}]);
    expect(final.finishReason).toBe(FinishReason.STOP);
    expect(final.usageMetadata?.candidatesTokenCount).toBe(5);

    // Partial events are not stored, so the next turn sends the merged answer
    // once and starts a new generation.
    await session.run('Thanks!', StreamingMode.SSE);

    expect(api.requests).toHaveLength(3);
    expect(api.requests[2].body.continuationToken).toBeUndefined();
    expect(api.requests[2].body.contents).toEqual([
      {role: 'user', parts: [{text: 'What is the answer?'}]},
      {role: 'model', parts: [{text: 'The answer is 42.'}]},
      {role: 'user', parts: [{text: 'Thanks!'}]},
    ]);
  });

  it('runs a function call generated after a pause and does not resume the next call', async () => {
    api.respond(
      paused('dG9rZW4tMQ==', [{text: 'Checking the weather.'}]),
      finished([{functionCall: {name: 'get_weather', args: {city: 'Paris'}}}]),
      finished([{text: 'It is sunny in Paris.'}]),
    );
    const session = await createSession(createAgent([getWeather]));

    const events = await session.run('What is the weather in Paris?');

    expect(api.requests).toHaveLength(3);
    expect(api.requests[1].body.continuationToken).toBe('dG9rZW4tMQ==');
    // The call after the tool ran is a new generation.
    expect(api.requests[2].body.continuationToken).toBeUndefined();
    const [, modelTurn, toolTurn] = api.requests[2].body.contents;
    expect(modelTurn).toEqual({
      role: 'model',
      parts: [
        {text: 'Checking the weather.'},
        {functionCall: {name: 'get_weather', args: {city: 'Paris'}}},
      ],
    });
    expect(toolTurn.parts?.[0].functionResponse).toMatchObject({
      name: 'get_weather',
      response: {result: 'Sunny in Paris.'},
    });

    expect(events.map((e) => e.content?.parts?.map(Object.keys))).toEqual([
      [['text'], ['functionCall']],
      [['functionResponse']],
      [['text']],
    ]);
    expect(events.at(-1)!.content?.parts?.[0].text).toBe(
      'It is sunny in Paris.',
    );
  });

  it('returns the output so far when the model repeats its token', async () => {
    api.respond(
      paused('dG9rZW4tMQ==', [{text: 'a'}]),
      paused('dG9rZW4tMQ==', [{text: 'b'}]),
    );
    const session = await createSession(createAgent());

    const events = await session.run('Go.');

    expect(api.requests).toHaveLength(2);
    expect(events).toHaveLength(1);
    expect(events[0].content?.parts).toEqual([{text: 'ab'}]);
    expect(events[0].finishReason).toBe(FinishReason.CONTINUATION);
  });
});
