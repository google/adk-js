/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Retry: a mock task fails randomly (~70%) and is retried per its RetryConfig,
 * using `ctx.attemptCount`. One-to-one port of Python
 * `contributing/samples/workflows/retry/agent.py`.
 *
 * Run (offline):
 *   npm run sample -- tests/integration/workflows/retry/agent.ts
 */

import {createEvent, node, NodeContext, Workflow} from '@google/adk';

/**
 * Stands in for Python's `urllib.error.HTTPError`, so the failure event carries
 * the same `errorCode`/`errorMessage` the Python sample produces.
 */
function httpError(code: number, msg: string): Error {
  const error = new Error(`HTTP Error ${code}: ${msg}`);
  error.name = 'HTTPError';
  return error;
}

const getWeather = node(
  async function* (ctx: NodeContext) {
    yield createEvent({
      content: {
        role: 'user',
        parts: [{text: `Getting weather... attempt ${ctx.attemptCount}`}],
      },
    });
    if (Math.random() < 0.7) {
      // 70% chance of failure
      throw httpError(500, 'Internal Server Error');
    }
    yield 'sunny';
  },
  {name: 'get_weather', retryConfig: {maxAttempts: 5, initialDelay: 1}},
);

const reportWeather = node(
  async function* (_c: NodeContext, weather: string) {
    yield createEvent({
      content: {role: 'user', parts: [{text: `The weather is ${weather}`}]},
    });
  },
  {name: 'report_weather'},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [['START', getWeather, reportWeather]],
});
