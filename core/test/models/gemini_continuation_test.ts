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

  /** Queues one non-streaming response per request. */
  respond(...responses: GenerateContentResponse[]): void {
    this.responses.push(...responses);
  }

  /** Queues one streaming request, answered with `chunks`. */
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

interface ModelOutput {
  /** Shorthand for `parts: [{text}]`. */
  text?: string;
  parts?: Part[];
  usage?: GenerateContentResponseUsageMetadata;
}

/** A response with an explicit finish reason and continuation token. */
function modelResponse({
  text,
  parts = text !== undefined ? [{text}] : [],
  usage,
  finishReason,
  continuationToken,
}: ModelOutput & {
  finishReason?: FinishReason;
  continuationToken?: string;
}): GenerateContentResponse {
  const response = new GenerateContentResponse();
  response.candidates = [
    {
      content: parts.length > 0 ? {role: 'model', parts} : undefined,
      finishReason,
      continuationToken,
    },
  ];
  response.usageMetadata = usage;
  return response;
}

/** A response the model paused, to be resumed with `token`. */
function paused(token: string, output: ModelOutput = {}) {
  return modelResponse({
    ...output,
    finishReason: FinishReason.CONTINUATION,
    continuationToken: token,
  });
}

/** A response that ends the generation. */
function finished(output: ModelOutput) {
  return modelResponse({...output, finishReason: FinishReason.STOP});
}

/** A streamed chunk in the middle of a response. */
function chunk(output: ModelOutput) {
  return modelResponse(output);
}

function modelText(text: string): Content {
  return {role: 'model', parts: [{text}]};
}

