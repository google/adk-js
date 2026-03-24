/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  completeBackgroundTool,
  failBackgroundTool,
  requestInputForBackgroundTool,
  getBackgroundToolParams,
} from '@google/adk';
import {parentPort} from 'worker_threads';

async function main() {
  if (!parentPort) {
    throw new Error('Must be run as a worker thread');
  }

  const toolParams = (await getBackgroundToolParams()) as {
    startNumber: number;
  };
  const startNumber = toolParams.startNumber;

  const userInput = (await requestInputForBackgroundTool(
    parentPort,
    `Are you sure you want to proceed with the calculation starting from ${startNumber}? (Yes/No)`,
  )) as {text: string};

  if (userInput.text.toLowerCase().includes('yes')) {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    completeBackgroundTool(parentPort, {
      result: startNumber * 2,
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
