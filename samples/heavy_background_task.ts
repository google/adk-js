/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  completeBackgroundTool,
  failBackgroundTool,
  requestInputForBackgroundTool,
} from '@google/adk';
import {parentPort} from 'worker_threads';

async function main() {
  if (!parentPort) {
    throw new Error('Must be run as a worker thread');
  }

  await new Promise((resolve) => setTimeout(resolve, 1000));

  const userInput = await requestInputForBackgroundTool(
    parentPort,
    'Are you sure you want to proceed with the calculation? (Yes/No)',
  );

  if ((userInput as string).toLowerCase().includes('yes')) {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    completeBackgroundTool(parentPort, {
      payload: 'Calculation finished successfully! The answer is 42.',
    });
  } else {
    failBackgroundTool(parentPort, 'User aborted the calculation.');
  }
}

main().catch((err) => {
  if (parentPort) {
    failBackgroundTool(parentPort, err.message);
  }
});
