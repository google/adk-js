/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Represents a node in the {@link BranchTrie}.
 */
export interface BranchTrieNode {
  children: Map<string, BranchTrieNode>;
  isEndOfBranch: boolean;
  value?: string;
}

/**
 * Creates a new {@link BranchTrieNode}.
 *
 * @param isEndOfBranch Whether this node represents the end of a valid branch.
 * @param value The full dot-separated branch string when isEndOfBranch is true.
 * @returns A new BranchTrieNode.
 */
export function createBranchTrieNode(
  isEndOfBranch = false,
  value?: string,
): BranchTrieNode {
  return {
    children: new Map<string, BranchTrieNode>(),
    isEndOfBranch,
    value,
  };
}

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
  if (!targetBranch) {
    return true;
  }
  if (!currentBranch) {
    return false;
  }
  if (targetBranch === currentBranch) {
    return true;
  }
  return currentBranch.startsWith(`${targetBranch}.`);
}

/**
 * A Trie data structure for fast branch path prefix matching and event filtering.
 * Indexes dot-separated branch segments to enable O(m) prefix lookup while
 * guaranteeing strict segment-boundary correctness.
 */
export class BranchTrie {
  private readonly root: BranchTrieNode = createBranchTrieNode();

  /**
   * Splits the branch by dot (.) into segments and inserts them into the Trie.
   *
   * @param branch The branch string to insert.
   */
  insert(branch: string): void {
    if (!branch) {
      this.root.isEndOfBranch = true;
      this.root.value = branch;
      return;
    }
    const segments = branch.split('.');
    let node = this.root;
    for (const segment of segments) {
      let child = node.children.get(segment);
      if (!child) {
        child = createBranchTrieNode();
        node.children.set(segment, child);
      }
      node = child;
    }
    node.isEndOfBranch = true;
    node.value = branch;
  }

  /**
   * Checks whether targetBranch is equal to or an ancestor of currentBranch
   * by verifying segment-by-segment matching without character substring false positives.
   *
   * @param currentBranch The branch being evaluated.
   * @param targetBranch The candidate prefix or ancestor branch.
   * @returns true if targetBranch is equal to or an ancestor of currentBranch.
   */
  isPrefixOf(currentBranch: string, targetBranch: string): boolean {
    if (!targetBranch) {
      return true;
    }
    if (!currentBranch) {
      return false;
    }
    if (targetBranch === currentBranch) {
      return true;
    }

    if (this.root.children.size > 0) {
      const segments = currentBranch.split('.');
      let node: BranchTrieNode | undefined = this.root;
      for (const segment of segments) {
        node = node.children.get(segment);
        if (!node) {
          break;
        }
        if (node.isEndOfBranch && node.value === targetBranch) {
          return true;
        }
      }
    }

    return isSegmentPrefix(currentBranch, targetBranch);
  }

  /**
   * Helper method that filters an array of events using Trie lookup in O(m) per event check.
   *
   * @param events The array of events to filter.
   * @param currentBranch The active branch to filter for.
   * @returns Filtered array of events belonging to currentBranch or its ancestors.
   */
  getMatchingEvents<T extends {branch?: string}>(
    events: T[],
    currentBranch?: string,
  ): T[] {
    if (!currentBranch) {
      return events.slice();
    }

    for (const event of events) {
      if (event.branch) {
        this.insert(event.branch);
      }
    }

    const matchingBranches = new Set<string>();
    const segments = currentBranch.split('.');
    let node: BranchTrieNode | undefined = this.root;

    for (const segment of segments) {
      node = node.children.get(segment);
      if (!node) {
        break;
      }
      if (node.isEndOfBranch && node.value !== undefined) {
        matchingBranches.add(node.value);
      }
    }

    return events.filter(
      (event) =>
        !event.branch ||
        event.branch === '' ||
        matchingBranches.has(event.branch) ||
        event.branch === currentBranch,
    );
  }
}
