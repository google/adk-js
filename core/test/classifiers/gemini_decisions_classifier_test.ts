/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {PartMediaResolutionLevel} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  createBinary,
  createBinaryAnswer,
  createChoice,
  createChoiceAnswer,
  createRefusalAnswer,
  createScore,
  createScoreAnswer,
  GeminiDecisionsClassifier,
  isGeminiDecisionsClassifier,
  Question,
} from '../../src/index.js';
import {classifierClientLabel} from '../../src/utils/client_labels.js';

const ROUTE = createChoice({
  instructions: 'Which team should handle this?',
  criteria: {billing: 'Invoices and refunds', technical: null},
});
const URGENT = createBinary({
  instructions: 'Is this urgent?',
  criteria: 'Time-sensitive',
});
const FRUSTRATION = createScore({
  instructions: 'How frustrated is the customer?',
  criteria: ['Calm', 'Frustrated', 'Very angry'],
});

const CHOICE_ANSWER_PAYLOAD = {
  type: 'choice',
  choice: 'billing',
  probabilities: {billing: 0.9, technical: 0.1},
  confidence: 0.9,
};

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

class FakeFetchServer {
  readonly requests: RecordedRequest[] = [];
  private readonly responses: Response[];

  constructor(...responses: Response[]) {
    this.responses = [...responses];
  }

  readonly fetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url =
      typeof input === 'string' || input instanceof URL
        ? String(input)
        : input.url;
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const bodyText = typeof init?.body === 'string' ? init.body : '{}';
    this.requests.push({
      url,
      method,
      headers,
      body: JSON.parse(bodyText) as Record<string, unknown>,
    });
    const next = this.responses.shift();
    if (!next) {
      throw new Error('No queued response in FakeFetchServer.');
    }
    return next;
  };
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

function badRequest(code: string): Response {
  return jsonResponse({error: {code, message: 'Request blocked.'}}, 400);
}

function createClassifierWithServer(
  server: FakeFetchServer,
): GeminiDecisionsClassifier {
  return new GeminiDecisionsClassifier({
    apiKey: 'test-key',
    httpOptions: {
      apiVersion: 'v1beta',
      fetch: server.fetch,
    },
  });
}

