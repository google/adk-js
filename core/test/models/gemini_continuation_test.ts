/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Gemini, LlmResponse} from '@google/adk';
import {
  Content,
  FinishReason,
  GenerateContentConfig,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  GoogleGenAI,
  MediaModality,
  Part,
} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';

import {MAX_RESUMES} from '../../src/models/gemini_continuation.js';

const QUESTION: Content = {
  role: 'user',
  parts: [{text: 'What is the answer?'}],
};
const CONFIG: GenerateContentConfig = {temperature: 0.5};

interface RecordedRequest {
  contents: Content[];
  config: GenerateContentConfig;
}

/** A fake Gemini API that records each request and answers it in order. */
class FakeGeminiApi {
  readonly requests: RecordedRequest[] = [];
  private readonly responses: Array<
    GenerateContentResponse | GenerateContentResponse[] | Error
  > = [];

  respond(...responses: GenerateContentResponse[]): void {
    this.responses.push(...responses);
  }

  respondStream(...chunks: GenerateContentResponse[]): void {
    this.responses.push(chunks);
  }

  respondWithError(error: Error): void {
    this.responses.push(error);
  }

  private next(request: RecordedRequest) {
    this.requests.push(structuredClone(request));
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error('No canned response left.');
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }

  client(): GoogleGenAI {
    return {
      vertexai: false,
      models: {
        generateContent: async (req: RecordedRequest) =>
          this.next({contents: req.contents, config: req.config}),
        generateContentStream: async (req: RecordedRequest) => {
          const chunks = this.next({
            contents: req.contents,
            config: req.config,
          });
          return (async function* () {
            for (const chunk of chunks as GenerateContentResponse[]) {
              yield chunk;
            }
          })();
        },
      },
    } as unknown as GoogleGenAI;
  }
}

function response(
  finishReason: FinishReason | undefined,
  token: string | undefined,
  ...parts: Part[]
): GenerateContentResponse {
  const result = new GenerateContentResponse();
  result.candidates = [
    {
      content: parts.length > 0 ? {role: 'model', parts} : undefined,
      finishReason,
      continuationToken: token,
    },
  ];
  return result;
}

function paused(token: string, ...parts: Part[]) {
  return response(FinishReason.CONTINUATION, token, ...parts);
}

function finished(...parts: Part[]) {
  return response(FinishReason.STOP, undefined, ...parts);
}

function chunk(...parts: Part[]) {
  return response(undefined, undefined, ...parts);
}

function withUsage(
  result: GenerateContentResponse,
  usage: GenerateContentResponseUsageMetadata,
): GenerateContentResponse {
  result.usageMetadata = usage;
  return result;
}

function modelText(text: string): Content {
  return {role: 'model', parts: [{text}]};
}

function firstText(llmResponse: LlmResponse): string | undefined {
  return llmResponse.content?.parts?.[0]?.text;
}

