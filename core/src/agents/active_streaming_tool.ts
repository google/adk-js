/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Task} from '../utils/task.js';
import {LiveRequestQueue} from './live_request_queue.js';

/**
 * The parameters for creating an ActiveStreamingTool.
 */
export interface ActiveStreamingToolParams {
  task?: Task<void> | Promise<void>;
  stream?: LiveRequestQueue;
}

/**
 * Manages streaming tool related resources during invocation.
 */
export class ActiveStreamingTool {
  /**
   * The active task of this streaming tool.
   */
  task?: Task<void>;

  /**
   * The active (input) streams of this streaming tool.
   */
  stream?: LiveRequestQueue;

  constructor(params: ActiveStreamingToolParams = {}) {
    if (params.task instanceof Promise) {
      this.task = new Task(() => params.task as Promise<void>);
    } else {
      this.task = params.task;
    }
    this.stream = params.stream;
  }
}
