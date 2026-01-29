/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Example} from './example.js';

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all BaseExampleProvider instances.
 */
const BASE_EXAMPLE_PROVIDER_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.baseExampleProvider',
);

/**
 * Type guard to check if an object is an instance of BaseExampleProvider.
 * @param obj The object to check.
 * @returns True if the object is an instance of BaseExampleProvider, false otherwise.
 */
export function isBaseExampleProvider(
  obj: unknown,
): obj is BaseExampleProvider {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BASE_EXAMPLE_PROVIDER_SIGNATURE_SYMBOL in obj &&
    obj[BASE_EXAMPLE_PROVIDER_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Base class for example providers.
 *
 *  This class defines the interface for providing examples for a given query.
 */
export abstract class BaseExampleProvider {
  /**
   * A unique symbol to identify ADK example provider classes.
   */
  readonly [BASE_EXAMPLE_PROVIDER_SIGNATURE_SYMBOL] = true;

  /**
   * Returns a list of examples for a given query.
   *
   * @param query The query to get examples for.
   * @return A list of Example objects.
   */
  abstract getExamples(query: string): Example[];
}
