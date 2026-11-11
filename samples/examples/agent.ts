/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sample demonstrating the `examples` subsystem (`Example`, `BaseExampleProvider`,
 * `example_util`) with `InMemoryRunner` and `UnsafeLocalCodeExecutor`.
 */

import {
  BaseExampleProvider,
  Example,
  InMemoryRunner,
  LlmAgent,
  UnsafeLocalCodeExecutor,
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

export const rootAgent = new LlmAgent({
  name: 'examples_demo_agent',
  model: 'gemini-2.5-flash',
  description:
    'Demonstrates few-shot examples with InMemoryRunner and UnsafeLocalCodeExecutor.',
  instruction: 'Follow the formatting demonstrated in the provided examples.',
  codeExecutor: new UnsafeLocalCodeExecutor(),
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
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
