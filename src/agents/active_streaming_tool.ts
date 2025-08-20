/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LiveRequestQueue} from './live_request_queue.js';

/**
 * Manages streaming tool related resources during invocation.
 */
export class ActiveStreamingTool {
  /**
   * The active task of this streaming tool.
   * TODO: Replace 'Promise<void>' with a proper Task type if available in this
   * env.
   */
  task?: Promise<void>;

  /**
   * The active (input) streams of this streaming tool.
   */
  stream?: LiveRequestQueue;

  constructor(task?: Promise<void>, stream?: LiveRequestQueue) {
    this.task = task;
    this.stream = stream;
  }
}
