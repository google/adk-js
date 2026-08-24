/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/core/abort.
 *
 * Ported as literally as the two APIs allow: same tool name, same parameter
 * name, same instruction text. Divergence in the transcript should come from
 * the runtimes, not from the agent definition.
 *
 * The Python tool cooperates with cancellation by letting `asyncio.CancelledError`
 * propagate out of `await asyncio.sleep`; the TS equivalent is the
 * `AbortSignal` the framework puts on the tool context, so the sleep rejects
 * when the client goes away. A replayed `adk run` never disconnects, so this
 * path is only exercised interactively — the parity run measures the happy
 * path.
 */
import {FunctionTool, getLogger, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

const logger = getLogger();

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

const countSeconds = new FunctionTool({
  name: 'count_seconds',
  description:
    'Counts from 1 to the target number, pausing 1 second between counts, and prints each count.',
  parameters: z.object({
    target: z.number().int().describe('The target number to count to.'),
  }),
  execute: async ({target}, toolContext) => {
    logger.info(`Starting count from 1 to ${target}...`);
    console.log(
      `\n[Counting Tool] Starting counting up to ${target} in console...`,
    );

    let i = 0;
    try {
      for (i = 1; i <= target; i++) {
        await sleep(1000, toolContext?.abortSignal);
        // Print to standard stdout so it shows directly in the server terminal
        console.log(`[Counting Tool] Progress: ${i}/${target}`);
        logger.info(`Counted: ${i}/${target}`);
      }

      console.log(`[Counting Tool] Finished counting up to ${target}.\n`);
      return `Successfully counted from 1 to ${target} in the console.`;
    } catch (error) {
      console.log(
        `\n[Counting Tool] Count was ABORTED mid-run at progress: ${i}/${target}` +
          ' (Client Disconnected)!\n',
      );
      logger.warn('Counting tool was cancelled mid-run.');
      throw error;
    }
  },
});

export const rootAgent = new LlmAgent({
  name: 'abort_agent',
  model: PARITY_MODEL,
  description:
    'An agent designed to demonstrate how ADK handles client disconnects' +
    ' and aborts agent executions mid-run using a counting loop with a' +
    ' 1-second delay.',
  instruction: `You are an abort coordinator.
Your goal is to demonstrate cooperative task abortion.
When asked to count to a number (or count for a number of seconds), invoke the \`count_seconds\` tool with the target number.
Do not try to count by yourself; always delegate counting to the \`count_seconds\` tool so that progress is accurately printed and logs can show task cancellation when a disconnect happens.`,
  tools: [countSeconds],
});
