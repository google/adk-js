/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reads an environment variable at call time.
 *
 * Returns undefined where `process` does not exist, so the telemetry modules
 * that reach the browser build can call it safely. An empty value is returned
 * as is.
 */
export function readEnvVar(name: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) {
    return undefined;
  }
  return process.env[name];
}

/** Reads an environment variable, treating an empty value as unset. */
export function readNonEmptyEnvVar(name: string): string | undefined {
  const value = readEnvVar(name);
  return value ? value : undefined;
}