function text(llmResponse: LlmResponse): string | undefined {
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

  function request(config: GenerateContentConfig = CONFIG) {
    return {
      contents: [QUESTION],
      config: {...config},
      liveConnectConfig: {},
      toolsDict: {},
    };
  }

  async function generate({
    stream,
    config,
  }: {
    stream: boolean;
    config?: GenerateContentConfig;
  }): Promise<LlmResponse[]> {
    const responses: LlmResponse[] = [];
    for await (const llmResponse of gemini.generateContentAsync(
      request(config),
      stream,
    )) {
      responses.push(llmResponse);
    }
    return responses;
  }

  describe('resuming', () => {
    it('resumes a paused generation and returns it as one response', async () => {
      api.respond(
        paused('token-1', {text: 'The answer is'}),
        finished({text: ' 42.'}),
      );

      const responses = await generate({stream: false});

      expect(responses).toHaveLength(1);
      expect(responses[0].content).toEqual(modelText('The answer is 42.'));
      expect(responses[0].finishReason).toBe(FinishReason.STOP);

      const [first, resumed] = api.requests;
      expect(first.config.continuationToken).toBeUndefined();
      expect(resumed.config.continuationToken).toBe('token-1');
      expect(resumed.contents).toEqual([QUESTION, modelText('The answer is')]);
    });

    it('resumes a paused stream as one aggregated stream', async () => {
      api.respondStream(
        chunk({text: 'The answer'}),
        paused('token-1', {text: ' is'}),
      );
      api.respondStream(finished({text: ' 42.'}));

      const responses = await generate({stream: true});

      expect(responses.map((r) => r.partial)).toEqual([
        true,
        true,
        true,
        false,
      ]);
      // A resumed pause is not the end of the generation, so no response
      // reports it.
      expect(responses.map((r) => r.finishReason)).not.toContain(
        FinishReason.CONTINUATION,
      );
      expect(responses.some((r) => r.errorCode)).toBe(false);

      const last = responses.at(-1)!;
      expect(text(last)).toBe('The answer is 42.');
      expect(last.finishReason).toBe(FinishReason.STOP);

      const resumed = api.requests[1];
      expect(resumed.config.continuationToken).toBe('token-1');
      expect(resumed.contents.at(-1)).toEqual(modelText('The answer is'));
    });

    it('resumes until complete when paused twice', async () => {
      api.respond(
        paused('token-1', {text: 'a'}),
        paused('token-2', {text: 'b'}),
        finished({text: 'c'}),
      );

      const responses = await generate({stream: false});

      expect(text(responses[0])).toBe('abc');
      expect(api.requests).toHaveLength(3);
      expect(api.requests[2].config.continuationToken).toBe('token-2');
      expect(api.requests[2].contents).toEqual([QUESTION, modelText('ab')]);
    });

    it('resumes a stream until complete when paused twice', async () => {
      api.respondStream(paused('token-1', {text: 'a'}));
      api.respondStream(paused('token-2', {text: 'b'}));
      api.respondStream(finished({text: 'c'}));

      const responses = await generate({stream: true});

      expect(text(responses.at(-1)!)).toBe('abc');
      expect(api.requests).toHaveLength(3);
      expect(api.requests[2].config.continuationToken).toBe('token-2');
      expect(api.requests[2].contents).toEqual([QUESTION, modelText('ab')]);
    });

    it('sends only the original contents after a pause without output', async () => {
      api.respond(paused('token-1'), finished({text: 'Done.'}));

      const responses = await generate({stream: false});

      expect(text(responses[0])).toBe('Done.');
      expect(api.requests[1].contents).toEqual([QUESTION]);
    });

    it('emits no empty response for a streamed pause without output', async () => {
      api.respondStream(paused('token-1'));
      api.respondStream(finished({text: 'Done.'}));

      const responses = await generate({stream: true});

      expect(responses.map((r) => r.partial)).toEqual([true, false]);
      expect(text(responses.at(-1)!)).toBe('Done.');
      expect(api.requests[1].contents).toEqual([QUESTION]);
    });

    it('emits no empty response for a streamed pause with only empty text', async () => {
      api.respondStream(paused('token-1', {text: ''}));
      api.respondStream(finished({text: 'Done.'}));

      const responses = await generate({stream: true});

      expect(responses.map((r) => r.partial)).toEqual([true, false]);
      expect(text(responses.at(-1)!)).toBe('Done.');
      expect(api.requests[1].contents).toEqual([QUESTION]);
    });

    it('keeps the request config when resuming', async () => {
      api.respond(paused('token-1', {text: 'a'}), finished({text: 'b'}));

      await generate({
        stream: false,
        config: {...CONFIG, httpOptions: {extraBody: {custom: 'value'}}},
      });

      const [first, resumed] = api.requests;
      expect(resumed.config).toEqual({
        ...first.config,
        continuationToken: 'token-1',
      });
    });

    it('sends a caller token first and replaces it on resume', async () => {
      api.respond(paused('token-1', {text: 'a'}), finished({text: 'b'}));

      await generate({
        stream: false,
        config: {...CONFIG, continuationToken: 'caller-token'},
      });

      expect(api.requests.map((r) => r.config.continuationToken)).toEqual([
        'caller-token',
        'token-1',
      ]);
    });

    it('sends one request for a stream that is not paused', async () => {
      api.respondStream(
        chunk({text: 'Hello'}),
        finished({text: ' world', usage: {totalTokenCount: 7}}),
      );

      const responses = await generate({stream: true});

      expect(api.requests).toHaveLength(1);
      expect(api.requests[0].config.continuationToken).toBeUndefined();
      const last = responses.at(-1)!;
      expect(text(last)).toBe('Hello world');
      expect(last.usageMetadata).toEqual({totalTokenCount: 7});
    });
  });

  describe('usage', () => {
    it('sums the usage of all requests', async () => {
      api.respond(
        paused('token-1', {
          text: 'The answer is',
          usage: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15,
            cachedContentTokenCount: 4,
            promptTokensDetails: [
              {modality: MediaModality.TEXT, tokenCount: 8},
              {modality: MediaModality.IMAGE, tokenCount: 2},
            ],
            toolUsePromptTokensDetails: [{tokenCount: 1}],
          },
        }),
        finished({
          text: ' 42.',
          usage: {
            promptTokenCount: 15,
            candidatesTokenCount: 3,
            totalTokenCount: 18,
            promptTokensDetails: [
              {modality: MediaModality.IMAGE, tokenCount: 1},
              {modality: MediaModality.TEXT, tokenCount: 14},
            ],
            toolUsePromptTokensDetails: [{tokenCount: 2}],
          },
        }),
      );

      const responses = await generate({stream: false});

      expect(responses[0].usageMetadata).toEqual({
        promptTokenCount: 25,
        candidatesTokenCount: 8,
        totalTokenCount: 33,
        // Only the first request reported cached tokens.
        cachedContentTokenCount: 4,
        // Counts of the same modality are summed, in first-seen order.
        promptTokensDetails: [
          {modality: MediaModality.TEXT, tokenCount: 22},
          {modality: MediaModality.IMAGE, tokenCount: 3},
        ],
        toolUsePromptTokensDetails: [{tokenCount: 3}],
      });
    });

    it('sums the usage of all streamed requests on the final response', async () => {
      api.respondStream(
        chunk({text: 'The answer'}),
        paused('token-1', {text: ' is', usage: {candidatesTokenCount: 5}}),
      );
      api.respondStream(
        finished({text: ' 42.', usage: {candidatesTokenCount: 3}}),
      );

      const responses = await generate({stream: true});

      expect(responses.at(-1)!.usageMetadata?.candidatesTokenCount).toBe(8);
    });
  });

  describe('merging parts', () => {
    it('joins signed text keeping the first signature', async () => {
      api.respond(
        paused('token-1', {
          parts: [{text: 'The answer is', thoughtSignature: 'first'}],
        }),
        finished({parts: [{text: ' 42.', thoughtSignature: 'second'}]}),
      );

      const responses = await generate({stream: false});

      expect(responses[0].content?.parts).toEqual([
        {text: 'The answer is 42.', thoughtSignature: 'first'},
      ]);
    });

    it('joins text keeping the resumed signature', async () => {
      api.respond(
        paused('token-1', {text: 'The answer is'}),
        finished({parts: [{text: ' 42.', thoughtSignature: 'signature'}]}),
      );

      const responses = await generate({stream: false});

      expect(responses[0].content?.parts).toEqual([
        {text: 'The answer is 42.', thoughtSignature: 'signature'},
      ]);
    });

    it('keeps a thought apart from the answer', async () => {
      const thought = {text: 'Thinking.', thought: true};
      api.respond(
        paused('token-1', {parts: [thought]}),
        finished({text: 'The answer is 42.'}),
      );

      const responses = await generate({stream: false});

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
        paused('token-1', {parts: [{text: 'Think', thought: true}]}),
        finished({parts: [{text: 'ing.', thought: true}, {text: '42.'}]}),
      );

      const responses = await generate({stream: false});

      expect(responses[0].content?.parts).toEqual([
        {text: 'Thinking.', thought: true},
        {text: '42.'},
      ]);
    });

    it('keeps a function call apart from text', async () => {
      const call = {functionCall: {name: 'lookup', args: {query: 'answer'}}};
      api.respond(
        paused('token-1', {parts: [{text: 'Let me check.'}, call]}),
        finished({text: '42.'}),
      );

      const responses = await generate({stream: false});

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
      const call = {functionCall: {name: 'lookup', args: {query: 'answer'}}};
      api.respondStream(chunk({parts: [call]}), paused('token-1'));
      api.respondStream(finished({text: 'Done.'}));

      const responses = await generate({stream: true});

      const emitted = responses
        .flatMap((r) => r.content?.parts ?? [])
        .find((part) => part.functionCall)?.functionCall;
      expect(emitted?.id).toMatch(/^adk-/);
      expect(api.requests[1].contents.at(-1)).toEqual({
        role: 'model',
        parts: [{functionCall: {name: 'lookup', args: {query: 'answer'}}}],
      });
    });

    it('keeps empty text apart', async () => {
      api.respond(
        paused('token-1', {parts: [{text: 'a'}, {text: ''}]}),
        finished({text: 'b'}),
      );

      const responses = await generate({stream: false});

      expect(responses[0].content?.parts).toEqual([
        {text: 'a'},
        {text: ''},
        {text: 'b'},
      ]);
    });
  });

  describe('stopping', () => {
    it('returns a pause without a token as is', async () => {
      api.respond(
        modelResponse({text: 'a', finishReason: FinishReason.CONTINUATION}),
      );

      const responses = await generate({stream: false});

      expect(api.requests).toHaveLength(1);
      expect(text(responses[0])).toBe('a');
      expect(responses[0].finishReason).toBe(FinishReason.CONTINUATION);
    });

    it('ends a stream paused without a token with CONTINUATION', async () => {
      api.respondStream(
        modelResponse({text: 'a', finishReason: FinishReason.CONTINUATION}),
      );

      const responses = await generate({stream: true});

      expect(api.requests).toHaveLength(1);
      const last = responses.at(-1)!;
      expect(text(last)).toBe('a');
      expect(last.finishReason).toBe(FinishReason.CONTINUATION);
      expect(last.errorCode).toBe(FinishReason.CONTINUATION);
    });

    it('returns a pause with an empty token as is', async () => {
      api.respond(paused('', {text: 'a'}));

      const responses = await generate({stream: false});

      expect(api.requests).toHaveLength(1);
      expect(text(responses[0])).toBe('a');
    });

    it('stops resuming when the model repeats its token', async () => {
      api.respond(
        paused('token-1', {text: 'a'}),
        paused('token-1', {text: 'b'}),
      );

      const responses = await generate({stream: false});

      expect(api.requests).toHaveLength(2);
      expect(text(responses[0])).toBe('ab');
    });

    it('ends a stream with CONTINUATION when the model repeats its token', async () => {
      api.respondStream(paused('token-1', {text: 'a'}));
      api.respondStream(paused('token-1', {text: 'b'}));

      const responses = await generate({stream: true});

      expect(api.requests).toHaveLength(2);
      const last = responses.at(-1)!;
      expect(text(last)).toBe('ab');
      expect(last.errorCode).toBe(FinishReason.CONTINUATION);
    });

    it('stops after the maximum number of resumes', async () => {
      for (let i = 0; i <= MAX_RESUMES; i++) {
        api.respond(paused(`token-${i}`, {text: 'a'}));
      }

      const responses = await generate({stream: false});

      expect(api.requests).toHaveLength(MAX_RESUMES + 1);
      expect(text(responses[0])).toBe('a'.repeat(MAX_RESUMES + 1));
      expect(responses[0].finishReason).toBe(FinishReason.CONTINUATION);
    });

    it('stops a stream after the maximum number of resumes', async () => {
      for (let i = 0; i <= MAX_RESUMES; i++) {
        api.respondStream(paused(`token-${i}`, {text: 'a'}));
      }

      const responses = await generate({stream: true});

      expect(api.requests).toHaveLength(MAX_RESUMES + 1);
      const last = responses.at(-1)!;
      expect(text(last)).toBe('a'.repeat(MAX_RESUMES + 1));
      expect(last.errorCode).toBe(FinishReason.CONTINUATION);
    });

    it('sends no further request when a stream is abandoned before resuming', async () => {
      api.respondStream(paused('token-1', {text: 'a'}));
      api.respondStream(finished({text: 'b'}));

      const generator = gemini.generateContentAsync(request(), true);
      await generator.next();
      await generator.return();

      expect(api.requests).toHaveLength(1);
    });

    it('throws when the resume request fails', async () => {
      api.respond(paused('token-1', {text: 'a'}));
      api.respondWithError(new Error('fake 400'));

      await expect(generate({stream: false})).rejects.toThrow('fake 400');
      expect(api.requests).toHaveLength(2);
    });
  });
});
