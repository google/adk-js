/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from './env_aware_utils.js';

/**
 * Returns a new unique ID string.
 */
export type IdProvider = () => string;

const defaultIdProvider: IdProvider = randomUUID;

let idProvider: IdProvider = defaultIdProvider;

/**
 * Sets the function used to generate event, invocation and session IDs.
 *
 * Useful when random IDs are not unique, e.g. runtimes restored from one
 * memory snapshot share RNG state. Mirrors adk-python's `set_id_provider`.
 *
 * @param provider A function that returns a unique ID string.
 */
export function setIdProvider(provider: IdProvider): void {
  idProvider = provider;
}

/**
 * Restores the default provider, which returns random v4 UUIDs.
 */
export function resetIdProvider(): void {
  idProvider = defaultIdProvider;
}

/**
 * Returns a new unique ID from the current provider.
 */
export function newId(): string {
  return idProvider();
}
