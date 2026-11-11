/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {installBrowserLogger} from './utils/logger_browser.js';

// The browser entry point installs the colour-aware browser logger, in the same
// manner as the Node entry point installs the winston-backed logger. Keeping
// this out of `utils/logger.ts` lets that module stay free of any environment
// assumptions; see https://github.com/google/adk-js/issues/611.
installBrowserLogger();

export * from './common.js';
