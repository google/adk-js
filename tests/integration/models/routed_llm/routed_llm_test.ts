/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent, RoutedLlm} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {createRunner, GeminiWithMockResponses} from '../../test_case_utils.js';

describe('RoutedLlm Integration', () => {
  it('should route to model A when selected', async () => {
    const modelA = new GeminiWithMockResponses([
      {
        candidates: [
          {content: {role: 'model', parts: [{text: 'Response from A'}]}},
        ],
      },
    ]);
    const modelB = new GeminiWithMockResponses([]);

    const routedLlm = new RoutedLlm({
      models: {
        'model-a': modelA,
        'model-b': modelB,
      },
      router: async () => 'model-a',
    });

    const agent = new LlmAgent({
      name: 'test-agent',
      model: routedLlm,
    });

    const runner = await createRunner(agent);
    const gen = runner.run('hi');

    let responseText = '';
    for await (const event of gen) {
      if (event.content?.role === 'model') {
        responseText += event.content.parts?.[0]?.text ?? '';
      }
    }

    expect(responseText).toBe('Response from A');
  });

  it('should route to model B when selected', async () => {
    const modelA = new GeminiWithMockResponses([]);
    const modelB = new GeminiWithMockResponses([
      {
        candidates: [
          {content: {role: 'model', parts: [{text: 'Response from B'}]}},
        ],
      },
    ]);

    const routedLlm = new RoutedLlm({
      models: {
        'model-a': modelA,
        'model-b': modelB,
      },
      router: async () => 'model-b',
    });

    const agent = new LlmAgent({
      name: 'test-agent',
      model: routedLlm,
    });

    const runner = await createRunner(agent);
    const gen = runner.run('hi');

    let responseText = '';
    for await (const event of gen) {
      if (event.content?.role === 'model') {
        responseText += event.content.parts?.[0]?.text ?? '';
      }
    }

    expect(responseText).toBe('Response from B');
  });

  it('should propagate error when underlying model throws', async () => {
    const flakyModel = new GeminiWithMockResponses([]);

    const routedLlm = new RoutedLlm({
      models: {flaky: flakyModel},
      router: async () => 'flaky',
    });

    const agent = new LlmAgent({
      name: 'test-agent',
      model: routedLlm,
    });

    const runner = await createRunner(agent);
    const gen = runner.run('hi');

    const result = await gen.next();
    expect(result.value?.errorCode).toBeDefined();
    expect(result.value?.errorMessage).toContain(
      'No more recorded responses available',
    );
  });
});
