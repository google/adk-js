/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The model every ported agent runs on.
 *
 * Pinned, and pinned identically on the Python side (the harness injects
 * `ADK_PARITY_MODEL` into both runs). The two runtimes ship *different*
 * defaults, so an agent that omits `model` would compare two different models
 * and attribute the difference to the framework.
 */
export const PARITY_MODEL =
  process.env['ADK_PARITY_MODEL'] ?? 'gemini-2.5-flash';
