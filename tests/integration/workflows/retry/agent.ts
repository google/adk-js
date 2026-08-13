/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// Vendored copy of samples/workflows/retry/agent.ts so this integration test
// is self-contained; keep it in sync with the sample.

/**
 * Retry: a mock task fails randomly (~70%) and is retried per its RetryConfig,
 * using `ctx.attemptCount`. Faithful port of Python
 * `contributing/samples/workflows/retry`.
 *
 * Run (offline):  npm run sample -- samples/workflows/retry/agent.ts
 */

import {createEvent, node, NodeContext, Workflow} from '@google/adk';

const getWeather = node(
  async function* (ctx: NodeContext) {
    yield createEvent({
      content: {
        role: 'model',
        parts: [{text: `Getting weather... attempt ${ctx.attemptCount}`}],
      },
    });
    if (Math.random() < 0.7) {
      // 70% chance of failure
      throw new Error('HTTP 500: Internal Server Error');
    }
    yield 'sunny';
  },
  {name: 'get_weather', retryConfig: {maxAttempts: 5, initialDelay: 1}},
);

const reportWeather = node(
  async function* (_c: NodeContext, weather: string) {
    yield createEvent({
      content: {role: 'model', parts: [{text: `The weather is ${weather}`}]},
    });
  },
  {name: 'report_weather'},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [['START', getWeather, reportWeather]],
});
