#! /usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {createProgram} from './cli/cli.js';

try {
  createProgram().parse(process.argv);
} catch (e) {
  console.error(e);
}
