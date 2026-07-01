/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {JsonPathPruner, Logger, setLogger} from '@google/adk';
import {Mock, afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface JsonPathOptions {
  path: string;
}

vi.mock('jsonpath-plus', async (importOriginal) => {
  const original = await importOriginal<typeof import('jsonpath-plus')>();
  return {
    ...original,
    JSONPath: vi.fn().mockImplementation((options: JsonPathOptions) => {
      if (options.path === 'TRIGGER_ERROR') {
        throw new Error('Mocked JSONPath error');
      }
      return original.JSONPath(options);
    }),
  };
});

interface MockLogger extends Logger {
  log: Mock;
  debug: Mock;
  info: Mock;
  warn: Mock;
  error: Mock;
  setLogLevel: Mock;
}

describe('JsonPathPruner', () => {
  let mockLogger: MockLogger;

  beforeEach(() => {
    mockLogger = {
      log: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      setLogLevel: vi.fn(),
    };
    setLogger(mockLogger);
  });

  afterEach(() => {
    setLogger(null); // Reset to default/noop
  });

  it('should return input as-is if it is not an object', () => {
    const pruner = new JsonPathPruner({paths: ['$.a']});
    expect(pruner.prune('not an object')).toBe('not an object');
    expect(pruner.prune(123)).toBe(123);
    expect(pruner.prune(null)).toBe(null);
    expect(pruner.prune(undefined)).toBe(undefined);
    expect(pruner.prune(true)).toBe(true);
  });

  it('should prune object keeping only specified paths', () => {
    const data = {
      items: [
        {id: 1, name: 'item1', details: 'large 1'},
        {id: 2, name: 'item2', details: 'large 2'},
      ],
      other: 'stuff',
    };

    const pruner = new JsonPathPruner({
      paths: ['$.items[*].id', '$.items[*].name'],
    });

    const expected = {
      items: [
        {id: 1, name: 'item1'},
        {id: 2, name: 'item2'},
      ],
    };

    expect(pruner.prune(data)).toEqual(expected);
  });

  it('should handle nested paths', () => {
    const data = {
      a: {
        b: {
          c: 1,
          d: 2,
        },
        e: 3,
      },
    };

    const pruner = new JsonPathPruner({
      paths: ['$.a.b.c'],
    });

    const expected = {
      a: {
        b: {
          c: 1,
        },
      },
    };

    expect(pruner.prune(data)).toEqual(expected);
  });

  it('should return empty object if no paths match', () => {
    const data = {a: 1, b: 2};
    const pruner = new JsonPathPruner({paths: ['$.c']});
    expect(pruner.prune(data)).toEqual({});
  });

  it('should log warning and return original if pruning fails (e.g. invalid path)', () => {
    const data = {a: 1};
    const pruner = new JsonPathPruner({paths: ['TRIGGER_ERROR']});

    const result = pruner.prune(data);
    expect(result).toEqual(data);
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
