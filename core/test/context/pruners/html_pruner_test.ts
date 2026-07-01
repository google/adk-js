/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {HtmlPruner, Logger, setLogger} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';

vi.mock('linkedom', async (importOriginal) => {
  const original = await importOriginal<typeof import('linkedom')>();
  return {
    ...original,
    parseHTML: vi.fn().mockImplementation((html: string) => {
      if (html === 'TRIGGER_ERROR') {
        throw new Error('Mocked parseHTML error');
      }
      return original.parseHTML(html);
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

describe('HtmlPruner', () => {
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
    const pruner = new HtmlPruner({});
    expect(pruner.prune(123)).toBe(123);
    expect(pruner.prune({a: 1})).toEqual({a: 1});
    expect(pruner.prune(null)).toBe(null);
  });

  it('should remove elements matching removeSelectors', () => {
    const html =
      '<html><head><style>body { color: red; }</style></head><body><div>Content</div><script>console.log("hello");</script></body></html>';
    const pruner = new HtmlPruner({
      removeSelectors: ['script', 'style'],
    });

    const result = pruner.prune(html) as string;
    expect(result).not.toContain('console.log');
    expect(result).not.toContain('color: red');
    expect(result).toContain('Content');
  });

  it('should keep only elements matching keepSelectors', () => {
    const html =
      '<html><body><div id="nav">Nav</div><div id="content"><h1>Title</h1><p>Para</p></div></body></html>';
    const pruner = new HtmlPruner({
      keepSelectors: ['div#content'],
    });

    const result = pruner.prune(html) as string;
    expect(result).not.toContain('Nav');
    expect(result).toContain('Title');
    expect(result).toContain('Para');
    // It should preserve structure inside kept elements
    expect(result).toContain('<h1>Title</h1>');
  });

  it('should return text content if textOnly is true', () => {
    const html =
      '<html><body><div>Hello <span>World</span></div></body></html>';
    const pruner = new HtmlPruner({
      textOnly: true,
    });

    const result = pruner.prune(html) as string;
    // textContent should be "Hello World" (maybe with whitespace)
    expect(result.trim()).toBe('Hello World');
  });

  it('should combine removeSelectors and keepSelectors', () => {
    const html =
      '<html><body><div id="content"><p>Keep me</p><script>Remove me</script></div><div id="other">Don\'t keep me</div></body></html>';
    const pruner = new HtmlPruner({
      keepSelectors: ['div#content'],
      removeSelectors: ['script'],
    });

    const result = pruner.prune(html) as string;
    expect(result).toContain('Keep me');
    expect(result).not.toContain('Remove me');
    expect(result).not.toContain("Don't keep me");
  });

  it('should return text content of kept elements if both keepSelectors and textOnly are true', () => {
    const html =
      '<html><body><div id="content"><p>Hello</p></div><div id="other"><p>World</p></div></body></html>';
    const pruner = new HtmlPruner({
      keepSelectors: ['div#content'],
      textOnly: true,
    });

    const result = pruner.prune(html) as string;
    expect(result.trim()).toBe('Hello');
    expect(result).not.toContain('World');
  });

  it('should return original HTML and log warning if pruning fails', () => {
    const html = 'TRIGGER_ERROR';
    const pruner = new HtmlPruner({});
    const result = pruner.prune(html);
    expect(result).toBe(html);
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
