/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Blob, Content} from '@google/genai';

/**
 * Store the data that can be used for transcription.
 */
export interface TranscriptionEntry {
  /**
   * The role that created this data, typically "user" or "model". For function
   * call, this is undefined.
   */
  role?: string;

  /*
   * The data that can be used for transcription.
   */
  data: Blob|Content;
}
