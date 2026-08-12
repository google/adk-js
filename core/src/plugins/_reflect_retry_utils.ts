/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const REFLECT_AND_RETRY_RESPONSE_TYPE =
  'ERROR_HANDLED_BY_REFLECT_AND_RETRY_PLUGIN';
export const GLOBAL_SCOPE_KEY = '__global_reflect_and_retry_scope__';

/**
 * Defines the lifecycle scope for tracking failure counts.
 */
export enum TrackingScope {
  /** Track failures within the current agent invocation. */
  INVOCATION = 'invocation',
  /** Track failures globally across all invocations. */
  GLOBAL = 'global',
}

/**
 * A mapping from an item's (tool or model) name to its consecutive failure count.
 */
export type PerItemFailuresCounter = Map<string, number>;

/**
 * Response containing tool failure details and retry guidance.
 *
 * Field names use snake_case to match the model-facing reflection payload schema
 * and maintain parity with ADK Python.
 */
export interface ToolFailureResponse {
  response_type: string;
  error_type: string;
  error_details: string;
  retry_count: number;
  reflection_guidance: string;
  [key: string]: unknown;
}

/**
 * Resolves the scope key based on tracking scope and invocation ID.
 *
 * @param scope - The tracking scope (INVOCATION or GLOBAL).
 * @param invocationId - The invocation ID (required for INVOCATION scope).
 * @returns The resolved scope key string.
 */
export function resolveScopeKey(
  scope: TrackingScope,
  invocationId?: string,
): string {
  if (scope === TrackingScope.INVOCATION) {
    if (!invocationId) {
      throw new Error('invocation_id must be provided for INVOCATION scope');
    }
    return invocationId;
  } else if (scope === TrackingScope.GLOBAL) {
    return GLOBAL_SCOPE_KEY;
  }
  throw new Error(`Unknown scope: ${scope}`);
}

/**
 * Thread-safe failure counter scoped by invocation or global key.
 */
export class ScopedFailureTracker {
  private readonly scopedFailureCounters = new Map<
    string,
    Map<string, number>
  >();
  private lockPromise: Promise<void> = Promise.resolve();

  private async acquireLock(): Promise<() => void> {
    let release: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const currentLock = this.lockPromise;
    this.lockPromise = this.lockPromise.then(() => nextLock);
    await currentLock;
    return release!;
  }

  /**
   * Atomically increments and returns the failure count for an item.
   *
   * @param scopeKey - The scope identifier (e.g. invocation ID or global key).
   * @param itemName - The name of the tool or model.
   * @returns The updated failure count.
   */
  async increment(scopeKey: string, itemName: string): Promise<number> {
    const release = await this.acquireLock();
    try {
      let counter = this.scopedFailureCounters.get(scopeKey);
      if (!counter) {
        counter = new Map<string, number>();
        this.scopedFailureCounters.set(scopeKey, counter);
      }
      const current = (counter.get(itemName) ?? 0) + 1;
      counter.set(itemName, current);
      return current;
    } finally {
      release();
    }
  }

  /**
   * Atomically resets the failure count for an item and cleans up state.
   *
   * @param scopeKey - The scope identifier.
   * @param itemName - The name of the tool or model.
   */
  async reset(scopeKey: string, itemName: string): Promise<void> {
    const release = await this.acquireLock();
    try {
      const counter = this.scopedFailureCounters.get(scopeKey);
      if (counter) {
        counter.delete(itemName);
        if (counter.size === 0) {
          this.scopedFailureCounters.delete(scopeKey);
        }
      }
    } finally {
      release();
    }
  }

  /**
   * Gets the current failure count for an item.
   *
   * @param scopeKey - The scope identifier.
   * @param itemName - The name of the tool or model.
   */
  async getCount(scopeKey: string, itemName: string): Promise<number> {
    const release = await this.acquireLock();
    try {
      return this.scopedFailureCounters.get(scopeKey)?.get(itemName) ?? 0;
    } finally {
      release();
    }
  }
}