describe('GeminiDecisionsClassifier', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends Choice, Binary, and Score questions in one Decisions API request', async () => {
    const server = new FakeFetchServer(
      jsonResponse({
        answers: {
          route: CHOICE_ANSWER_PAYLOAD,
          urgent: {type: 'noul', noul: 0.95, confidence: 0.95},
          frustration: {
            type: 'score',
            score: 1.05,
            legend: {'0': 'Calm', '1': 'Frustrated', '2': 'Very angry'},
            probabilities: {'0': 0.0, '1': 0.95, '2': 0.05},
            confidence: 0.95,
          },
        },
      }),
    );
    const classifier = createClassifierWithServer(server);
    expect(isGeminiDecisionsClassifier(classifier)).toBe(true);

    const response = await classifier.classify({
      input: 'I was charged twice!',
      questions: {
        route: ROUTE,
        urgent: URGENT,
        frustration: FRUSTRATION,
      },
    });

    expect(server.requests).toHaveLength(1);
    const req = server.requests[0];
    expect(req.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/decisions',
    );
    expect(req.headers.get('x-goog-api-key')).toBe('test-key');
    expect(req.headers.get('x-goog-api-client')?.split(' ')).toContain(
      classifierClientLabel('gemini'),
    );
    expect(req.body).toEqual({
      model: 'gemini-decision-1',
      input: 'I was charged twice!',
      questions: {
        route: {
          type: 'choice',
          instructions: 'Which team should handle this?',
          criteria: {billing: 'Invoices and refunds', technical: ''},
        },
        urgent: {
          type: 'noul',
          instructions: 'Is this urgent?',
          criteria: {true_description: 'Time-sensitive'},
        },
        frustration: {
          type: 'score',
          instructions: 'How frustrated is the customer?',
          criteria: ['Calm', 'Frustrated', 'Very angry'],
        },
      },
    });
    expect(response.answers).toEqual({
      route: createChoiceAnswer({
        choice: 'billing',
        probabilities: {billing: 0.9, technical: 0.1},
        confidence: 0.9,
      }),
      urgent: createBinaryAnswer({probability: 0.95, confidence: 0.95}),
      frustration: createScoreAnswer({
        score: 1.05,
        probabilities: {0: 0.0, 1: 0.95, 2: 0.05},
        confidence: 0.95,
      }),
    });
  });

  it('sends JSON input and criteria as JSON text', async () => {
    const server = new FakeFetchServer(
      jsonResponse({answers: {urgent: {type: 'noul', noul: 0.2}}}),
    );
    const classifier = createClassifierWithServer(server);

    await classifier.classify({
      input: {message: 'Héllo', priority: 2},
      questions: {
        urgent: createBinary({
          instructions: {ask: 'Is this urgent?'},
          criteria: ['p0', 'p1'],
        }),
      },
    });

    const body = server.requests[0].body;
    expect(body['input']).toBe('{"message":"Héllo","priority":2}');
    expect(body['questions']).toEqual({
      urgent: {
        type: 'noul',
        instructions: '{"ask":"Is this urgent?"}',
        criteria: {true_description: '["p0","p1"]'},
      },
    });
  });

  it('sends multimodal Content as typed Decisions API input blocks', async () => {
    const server = new FakeFetchServer(
      jsonResponse({answers: {urgent: {type: 'noul', noul: 0.5}}}),
    );
    const classifier = createClassifierWithServer(server);

    await classifier.classify({
      input: {
        role: 'user',
        parts: [
          {text: 'What is in this photo?'},
          {
            inlineData: {data: 'cG5nLWJ5dGVz', mimeType: 'image/png'},
            mediaResolution: {
              level: PartMediaResolutionLevel.MEDIA_RESOLUTION_LOW,
            },
          },
          {
            fileData: {
              fileUri: 'https://example.com/clip.mp4',
              mimeType: 'video/mp4',
            },
          },
          {
            inlineData: {data: 'JVBERg==', mimeType: 'application/pdf'},
          },
          {
            inlineData: {data: 'cG5n', mimeType: 'image/png'},
            mediaResolution: {
              level: 'toString' as unknown as PartMediaResolutionLevel,
            },
          },
        ],
      },
      questions: {urgent: createBinary({instructions: 'Is this urgent?'})},
    });

    expect(server.requests[0].body['input']).toEqual([
      {type: 'text', text: 'What is in this photo?'},
      {
        type: 'image',
        data: 'cG5nLWJ5dGVz',
        mime_type: 'image/png',
        resolution: 'low',
      },
      {
        type: 'video',
        uri: 'https://example.com/clip.mp4',
        mime_type: 'video/mp4',
      },
      {
        type: 'document',
        data: 'JVBERg==',
        mime_type: 'application/pdf',
      },
      {
        type: 'image',
        data: 'cG5n',
        mime_type: 'image/png',
      },
    ]);
  });

  it.each([
    {
      name: 'when prompt_feedback reports a block_reason',
      reply: () => jsonResponse({prompt_feedback: {block_reason: 'safety'}}),
    },
    {
      name: 'when HTTP 400 reports safety block code',
      reply: () => badRequest('safety'),
    },
    {
      name: 'when HTTP 400 reports content_blocked code',
      reply: () => badRequest('content_blocked'),
    },
  ])('returns RefusalAnswer for every question $name', async ({reply}) => {
    const server = new FakeFetchServer(reply());
    const classifier = createClassifierWithServer(server);

    const response = await classifier.classify({
      input: 'blocked input',
      questions: {route: ROUTE, urgent: URGENT},
    });

    expect(response.answers).toEqual({
      route: createRefusalAnswer(),
      urgent: createRefusalAnswer(),
    });
  });

  it('rethrows non-safety 400 Bad Request errors without leaking response bodies', async () => {
    const server = new FakeFetchServer(badRequest('invalid_argument'));
    const classifier = createClassifierWithServer(server);

    await expect(
      classifier.classify({
        input: 'x',
        questions: {urgent: URGENT},
      }),
    ).rejects.toThrow(/HTTP 400/);
  });

  it('supports a client exposing decisions.create directly and rejects clients without it', async () => {
    expect(
      () =>
        new GeminiDecisionsClassifier({
          client: {} as never,
        }),
    ).toThrow(/decisions\.create/);

    const createSpy = vi.fn().mockResolvedValue({
      model: 'gemini-decision-1-001',
      answers: {urgent: {type: 'noul', noul: 0.75, confidence: 0.75}},
    });
    const classifier = new GeminiDecisionsClassifier({
      client: {decisions: {create: createSpy}},
    });

    const response = await classifier.classify({
      input: 'check this',
      questions: {urgent: URGENT},
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(response.modelVersion).toBe('gemini-decision-1-001');
    expect(response.answers['urgent']).toEqual(
      createBinaryAnswer({probability: 0.75, confidence: 0.75}),
    );
  });

  it('aborts when reading a stalled response body exceeds timeout', async () => {
    const stalledFetch: typeof fetch = async (_input, init) => {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener(
            'abort',
            () => {
              controller.error(
                signal.reason ?? new Error('Request was aborted.'),
              );
            },
            {once: true},
          );
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {'content-type': 'application/json'},
      });
    };
    const classifier = new GeminiDecisionsClassifier({
      apiKey: 'test-key',
      timeout: 20,
      httpOptions: {fetch: stalledFetch},
    });

    await expect(
      classifier.classify({input: 'x', questions: {urgent: URGENT}}),
    ).rejects.toThrow(/timed out/);
  });

  it('calls the Gemini Developer API even when GOOGLE_GENAI_USE_VERTEXAI is set in the environment', async () => {
    vi.stubEnv('GOOGLE_API_KEY', 'env-key');
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');

    const server = new FakeFetchServer(
      jsonResponse({answers: {urgent: {type: 'noul', noul: 0.5}}}),
      jsonResponse({answers: {urgent: {type: 'noul', noul: 0.6}}}),
    );
    const classifier = new GeminiDecisionsClassifier({
      httpOptions: {
        fetch: server.fetch,
      },
    });

    await classifier.classify({input: 'x', questions: {urgent: URGENT}});
    await classifier.classify({input: 'y', questions: {urgent: URGENT}});

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0].url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/decisions',
    );
    expect(server.requests[0].headers.get('x-goog-api-key')).toBe('env-key');
  });

  it.each<{
    name: string;
    questions: Record<string, Question>;
    pattern: RegExp;
  }>([
    {
      name: 'when questions is empty',
      questions: {},
      pattern: /at least one question/,
    },
    {
      name: 'when more than 1000 questions are passed',
      questions: Object.fromEntries(
        Array.from({length: 1001}, (_, i) => [`q${i}`, URGENT]),
      ),
      pattern: /at most 1000 questions/,
    },
    {
      name: 'when a question name contains spaces',
      questions: {'has space': URGENT},
      pattern: /question names/,
    },
    {
      name: 'when a question name exceeds 64 characters',
      questions: {['x'.repeat(65)]: URGENT},
      pattern: /question names/,
    },
    {
      name: 'when a question has no instructions',
      questions: {urgent: createBinary()},
      pattern: /needs instructions/,
    },
    {
      name: 'when a Choice question has an empty option key',
      questions: {
        bad: createChoice({
          instructions: 'Pick one.',
          criteria: {'': 'empty', valid: null},
        }),
      },
      pattern: /option keys/,
    },
    {
      name: 'when a Choice question has an option key with leading/trailing spaces',
      questions: {
        bad: createChoice({
          instructions: 'Pick one.',
          criteria: {' bad': 'leading space', valid: null},
        }),
      },
      pattern: /option keys/,
    },
    {
      name: 'when a Choice question exceeds 255 options',
      questions: {
        big: createChoice({
          instructions: 'Pick one.',
          criteria: Object.fromEntries(
            Array.from({length: 256}, (_, i) => [String(i), null]),
          ),
        }),
      },
      pattern: /at most 255 options/,
    },
    {
      name: 'when a Score question has an empty rubric level',
      questions: {
        bad: createScore({
          instructions: 'Rate it.',
          criteria: ['low', ''],
        }),
      },
      pattern: /must be non-empty/,
    },
    {
      name: 'when a Score question exceeds 255 levels',
      questions: {
        big: createScore({
          instructions: 'Rate it.',
          criteria: Array.from({length: 256}, (_, i) => String(i)),
        }),
      },
      pattern: /at most 255 options/,
    },
  ])(
    'rejects invalid questions before sending a request $name',
    async ({questions, pattern}) => {
      const server = new FakeFetchServer();
      const classifier = createClassifierWithServer(server);

      await expect(
        classifier.classify({input: 'x', questions}),
      ).rejects.toThrow(pattern);
      expect(server.requests).toHaveLength(0);
    },
  );

  it('rejects unsupported parts, unsupported MIME types, and empty Content before sending a request', async () => {
    const server = new FakeFetchServer();
    const classifier = createClassifierWithServer(server);

    await expect(
      classifier.classify({
        input: {
          role: 'user',
          parts: [{functionCall: {name: 'f', args: {}}}],
        },
        questions: {urgent: URGENT},
      }),
    ).rejects.toThrow(/another kind of part/);

    await expect(
      classifier.classify({
        input: {
          role: 'user',
          parts: [{inlineData: {data: 'YSxi', mimeType: 'text/csv'}}],
        },
        questions: {urgent: URGENT},
      }),
    ).rejects.toThrow(/text\/csv/);

    await expect(
      classifier.classify({
        input: {role: 'user', parts: []},
        questions: {urgent: URGENT},
      }),
    ).rejects.toThrow(/empty input/);

    expect(server.requests).toHaveLength(0);
  });

  it.each<{
    name: string;
    answers: Record<string, unknown>;
    questionKey?: 'route' | 'frustration';
    pattern: RegExp;
  }>([
    {
      name: 'when an answer is missing',
      answers: {},
      pattern: /no answer to 'route'/,
    },
    {
      name: 'when the answer type does not match the question',
      answers: {route: {type: 'noul', noul: 0.5}},
      pattern: /unexpected answer type/,
    },
    {
      name: 'when probabilities are missing from a choice answer',
      answers: {route: {type: 'choice', choice: 'billing'}},
      pattern: /missing/,
    },
    {
      name: 'when choice is outside declared criteria labels',
      answers: {route: {...CHOICE_ANSWER_PAYLOAD, choice: 'sales'}},
      pattern: /not one of its declared labels/,
    },
    {
      name: 'when choice probabilities omit a declared label',
      answers: {
        route: {...CHOICE_ANSWER_PAYLOAD, probabilities: {billing: 1.0}},
      },
      pattern: /expected/,
    },
    {
      name: 'when a probability is outside [0, 1]',
      answers: {
        route: {
          ...CHOICE_ANSWER_PAYLOAD,
          probabilities: {billing: 1.5, technical: 0.0},
        },
      },
      pattern: /outside \[0, 1\]/,
    },
    {
      name: 'when a score is outside its rubric level range',
      answers: {
        frustration: {
          type: 'score',
          score: 3.0,
          probabilities: {'0': 0.0, '1': 0.0, '2': 1.0},
        },
      },
      questionKey: 'frustration',
      pattern: /outside \[0, 2\]/,
    },
  ])(
    'rejects malformed responses $name',
    async ({answers, questionKey = 'route', pattern}) => {
      const server = new FakeFetchServer(jsonResponse({answers}));
      const classifier = createClassifierWithServer(server);
      const questions: Record<string, Question> =
        questionKey === 'frustration'
          ? {frustration: FRUSTRATION}
          : {route: ROUTE};

      await expect(
        classifier.classify({input: 'x', questions}),
      ).rejects.toThrow(pattern);
    },
  );

  it('clamps small rounding errors within tolerance', async () => {
    const server = new FakeFetchServer(
      jsonResponse({
        answers: {
          urgent: {type: 'noul', noul: 1.0000001, confidence: -1e-9},
        },
      }),
    );
    const classifier = createClassifierWithServer(server);

    const response = await classifier.classify({
      input: 'x',
      questions: {urgent: URGENT},
    });

    expect(response.answers['urgent']).toEqual(
      createBinaryAnswer({probability: 1.0, confidence: 0.0}),
    );
  });
});
