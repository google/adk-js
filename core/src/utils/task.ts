/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Represents a runtime task wrapping a promise, allowing status check and cancellation.
 */
export class Task<T = void> {
  private isDone = false;

  constructor(
    readonly promise: Promise<T>,
    private readonly cancelFn?: () => void,
  ) {
    const markDone = () => {
      this.isDone = true;
    };
    promise.then(markDone, markDone);
  }

  /**
   * Cancels the task execution.
   */
  cancel(): void {
    this.cancelFn?.();
  }

  /**
   * Returns true if the task has completed (either resolved or rejected).
   */
  done(): boolean {
    return this.isDone;
  }
}
