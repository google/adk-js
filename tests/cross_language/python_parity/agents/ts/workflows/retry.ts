/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/workflows/retry.
 *
 * `RetryConfig` is field-for-field the same (delays in seconds in both
 * runtimes), and `ctx.attemptCount` is `ctx.attempt_count`. Python's
 * `@node(retry_config=...)` decorator is `node(fn, {name, retryConfig})`.
 *
 * The flaky call raises `urllib.error.HTTPError` upstream; the closest TS
 * equivalent is a local error class with the same name and message. One
 * observable difference remains: adk-python stamps the error event's
 * `errorCode` with the exception CLASS NAME ("HTTPError"), while adk-js reads
 * `error.code` and falls back to "UNKNOWN_ERROR" — so `code` is set here to
 * carry the same value rather than leave the field empty.
 */
import {createEvent, node, NodeContext, Workflow} from '@google/adk';

/** Stands in for `urllib.error.HTTPError`. */
class HTTPError extends Error {
  override readonly name = 'HTTPError';
  readonly code = 'HTTPError';

  constructor(
    readonly url: string,
    readonly status: number,
    msg: string,
  ) {
    super(`HTTP Error ${status}: ${msg}`);
  }
}

/** A mock task that fails randomly. */
const getWeather = node(
  function* (ctx: NodeContext) {
    yield createEvent({
      content: {
        role: 'model',
        parts: [{text: `Getting weather... attempt ${ctx.attemptCount}`}],
      },
    });
    if (Math.random() < 0.7) {
      // 70% chance of failure
      throw new HTTPError(
        'http://mock-api.example.com',
        500,
        'Internal Server Error',
      );
    }

    yield 'sunny';
  },
  {name: 'get_weather', retryConfig: {maxAttempts: 5, initialDelay: 1}},
);

const reportWeather = node(
  function* (_ctx: NodeContext, nodeInput: string) {
    yield createEvent({
      content: {role: 'model', parts: [{text: `The weather is ${nodeInput}`}]},
    });
  },
  {name: 'report_weather'},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [['START', getWeather, reportWeather]],
});
