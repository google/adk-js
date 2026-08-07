/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The configuration of resumability for an application or runner.
 *
 * The "resumability" in ADK refers to the ability to:
 * 1. pause an invocation upon a long-running function call.
 * 2. resume an invocation from the last event, if it's paused or failed midway
 * through.
 */
export interface ResumabilityConfig {
  /**
   * Whether the app/runner supports agent resumption.
   * If enabled, resumption routing based on matching function responses will be active.
   */
  isResumable: boolean;
}

/**
 * Creates a {@link ResumabilityConfig} with default values.
 *
 * @param params Optional partial {@link ResumabilityConfig} overriding defaults.
 * @returns A merged {@link ResumabilityConfig} object.
 */
export function createResumabilityConfig(
  params: Partial<ResumabilityConfig> = {},
): ResumabilityConfig {
  return {
    isResumable: false,
    ...params,
  };
}
