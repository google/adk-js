/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Imported by path rather than through the `@google/adk` barrel on purpose:
// the barrel pulls most of core into the module graph before any test file is
// evaluated, which leaves those modules cached with real bindings and silently
// defeats `vi.mock` in the tests that mock them.
import {LogLevel, setLogLevel} from '../core/src/utils/logger.js';

// Runs inside every test worker. A `globalSetup` file cannot do this: it is
// evaluated only in Vitest's main process, so the level it sets never reaches
// the forked workers that run the tests, and every WARN/INFO the ADK logger
// emits ends up echoed into the CI log.
setLogLevel(LogLevel.ERROR);
