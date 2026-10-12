/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sample demonstrating the `examples` subsystem (`Example`, `BaseExampleProvider`,
 * `example_util`) with `InMemoryRunner` and `UnsafeLocalCodeExecutor`.
 *
 * Also demonstrates `VertexAiExampleStore` (both with the single-argument
 * default `VertexAiExampleStoreApiClient` and with an injected
 * `ExampleStoreApiClient`), `ExampleTool`, `validateExamples`,
 * `convertExamplesToText`, `buildExampleSi`, and `getLatestMessageFromUser`.
 *
 * This file exports `rootAgent` for `npm run sample -- samples/examples/agent.ts`
 * and `adk web`, and includes a direct `main()` runner so the few-shot prompt
 * rendering and `VertexAiExampleStore` retrieval can be inspected offline
 * without live model or cloud credentials:
 *   npx tsx samples/examples/agent.ts
 */

import {
  BaseExampleProvider,
  buildExampleSi,
  convertExamplesToText,
  createEvent,
  createSession,
  Example,
  ExampleStoreApiClient,
  ExampleTool,
  getLatestMessageFromUser,
  InMemoryRunner,
  isBaseExampleProvider,
  LlmAgent,
  SearchExamplesRequest,
  SearchExamplesResponse,
  UnsafeLocalCodeExecutor,
  validateExamples,
  VertexAiExampleStore,
  VertexAiExampleStoreApiClient,
} from '@google/adk';

/**
 * In-memory dynamic few-shot example provider.
 */
export class InMemoryExampleProvider extends BaseExampleProvider {
  private readonly examples: Example[];

  constructor(examples: Example[]) {
    super();
    this.examples = examples;
  }

  override async getExamples(_query: string): Promise<Example[]> {
    return this.examples;
  }
}

export const exampleProvider = new InMemoryExampleProvider([
  {
    input: {
      role: 'user',
      parts: [{text: 'Compute 6 * 7 and format as Answer: <number>.'}],
    },
    output: [
      {
        role: 'model',
        parts: [{text: 'Answer: 42'}],
      },
    ],
  },
]);

export const EXAMPLE_STORE_RESOURCE =
  'projects/demo-project/locations/us-central1/exampleStores/math-examples';

/**
 * Single-argument `VertexAiExampleStore` using the built-in
 * `VertexAiExampleStoreApiClient` (authenticates lazily on first request).
 */
export const defaultVertexStore = new VertexAiExampleStore(
  EXAMPLE_STORE_RESOURCE,
);

const offlineExampleStoreClient: ExampleStoreApiClient = {
  async searchExamples(
    request: SearchExamplesRequest,
  ): Promise<SearchExamplesResponse> {
    const queryText =
      request.storedContentsExampleParameters.contentSearchKey.contents[0]
        ?.parts?.[0]?.text ?? '';
    return {
      results: [
        {
          similarityScore: 0.95,
          example: {
            storedContentsExample: {
              searchKey: queryText,
              contentsExample: {
                expectedContents: [
                  {
                    content: {
                      role: 'model',
                      parts: [{text: 'Answer: 72'}],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    };
  },
};

/**
 * `VertexAiExampleStore` with an injected `ExampleStoreApiClient` for offline
 * execution.
 */
export const customClientVertexStore = new VertexAiExampleStore(
  EXAMPLE_STORE_RESOURCE,
  offlineExampleStoreClient,
);

export const exampleTool = new ExampleTool(exampleProvider);

export const rootAgent = new LlmAgent({
  name: 'examples_demo_agent',
  model: 'gemini-2.5-flash',
  description:
    'Demonstrates few-shot examples with InMemoryRunner and UnsafeLocalCodeExecutor.',
  instruction: 'Follow the formatting demonstrated in the provided examples.',
  codeExecutor: new UnsafeLocalCodeExecutor(),
  tools: [exampleTool],
});

export async function main(): Promise<void> {
  const runner = new InMemoryRunner({
    agent: rootAgent,
    appName: 'examples_sample',
  });
  console.log(
    'Initialized InMemoryRunner for examples_sample:',
    runner.appName,
  );
  console.log(
    'Loaded examples count:',
    (await exampleProvider.getExamples('test')).length,
  );

  const staticExamples = await exampleProvider.getExamples('test');
  validateExamples(staticExamples);
  const defaultClient = new VertexAiExampleStoreApiClient({
    apiEndpoint: 'us-central1-aiplatform.googleapis.com',
  });
  process.stdout.write(
    `Default VertexAiExampleStore (${defaultVertexStore.examplesStoreName}) is provider: ${isBaseExampleProvider(defaultVertexStore)}, client ready: ${Boolean(defaultClient)}\n`,
  );

  const storeInstruction = await buildExampleSi(
    customClientVertexStore,
    'Compute 8 * 9 and format as Answer: <number>.',
    'gemini-2.5-flash',
  );
  process.stdout.write(`Vertex store instruction:\n${storeInstruction}\n`);

  const formattedStatic = convertExamplesToText(
    staticExamples,
    'gemini-2.5-flash',
  );
  process.stdout.write(`Static examples block:\n${formattedStatic}\n`);

  const session = createSession({
    id: 'session-1',
    appName: runner.appName,
    events: [
      createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'What is 9 * 9?'}]},
      }),
    ],
  });
  process.stdout.write(
    `Latest user message: ${getLatestMessageFromUser(session)}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
