/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Example} from './example.js';

/**
 * Base class for example providers.
 *
 *  This class defines the interface for providing examples for a given query.
 */
export abstract class BaseExampleProvider {
  /**
   * Returns a list of examples for a given query.
   *
   * @param query The query to get examples for.
   * @return A list of Example objects.
   */
  abstract getExamples(query: string): Example[];
}
