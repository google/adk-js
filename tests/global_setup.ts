/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel, setLogLevel} from '@google/adk';

export function setup() {
  setLogLevel(LogLevel.ERROR);
}

export function teardown() {
  setLogLevel(LogLevel.INFO);
}
