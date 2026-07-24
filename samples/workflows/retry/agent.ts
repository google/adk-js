/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Retry: a flaky node is retried per its RetryConfig until it succeeds. Mirrors
 * Python `workflows/retry`.
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/retry/agent.ts
 */

import {node, NodeContext, Workflow, WorkflowAgent} from '@google/adk';

let attempts = 0;

const getWeather = node(
  () => {
    attempts++;
    if (attempts < 3) {
      throw new Error(`Transient upstream error (attempt ${attempts}).`);
    }
    return 'sunny';
  },
  {
    name: 'get_weather',
    retryConfig: {maxAttempts: 5, initialDelay: 0.2, jitter: 0},
  },
);

const reportWeather = node(
  (_c: NodeContext, weather: string) =>
    `The weather is ${weather} (after ${attempts} attempts).`,
  {name: 'report_weather'},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'retry_sample',
    edges: [['START', getWeather, reportWeather]],
  }),
);
