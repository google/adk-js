/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Checks whether targetBranch is equal to or an ancestor of currentBranch
 * by verifying segment-by-segment matching without substring false positives.
 *
 * @param currentBranch The branch being evaluated.
 * @param targetBranch The candidate prefix or ancestor branch.
 * @returns true if targetBranch equals currentBranch or is an ancestor of currentBranch.
 */
export function isSegmentPrefix(
  currentBranch: string,
  targetBranch: string,
): boolean {
  return (
    !targetBranch ||
    targetBranch === currentBranch ||
    (!!currentBranch && currentBranch.startsWith(`${targetBranch}.`))
  );
}
