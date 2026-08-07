/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {isSegmentPrefix} from '../../src/utils/branch_trie.js';

describe('branch_trie', () => {
  describe('isSegmentPrefix', () => {
    it('should return true when targetBranch is empty or undefined', () => {
      expect(isSegmentPrefix('agent_1.agent_2', '')).toBe(true);
      expect(
        isSegmentPrefix('agent_1.agent_2', undefined as unknown as string),
      ).toBe(true);
    });

    it('should return false when currentBranch is empty or undefined', () => {
      expect(isSegmentPrefix('', 'agent_1')).toBe(false);
      expect(isSegmentPrefix(undefined as unknown as string, 'agent_1')).toBe(
        false,
      );
    });

    it('should return true for exact matches', () => {
      expect(isSegmentPrefix('agent_1.agent_2', 'agent_1.agent_2')).toBe(true);
    });

    it('should return true when targetBranch is an ancestor segment', () => {
      expect(isSegmentPrefix('agent_1.agent_2.agent_3', 'agent_1')).toBe(true);
      expect(
        isSegmentPrefix('agent_1.agent_2.agent_3', 'agent_1.agent_2'),
      ).toBe(true);
    });

    it('should return false when targetBranch is a character prefix without dot boundary (substring false positive)', () => {
      expect(isSegmentPrefix('agent_1.agent_2', 'agent_1.agent')).toBe(false);
      expect(isSegmentPrefix('parent.client_v2', 'parent.client')).toBe(false);
      expect(isSegmentPrefix('parent.client', 'parent.cli')).toBe(false);
    });

    it('should return false for sibling or descendant branches', () => {
      expect(isSegmentPrefix('agent_1.agent_2', 'agent_1.agent_3')).toBe(false);
      expect(isSegmentPrefix('agent_1', 'agent_1.agent_2')).toBe(false);
    });
  });
});
