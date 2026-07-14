/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BranchTrie, createBranchTrieNode, isSegmentPrefix} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('branch_trie', () => {
  describe('createBranchTrieNode', () => {
    it('should create a node with default values', () => {
      const node = createBranchTrieNode();
      expect(node.isEndOfBranch).toBe(false);
      expect(node.value).toBeUndefined();
      expect(node.children.size).toBe(0);
    });

    it('should create a node with specified values', () => {
      const node = createBranchTrieNode(true, 'agent_1');
      expect(node.isEndOfBranch).toBe(true);
      expect(node.value).toBe('agent_1');
      expect(node.children.size).toBe(0);
    });
  });

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

  describe('BranchTrie', () => {
    describe('insert and isPrefixOf', () => {
      it('should return true for empty targetBranch regardless of Trie contents', () => {
        const trie = new BranchTrie();
        expect(trie.isPrefixOf('agent_1.agent_2', '')).toBe(true);
      });

      it('should return false for empty currentBranch when targetBranch is non-empty', () => {
        const trie = new BranchTrie();
        expect(trie.isPrefixOf('', 'agent_1')).toBe(false);
      });

      it('should handle inserting empty string branch', () => {
        const trie = new BranchTrie();
        trie.insert('');
        expect(trie.isPrefixOf('agent_1', '')).toBe(true);
      });

      it('should return true when targetBranch matches currentBranch exactly without pre-insert', () => {
        const trie = new BranchTrie();
        expect(trie.isPrefixOf('agent_1.agent_2', 'agent_1.agent_2')).toBe(
          true,
        );
      });

      it('should return true when targetBranch is an ancestor segment without pre-insert', () => {
        const trie = new BranchTrie();
        expect(trie.isPrefixOf('agent_1.agent_2', 'agent_1')).toBe(true);
      });

      it('should reject substring false positives with or without pre-insert', () => {
        const trie = new BranchTrie();
        expect(trie.isPrefixOf('agent_1.agent_2', 'agent_1.agent')).toBe(false);

        trie.insert('agent_1.agent');
        trie.insert('agent_1.agent_2');
        expect(trie.isPrefixOf('agent_1.agent_2', 'agent_1.agent')).toBe(false);
      });

      it('should correctly match ancestors after inserting branches into Trie', () => {
        const trie = new BranchTrie();
        trie.insert('coordinator');
        trie.insert('coordinator.researcher');
        trie.insert('coordinator.writer');
        trie.insert('coordinator.researcher.scraper');

        expect(
          trie.isPrefixOf('coordinator.researcher.scraper', 'coordinator'),
        ).toBe(true);
        expect(
          trie.isPrefixOf(
            'coordinator.researcher.scraper',
            'coordinator.researcher',
          ),
        ).toBe(true);
        expect(
          trie.isPrefixOf(
            'coordinator.researcher.scraper',
            'coordinator.researcher.scraper',
          ),
        ).toBe(true);
        expect(
          trie.isPrefixOf(
            'coordinator.researcher.scraper',
            'coordinator.writer',
          ),
        ).toBe(false);
        expect(
          trie.isPrefixOf(
            'coordinator.researcher',
            'coordinator.researcher.scraper',
          ),
        ).toBe(false);
      });

      it('should reject non-matching branch when segment path breaks early in Trie', () => {
        const trie = new BranchTrie();
        trie.insert('a.b.c');
        // checking if x.y is prefix of a.b.c when x is not in Trie
        expect(trie.isPrefixOf('a.b.c', 'x.y')).toBe(false);

        // checking when Trie is non-empty and currentBranch segment is not found
        trie.insert('other.branch');
        expect(trie.isPrefixOf('unrelated.branch', 'other')).toBe(false);
      });
    });

    describe('getMatchingEvents', () => {
      it('should return all events when currentBranch is undefined or empty', () => {
        const trie = new BranchTrie();
        const events = [
          {branch: 'agent_1'},
          {branch: 'agent_1.agent_2'},
          {branch: undefined},
        ];
        expect(trie.getMatchingEvents(events, undefined)).toEqual(events);
        expect(trie.getMatchingEvents(events, '')).toEqual(events);
      });

      it('should break early during traversal if currentBranch goes deeper than any inserted event branch', () => {
        const trie = new BranchTrie();
        const e1 = {id: 1, branch: 'coordinator'};
        const e2 = {id: 2, branch: 'other_branch'};
        const events = [e1, e2];

        // currentBranch has segments not present after coordinator
        const matched = trie.getMatchingEvents(
          events,
          'coordinator.researcher.scraper',
        );
        expect(matched).toEqual([e1]);
      });

      it('should filter events preserving exact segment boundaries and ancestors', () => {
        const trie = new BranchTrie();
        const e1 = {id: 1, branch: 'coordinator'};
        const e2 = {id: 2, branch: 'coordinator.researcher'};
        const e3 = {id: 3, branch: 'coordinator.writer'};
        const e4 = {id: 4, branch: 'coordinator.researcher.scraper'};
        const e5 = {id: 5, branch: 'coordinator.researcher.scraper.child'};
        const e6 = {id: 6, branch: undefined};
        const e7 = {id: 7, branch: ''};
        const e8 = {id: 8, branch: 'coordinator.researcher_2'};

        const events = [e1, e2, e3, e4, e5, e6, e7, e8];

        const matched = trie.getMatchingEvents(
          events,
          'coordinator.researcher.scraper',
        );

        // Should include e1 (ancestor), e2 (ancestor), e4 (self), e6 (undefined branch), e7 (empty branch)
        // Should exclude e3 (sibling), e5 (descendant), e8 (substring false positive sibling)
        expect(matched).toEqual([e1, e2, e4, e6, e7]);
      });

      it('should reject substring false positives in event stream filtering', () => {
        const trie = new BranchTrie();
        const e1 = {id: 1, branch: 'agent_1.agent'};
        const e2 = {id: 2, branch: 'agent_1.agent_2'};

        const matchedForAgent2 = trie.getMatchingEvents(
          [e1, e2],
          'agent_1.agent_2',
        );
        expect(matchedForAgent2).toEqual([e2]);

        const matchedForAgent = trie.getMatchingEvents(
          [e1, e2],
          'agent_1.agent',
        );
        expect(matchedForAgent).toEqual([e1]);
      });
    });
  });
});