describe('Gemini continuation', () => {
  let api: FakeGeminiApi;
  let gemini: Gemini;

  beforeEach(() => {
    api = new FakeGeminiApi();
    gemini = new Gemini({apiKey: 'test-key', model: 'gemini-test-model'});
    const client = api.client();
    Object.defineProperty(gemini, 'apiClient', {get: () => client});
  });

  async function generate(
    stream: boolean,
    config: GenerateContentConfig = CONFIG,
  ): Promise<LlmResponse[]> {
    const responses: LlmResponse[] = [];
    for await (const llmResponse of gemini.generateContentAsync(
      {
        contents: [QUESTION],
        config: {...config},
        liveConnectConfig: {},
        toolsDict: {},
      },
      stream,
    )) {
      responses.push(llmResponse);
    }
    return responses;
  }

  it('resumes a paused generation and returns the whole generation', async () => {
    api.respond(
      withUsage(paused('c3RhdGU=', {text: 'The answer is'}), {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
        cachedContentTokenCount: 4,
        promptTokensDetails: [
          {modality: MediaModality.TEXT, tokenCount: 8},
          {modality: MediaModality.IMAGE, tokenCount: 2},
        ],
        toolUsePromptTokensDetails: [{tokenCount: 1}],
      }),
      withUsage(finished({text: ' 42.'}), {
        promptTokenCount: 15,
        candidatesTokenCount: 3,
        totalTokenCount: 18,
        promptTokensDetails: [
          {modality: MediaModality.IMAGE, tokenCount: 1},
          {modality: MediaModality.TEXT, tokenCount: 14},
        ],
        toolUsePromptTokensDetails: [{tokenCount: 2}],
      }),
    );

    const responses = await generate(false);

    expect(responses).toHaveLength(1);
    expect(responses[0].content).toEqual(modelText('The answer is 42.'));
    expect(responses[0].finishReason).toBe(FinishReason.STOP);
    expect(responses[0].usageMetadata).toEqual({
      promptTokenCount: 25,
      candidatesTokenCount: 8,
      totalTokenCount: 33,
      cachedContentTokenCount: 4,
      promptTokensDetails: [
        {modality: MediaModality.TEXT, tokenCount: 22},
        {modality: MediaModality.IMAGE, tokenCount: 3},
      ],
      toolUsePromptTokensDetails: [{tokenCount: 3}],
    });
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1].contents).toEqual([
      QUESTION,
      modelText('The answer is'),
    ]);
    expect(api.requests[1].config.continuationToken).toBe('c3RhdGU=');
    expect(api.requests[0].config.continuationToken).toBeUndefined();
  });

  it('resumes a paused stream in one aggregated stream', async () => {
    api.respondStream(
      chunk({text: 'The answer'}),
      withUsage(paused('state', {text: ' is'}), {candidatesTokenCount: 5}),
    );
    api.respondStream(
      withUsage(finished({text: ' 42.'}), {candidatesTokenCount: 3}),
    );

    const responses = await generate(true);

    expect(responses.map((r) => r.partial)).toEqual([true, true, true, false]);
    expect(responses.some((r) => r.errorCode)).toBe(false);
    // A pause is not the end of the generation, so no response reports it.
    expect(responses.map((r) => r.finishReason)).not.toContain(
      FinishReason.CONTINUATION,
    );
    const last = responses.at(-1)!;
    expect(firstText(last)).toBe('The answer is 42.');
    expect(last.finishReason).toBe(FinishReason.STOP);
    expect(last.usageMetadata?.candidatesTokenCount).toBe(8);
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1].contents.at(-1)).toEqual(modelText('The answer is'));
    expect(api.requests[1].config.continuationToken).toBe('state');
  });

  it('resumes until complete when paused twice', async () => {
    api.respond(
      paused('first', {text: 'a'}),
      paused('second', {text: 'b'}),
      finished({text: 'c'}),
    );

    const responses = await generate(false);

    expect(responses).toHaveLength(1);
    expect(firstText(responses[0])).toBe('abc');
    expect(api.requests).toHaveLength(3);
    expect(api.requests[2].contents).toEqual([QUESTION, modelText('ab')]);
    expect(api.requests[2].config.continuationToken).toBe('second');
  });

  it('resumes a stream until complete when paused twice', async () => {
    api.respondStream(paused('first', {text: 'a'}));
    api.respondStream(paused('second', {text: 'b'}));
    api.respondStream(finished({text: 'c'}));

    const responses = await generate(true);

    expect(firstText(responses.at(-1)!)).toBe('abc');
    expect(api.requests).toHaveLength(3);
    expect(api.requests[2].contents).toEqual([QUESTION, modelText('ab')]);
    expect(api.requests[2].config.continuationToken).toBe('second');
  });

  it('resumes with the original contents after a pause without output', async () => {
    api.respond(paused('state'), finished({text: 'Done.'}));

    const responses = await generate(false);

    expect(firstText(responses[0])).toBe('Done.');
    expect(api.requests[1].contents).toEqual([QUESTION]);
  });

  it('emits no empty response for a streamed pause without output', async () => {
    api.respondStream(paused('state'));
    api.respondStream(finished({text: 'Done.'}));

    const responses = await generate(true);

    expect(responses.map((r) => r.partial)).toEqual([true, false]);
    expect(firstText(responses.at(-1)!)).toBe('Done.');
    expect(api.requests[1].contents).toEqual([QUESTION]);
  });

  it('emits no empty response for a streamed pause with only a stream terminator', async () => {
    api.respondStream(paused('state', {text: ''}));
    api.respondStream(finished({text: 'Done.'}));

    const responses = await generate(true);

    expect(responses.map((r) => r.partial)).toEqual([true, false]);
    expect(firstText(responses.at(-1)!)).toBe('Done.');
    expect(api.requests[1].contents).toEqual([QUESTION]);
  });

  it('keeps the request config when resuming', async () => {
    api.respond(paused('state', {text: 'a'}), finished({text: 'b'}));

    await generate(false, {
      ...CONFIG,
      httpOptions: {extraBody: {custom: 'value'}},
    });

    expect(api.requests[1].config).toEqual({
      ...api.requests[0].config,
      continuationToken: 'state',
    });
  });

  it('sends a caller token first and replaces it on resume', async () => {
    api.respond(paused('next', {text: 'a'}), finished({text: 'b'}));

    await generate(false, {...CONFIG, continuationToken: 'caller'});

    expect(api.requests.map((r) => r.config.continuationToken)).toEqual([
      'caller',
      'next',
    ]);
  });

  it('joins signed text keeping the first signature', async () => {
    api.respond(
      paused('state', {text: 'The answer is', thoughtSignature: 'first'}),
      finished({text: ' 42.', thoughtSignature: 'second'}),
    );

    const responses = await generate(false);

    expect(responses[0].content?.parts).toEqual([
      {text: 'The answer is 42.', thoughtSignature: 'first'},
    ]);
  });

  it('joins text keeping the resumed signature', async () => {
    api.respond(
      paused('state', {text: 'The answer is'}),
      finished({text: ' 42.', thoughtSignature: 'sig'}),
    );

    const responses = await generate(false);

    expect(responses[0].content?.parts).toEqual([
      {text: 'The answer is 42.', thoughtSignature: 'sig'},
    ]);
  });

  it('keeps a thought apart from the answer', async () => {
    const thought = {text: 'Thinking.', thought: true};
    api.respond(
      paused('state', thought),
      finished({text: 'The answer is 42.'}),
    );

    const responses = await generate(false);

    expect(responses[0].content?.parts).toEqual([
      thought,
      {text: 'The answer is 42.'},
    ]);
    expect(api.requests[1].contents.at(-1)).toEqual({
      role: 'model',
      parts: [thought],
    });
  });

  it('joins a thought split by a pause', async () => {
    api.respond(
      paused('state', {text: 'Think', thought: true}),
      finished({text: 'ing.', thought: true}, {text: '42.'}),
    );

    const responses = await generate(false);

    expect(responses[0].content?.parts).toEqual([
      {text: 'Thinking.', thought: true},
      {text: '42.'},
    ]);
  });

  it('keeps a function call apart from text', async () => {
    const call = {functionCall: {name: 'lookup', args: {query: 'answer'}}};
    api.respond(
      paused('state', {text: 'Let me check.'}, call),
      finished({text: '42.'}),
    );

    const responses = await generate(false);

    expect(responses[0].content?.parts).toEqual([
      {text: 'Let me check.'},
      call,
      {text: '42.'},
    ]);
    expect(api.requests[1].contents.at(-1)).toEqual({
      role: 'model',
      parts: [{text: 'Let me check.'}, call],
    });
  });

  it('resends a streamed function call without its client id', async () => {
    api.respondStream(
      chunk({functionCall: {name: 'lookup', args: {q: 'x'}}}),
      paused('state'),
    );
    api.respondStream(finished({text: 'Done.'}));

    const responses = await generate(true);

    const call = responses
      .flatMap((r) => r.content?.parts ?? [])
      .find((part) => part.functionCall)?.functionCall;
    expect(call?.id).toMatch(/^adk-/);
    expect(api.requests[1].contents.at(-1)).toEqual({
      role: 'model',
      parts: [{functionCall: {name: 'lookup', args: {q: 'x'}}}],
    });
  });

  it('keeps empty text apart', async () => {
    api.respond(
      paused('state', {text: 'a'}, {text: ''}),
      finished({text: 'b'}),
    );

    const responses = await generate(false);

    expect(responses[0].content?.parts).toEqual([
      {text: 'a'},
      {text: ''},
      {text: 'b'},
    ]);
  });

  it('returns the output of a pause without a token', async () => {
    api.respond(response(FinishReason.CONTINUATION, undefined, {text: 'a'}));

    const responses = await generate(false);

    expect(api.requests).toHaveLength(1);
    expect(firstText(responses[0])).toBe('a');
    expect(responses[0].finishReason).toBe(FinishReason.CONTINUATION);
  });

  it('returns the output of a streamed pause without a token', async () => {
    api.respondStream(
      response(FinishReason.CONTINUATION, undefined, {text: 'a'}),
    );

    const responses = await generate(true);

    expect(api.requests).toHaveLength(1);
    const last = responses.at(-1)!;
    expect(firstText(last)).toBe('a');
    expect(last.finishReason).toBe(FinishReason.CONTINUATION);
    expect(last.errorCode).toBe(FinishReason.CONTINUATION);
  });

  it('returns the output of a pause with an empty token', async () => {
    api.respond(paused('', {text: 'a'}));

    const responses = await generate(false);

    expect(api.requests).toHaveLength(1);
    expect(firstText(responses[0])).toBe('a');
  });

  it('stops resuming on a repeated token', async () => {
    api.respond(paused('state', {text: 'a'}), paused('state', {text: 'b'}));

    const responses = await generate(false);

    expect(api.requests).toHaveLength(2);
    expect(firstText(responses[0])).toBe('ab');
  });

  it('ends a stream with CONTINUATION on a repeated token', async () => {
    api.respondStream(paused('state', {text: 'a'}));
    api.respondStream(paused('state', {text: 'b'}));

    const responses = await generate(true);

    expect(api.requests).toHaveLength(2);
    const last = responses.at(-1)!;
    expect(firstText(last)).toBe('ab');
    expect(last.errorCode).toBe(FinishReason.CONTINUATION);
  });

  it('stops after the maximum number of resumes', async () => {
    for (let i = 0; i <= MAX_RESUMES; i++) {
      api.respond(paused(`token${i}`, {text: 'a'}));
    }

    const responses = await generate(false);

    expect(api.requests).toHaveLength(MAX_RESUMES + 1);
    expect(firstText(responses[0])).toBe('a'.repeat(MAX_RESUMES + 1));
    expect(responses[0].finishReason).toBe(FinishReason.CONTINUATION);
  });

  it('stops a stream after the maximum number of resumes', async () => {
    for (let i = 0; i <= MAX_RESUMES; i++) {
      api.respondStream(paused(`token${i}`, {text: 'a'}));
    }

    const responses = await generate(true);

    expect(api.requests).toHaveLength(MAX_RESUMES + 1);
    const last = responses.at(-1)!;
    expect(firstText(last)).toBe('a'.repeat(MAX_RESUMES + 1));
    expect(last.errorCode).toBe(FinishReason.CONTINUATION);
  });

  it('sends no further request when a stream is abandoned before resuming', async () => {
    api.respondStream(paused('state', {text: 'a'}));
    api.respondStream(finished({text: 'b'}));

    const generator = gemini.generateContentAsync(
      {
        contents: [QUESTION],
        config: {...CONFIG},
        liveConnectConfig: {},
        toolsDict: {},
      },
      true,
    );
    await generator.next();
    await generator.return();

    expect(api.requests).toHaveLength(1);
  });

  it('throws when the resume request fails', async () => {
    api.respond(paused('state', {text: 'a'}));
    api.respondWithError(new Error('fake 400'));

    await expect(generate(false)).rejects.toThrow('fake 400');
    expect(api.requests).toHaveLength(2);
  });

  it('sends one request for a complete stream', async () => {
    const usage = {totalTokenCount: 7};
    api.respondStream(
      chunk({text: 'Hello'}),
      withUsage(finished({text: ' world'}), usage),
    );

    const responses = await generate(true);

    expect(api.requests).toHaveLength(1);
    expect(api.requests[0].config.continuationToken).toBeUndefined();
    const last = responses.at(-1)!;
    expect(firstText(last)).toBe('Hello world');
    expect(last.usageMetadata).toEqual(usage);
  });
});
