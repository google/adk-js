/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Interface for pruning large tool responses (observations).
 */
export interface BasePruner {
  /**
   * Prunes the given value.
   *
   * @param value The value to prune.
   * @returns The pruned value.
   */
  prune(value: unknown): unknown;
}

export interface PruningRule {
  toolName: string;
  pruner: BasePruner;
}

export interface PruningOptions {
  rules: PruningRule[];
  sizeThreshold?: number;
}
