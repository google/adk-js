/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EventEmitter} from 'events';
import {BackgroundToolMessage} from './background_tool_message.js';

let instance: WorkerCoordinator;
export function getInstance(): WorkerCoordinator {
  if (!instance) {
    instance = new WorkerCoordinator();
  }
  return instance;
}

/**
 * Coordinator to manage background workers and their lifecycle.
 * Emits events that the Runner can subscribe to for stream injection.
 */
export class WorkerCoordinator extends EventEmitter {
  public emitMessage(msg: BackgroundToolMessage): void {
    this.emit(msg.type, msg);
  }
}
