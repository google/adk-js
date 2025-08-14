/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

/**
 * Represents one memory entry.
 */
export interface MemoryEntry {
  /**
   * The content of the memory entry.
   */
  content: Content;

  /**
   * The author of the memory.
   */
  author?: string;

  /**
   * The timestamp when the original content of this memory happened.
   * This string will be forwarded to LLM. Preferred format is ISO 8601 format.
   */
  timestamp?: string;
}
