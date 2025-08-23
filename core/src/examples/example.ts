/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

/**
 * A few-shot example.
 */
export interface Example {
  /**
   * The input content for the example.
   */
  input: Content;
  /**
   * The expected output content for the example.
   */
  output: Content[];
}
