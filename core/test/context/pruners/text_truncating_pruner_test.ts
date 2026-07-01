/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Logger, setLogger, TextTruncatingPruner} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';

interface MockLogger extends Logger {
  log: Mock;
  debug: Mock;
  info: Mock;
  warn: Mock;
  error: Mock;
  setLogLevel: Mock;
}

describe('TextTruncatingPruner', () => {
  let mockLogger: MockLogger;

  beforeEach(() => {
    mockLogger = {
      log: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      setLogLevel: vi.fn(),
    } as unknown as MockLogger;
    setLogger(mockLogger);
  });

  afterEach(() => {
    setLogger(null);
  });

  it('should return input as-is if it is not a string', () => {
    const pruner = new TextTruncatingPruner({maxLength: 10});
    expect(pruner.prune(123)).toBe(123);
    expect(pruner.prune({a: 1})).toEqual({a: 1});
    expect(pruner.prune(null)).toBe(null);
  });

  it('should not truncate if length is under maxLength', () => {
    const pruner = new TextTruncatingPruner({maxLength: 20});
    expect(pruner.prune('short')).toBe('short');
  });

  describe('maxLength truncation', () => {
    const text = '1234567890'; // 10 chars

    it('should keep start', () => {
      const pruner = new TextTruncatingPruner({
        maxLength: 5,
        keepLocation: 'start',
        truncationMarker: '...',
      });
      // 5 chars limit. We keep 5 chars from start?
      // Wait, does the limit include the marker?
      // "Postconditions: The size of the returned/modified response should be less than or equal to the original response."
      // If we keep 5 chars AND add '...', total is 8, which is less than 10, but more than 5.
      // If maxLength is strict limit for TOTAL length, we must keep only (maxLength - marker.length) chars.
      // Let's assume maxLength is strict.
      // If maxLength is 5, and marker is '...', we keep 2 chars from start.
      // 12... (length 5)
      // Let's test this behavior.
      expect(pruner.prune(text)).toBe('12...');
    });

    it('should keep end', () => {
      const pruner = new TextTruncatingPruner({
        maxLength: 5,
        keepLocation: 'end',
        truncationMarker: '...',
      });
      // ...90 (length 5)
      expect(pruner.prune(text)).toBe('...90');
    });

    it('should keep both (default)', () => {
      const pruner = new TextTruncatingPruner({
        maxLength: 6,
        keepLocation: 'both',
        truncationMarker: '..',
      });
      // Keep 2 from start, 2 from end: 12..90 (length 6)
      expect(pruner.prune(text)).toBe('12..90');
    });

    it('should handle odd maxLength when keeping both', () => {
      const pruner = new TextTruncatingPruner({
        maxLength: 7,
        keepLocation: 'both',
        truncationMarker: '..',
      });
      // 7 - 2 = 5 budget.
      // Start gets 3, end gets 2 (or vice versa).
      // Let's say start gets more or equal: 123..90 (length 7)
      expect(pruner.prune(text)).toBe('123..90');
    });
  });

  describe('maxLines truncation', () => {
    const text = 'line1\nline2\nline3\nline4\nline5'; // 5 lines

    it('should keep start lines', () => {
      const pruner = new TextTruncatingPruner({
        maxLines: 3,
        keepLocation: 'start',
        truncationMarker: '...',
      });
      // Keep 3 lines. Does it include marker as line?
      // Usually line truncation replaces remaining lines with marker.
      // line1\nline2\nline3\n...
      expect(pruner.prune(text)).toBe('line1\nline2\nline3\n...');
    });

    it('should keep end lines', () => {
      const pruner = new TextTruncatingPruner({
        maxLines: 3,
        keepLocation: 'end',
        truncationMarker: '...',
      });
      // ...\nline3\nline4\nline5
      expect(pruner.prune(text)).toBe('...\nline3\nline4\nline5');
    });

    it('should keep both lines', () => {
      const pruner = new TextTruncatingPruner({
        maxLines: 4,
        keepLocation: 'both',
        truncationMarker: '...',
      });
      // Keep 2 start, 2 end: line1\nline2\n...\nline4\nline5
      expect(pruner.prune(text)).toBe('line1\nline2\n...\nline4\nline5');
    });
  });

  it('should use default marker if not specified', () => {
    const pruner = new TextTruncatingPruner({
      maxLength: 5,
      keepLocation: 'start',
    });
    // Default marker '...'
    // Keep 2 chars: 12...
    expect(pruner.prune('1234567890')).toBe('12...');
  });

  it('should use default keepLocation (both) if not specified', () => {
    const pruner = new TextTruncatingPruner({maxLength: 6});
    // Default marker '...' (len 3)
    // Budget 3. Keep 2 start, 1 end? or 1 start, 2 end?
    // Let's define the split. If budget is odd, say start gets more.
    // Budget 3 -> 2 start, 1 end.
    // 12...0 (len 6)
    // Let's check what we implement.
    // If budget is 3, start = ceil(3/2) = 2, end = floor(3/2) = 1.
    expect(pruner.prune('1234567890')).toBe('12...0');
  });

  it('should return original if maxLength is too small for marker', () => {
    const pruner = new TextTruncatingPruner({
      maxLength: 2,
      truncationMarker: '...',
    });
    expect(pruner.prune('12345')).toBe('12345');
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
