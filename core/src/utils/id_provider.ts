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

let idProvider: IdProvider | undefined;

/**
 * Sets the function used to generate event, invocation, session and
 * function-call IDs. Without a provider, every ID keeps its default format.
 *
 * Useful when random IDs are not unique, e.g. runtimes restored from one
 * memory snapshot share RNG state. Like adk-python's `set_id_provider`, but
 * global instead of scoped to an async context.
 *
 * Each value must be a non-empty string that no other runtime produces.
 * Session IDs come from it too, so the values should also be hard to guess.
 *
 * @param provider A function that returns a unique ID string.
 */
export function setIdProvider(provider: IdProvider): void {
  idProvider = provider;
}

/**
 * Removes the provider set with `setIdProvider`, so IDs go back to their
 * default formats.
 */
export function resetIdProvider(): void {
  idProvider = undefined;
}

/**
 * Returns a new unique ID from the provider set with `setIdProvider`, or a
 * random v4 UUID when none is set.
 */
export function newId(): string {
  return newIdOr(randomUUID);
}

/**
 * Returns a new unique ID from the provider set with `setIdProvider`, or from
 * `fallback` when none is set.
 *
 * Internal to the framework: not part of the public API. For IDs whose default
 * is not a random v4 UUID, such as event IDs.
 *
 * @param fallback A function that returns the default ID.
 */
export function newIdOr(fallback: IdProvider): string {
  return idProvider ? idProvider() : fallback();
}
