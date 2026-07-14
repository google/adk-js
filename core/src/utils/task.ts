/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type TaskExecutable<T = void> = (abortSignal: AbortSignal) => Promise<T>;

/**
 * Represents a runtime task wrapping a promise, allowing status check and cancellation.
 */
export class Task<T = void> {
  private isDone = false;
  private abortController = new AbortController();
  public promise: Promise<T>;

  constructor(public executable: TaskExecutable<T>) {
    const markDone = () => {
      this.isDone = true;
    };

    this.promise = executable(this.abortController.signal);
    this.promise.then(markDone).catch(markDone);
  }

  /**
   * Cancels the task execution.
   */
  cancel(): void {
    this.abortController.abort();
  }

  /**
   * Returns true if the task has completed (either resolved or rejected).
   */
  done(): boolean {
    return this.isDone;
  }
}
