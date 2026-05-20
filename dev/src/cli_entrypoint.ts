#! /usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {createProgram} from './cli/cli.js';

// Async CLI actions can briefly await before opening a server handle.
const keepAliveUntilCommandStarts = setInterval(() => {}, 2 ** 31 - 1);

void createProgram()
  .parseAsync(process.argv)
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    clearInterval(keepAliveUntilCommandStarts);
  });
