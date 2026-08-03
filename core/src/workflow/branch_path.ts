/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hierarchical, dot-separated path for execution branches. Each segment is a
 * node run, typically formatted as `name@runId` (or just `name`).
 *
 * Ported from `google/adk-python` `events/_branch_path.py::_BranchPath`.
 *
 * @example 'parent_agent@1.collect_tool@2.sub_workflow'
 */
export class BranchPath {
  private readonly segments: string[];

  constructor(segments: string[]) {
    this.segments = [...segments];
  }

  toString(): string {
    return this.segments.join('.');
  }

  /** Returns a copy of the path segments. */
  getSegments(): string[] {
    return [...this.segments];
  }

  /** Whether this path is a strict descendant of `ancestor`. */
  isDescendantOf(ancestor: BranchPath): boolean {
    if (this.segments.length <= ancestor.segments.length) {
      return false;
    }
    return ancestor.segments.every((seg, i) => this.segments[i] === seg);
  }

  /** Returns a new path with a `name@runId` (or `name`) segment appended. */
  append(name: string, runId?: string): BranchPath {
    const segment = runId !== undefined ? `${name}@${runId}` : name;
    return new BranchPath([...this.segments, segment]);
  }
}

/** Parses a dot-separated string into a {@link BranchPath}. */
export function branchPathFromString(path?: string | null): BranchPath {
  if (!path) {
    return new BranchPath([]);
  }
  return new BranchPath(path.split('.'));
}

/** Finds the common prefix across a list of {@link BranchPath}s. */
export function commonPrefixOfPaths(paths: BranchPath[]): BranchPath {
  if (paths.length === 0) {
    return new BranchPath([]);
  }
  const allSegments = paths.map((p) => p.getSegments());
  const common: string[] = [];
  const minLen = Math.min(...allSegments.map((s) => s.length));
  for (let i = 0; i < minLen; i++) {
    const seg = allSegments[0][i];
    if (allSegments.every((s) => s[i] === seg)) {
      common.push(seg);
    } else {
      break;
    }
  }
  return new BranchPath(common);
}

/**
 * Creates a new dot-separated sub-branch string by appending a segment.
 *
 * @example createSubBranch('parent', {name: 'child', runId: '1'}) -> 'parent.child@1'
 * @example createSubBranch(undefined, {name: 'agent'}) -> 'agent'
 */
export function createSubBranch(
  baseBranch: string | undefined | null,
  options: {name: string; runId?: string},
): string {
  return branchPathFromString(baseBranch)
    .append(options.name, options.runId)
    .toString();
}

/** Finds the common prefix of a list of dot-separated branch strings. */
export function commonPrefixOf(branches: string[]): string {
  return commonPrefixOfPaths(
    branches.map((b) => branchPathFromString(b)),
  ).toString();
}
