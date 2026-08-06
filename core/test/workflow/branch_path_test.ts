/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  BranchPath,
  branchPathFromString,
  commonPrefixOf,
  commonPrefixOfPaths,
  createSubBranch,
} from '../../src/workflow/branch_path.js';

describe('branchPathFromString', () => {
  it('parses undefined / null / empty into an empty path', () => {
    expect(branchPathFromString(undefined).getSegments()).toEqual([]);
    expect(branchPathFromString(null).getSegments()).toEqual([]);
    expect(branchPathFromString('').getSegments()).toEqual([]);
  });

  it('splits a dotted string into segments', () => {
    const path = branchPathFromString('a.b@1.c');
    expect(path.getSegments()).toEqual(['a', 'b@1', 'c']);
    expect(path.toString()).toBe('a.b@1.c');
  });
});

describe('BranchPath.append', () => {
  it('appends a bare name segment', () => {
    expect(new BranchPath([]).append('x').toString()).toBe('x');
  });

  it('appends a name@runId segment when a runId is given', () => {
    expect(new BranchPath(['a']).append('x', '1').toString()).toBe('a.x@1');
  });

  it('does not mutate the original path', () => {
    const base = new BranchPath(['a']);
    base.append('b');
    expect(base.getSegments()).toEqual(['a']);
  });
});

describe('BranchPath.isDescendantOf', () => {
  it('is true for a strict descendant', () => {
    expect(
      branchPathFromString('a.b.c').isDescendantOf(branchPathFromString('a.b')),
    ).toBe(true);
  });

  it('is false for an identical path (strict)', () => {
    expect(
      branchPathFromString('a.b').isDescendantOf(branchPathFromString('a.b')),
    ).toBe(false);
  });

  it('is false for a divergent path', () => {
    expect(
      branchPathFromString('a.c').isDescendantOf(branchPathFromString('a.b')),
    ).toBe(false);
  });
});

describe('commonPrefixOfPaths', () => {
  it('returns an empty path for no inputs', () => {
    expect(commonPrefixOfPaths([]).getSegments()).toEqual([]);
  });

  it('returns the shared prefix', () => {
    const prefix = commonPrefixOfPaths([
      branchPathFromString('a.b.c'),
      branchPathFromString('a.b.d'),
    ]);
    expect(prefix.toString()).toBe('a.b');
  });

  it('returns empty when there is no shared prefix', () => {
    const prefix = commonPrefixOfPaths([
      branchPathFromString('a.b'),
      branchPathFromString('x.y'),
    ]);
    expect(prefix.toString()).toBe('');
  });
});

describe('createSubBranch', () => {
  it('creates a root segment from an empty base', () => {
    expect(createSubBranch(undefined, {name: 'agent'})).toBe('agent');
  });

  it('appends a name@runId segment to an existing branch', () => {
    expect(createSubBranch('parent', {name: 'child', runId: '1'})).toBe(
      'parent.child@1',
    );
  });
});

describe('commonPrefixOf', () => {
  it('finds the common prefix of dotted branch strings', () => {
    expect(commonPrefixOf(['a.b.c', 'a.b.d'])).toBe('a.b');
  });

  it('returns an empty string for no inputs', () => {
    expect(commonPrefixOf([])).toBe('');
  });
});
