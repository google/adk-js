/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Type} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {Context, ExaSearchTool} from '@google/adk';

interface FakeExaClient {
  search: ReturnType<typeof vi.fn>;
  headers: {set: ReturnType<typeof vi.fn>};
}

function makeFakeClient(
  searchImpl: (...args: unknown[]) => unknown,
): FakeExaClient {
  return {
    search: vi.fn(searchImpl),
    headers: {set: vi.fn()},
  };
}

function injectClient(tool: ExaSearchTool, client: FakeExaClient): void {
  (tool as unknown as {client: FakeExaClient}).client = client;
}

const ORIGINAL_API_KEY = process.env['EXA_API_KEY'];

describe('ExaSearchTool', () => {
  beforeEach(() => {
    delete process.env['EXA_API_KEY'];
  });

  afterEach(() => {
    if (ORIGINAL_API_KEY === undefined) {
      delete process.env['EXA_API_KEY'];
    } else {
      process.env['EXA_API_KEY'] = ORIGINAL_API_KEY;
    }
    vi.restoreAllMocks();
  });

  it('exposes a function declaration with the expected schema', () => {
    const tool = new ExaSearchTool();
    const declaration = tool._getDeclaration();

    expect(declaration?.name).toEqual('exa_search');
    expect(declaration?.description).toContain('Exa AI search API');
    expect(declaration?.parameters?.type).toEqual(Type.OBJECT);
    expect(declaration?.parameters?.required).toEqual(['query']);
    expect(declaration?.parameters?.properties?.['query']?.type).toEqual(
      Type.STRING,
    );
    expect(declaration?.parameters?.properties?.['type']?.enum).toEqual([
      'auto',
      'fast',
      'neural',
      'hybrid',
      'instant',
    ]);
  });

  it('throws a clear error when no API key is configured', async () => {
    const tool = new ExaSearchTool();
    await expect(
      tool.runAsync({
        args: {query: 'hello'},
        toolContext: {} as unknown as Context,
      }),
    ).rejects.toThrow(/EXA_API_KEY/);
  });

  it('passes query and configured defaults to the Exa client', async () => {
    const fakeClient = makeFakeClient(() =>
      Promise.resolve({
        results: [
          {
            id: 'a1',
            url: 'https://example.com/a',
            title: 'Result A',
            highlights: ['snippet from A'],
          },
        ],
      }),
    );
    const tool = new ExaSearchTool({
      apiKey: 'fake-key',
      type: 'neural',
      numResults: 3,
    });
    injectClient(tool, fakeClient);

    const response = (await tool.runAsync({
      args: {query: 'agents'},
      toolContext: {} as unknown as Context,
    })) as {results: Array<Record<string, unknown>>};

    expect(fakeClient.search).toHaveBeenCalledTimes(1);
    expect(fakeClient.search).toHaveBeenCalledWith('agents', {
      type: 'neural',
      numResults: 3,
      contents: {highlights: true},
    });
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      id: 'a1',
      url: 'https://example.com/a',
      title: 'Result A',
      snippet: 'snippet from A',
      highlights: ['snippet from A'],
    });
  });

  it('lets per-call args override constructor defaults and forwards filters', async () => {
    const fakeClient = makeFakeClient(() => Promise.resolve({results: []}));
    const tool = new ExaSearchTool({apiKey: 'fake-key'});
    injectClient(tool, fakeClient);

    await tool.runAsync({
      args: {
        query: 'fusion energy',
        type: 'fast',
        numResults: 7,
        category: 'research paper',
        includeDomains: ['arxiv.org'],
        excludeDomains: ['reddit.com'],
        includeText: ['tokamak'],
        excludeText: ['stellarator'],
        startPublishedDate: '2024-01-01',
        endPublishedDate: '2025-01-01',
      },
      toolContext: {} as unknown as Context,
    });

    expect(fakeClient.search).toHaveBeenCalledWith('fusion energy', {
      type: 'fast',
      numResults: 7,
      contents: {highlights: true},
      category: 'research paper',
      includeDomains: ['arxiv.org'],
      excludeDomains: ['reddit.com'],
      includeText: ['tokamak'],
      excludeText: ['stellarator'],
      startPublishedDate: '2024-01-01',
      endPublishedDate: '2025-01-01',
    });
  });

  it('clamps numResults to the API range of 1-100', async () => {
    const fakeClient = makeFakeClient(() => Promise.resolve({results: []}));
    const tool = new ExaSearchTool({apiKey: 'fake-key'});
    injectClient(tool, fakeClient);

    await tool.runAsync({
      args: {query: 'q', numResults: 500},
      toolContext: {} as unknown as Context,
    });
    await tool.runAsync({
      args: {query: 'q', numResults: 0},
      toolContext: {} as unknown as Context,
    });

    expect(fakeClient.search).toHaveBeenNthCalledWith(
      1,
      'q',
      expect.objectContaining({numResults: 100}),
    );
    expect(fakeClient.search).toHaveBeenNthCalledWith(
      2,
      'q',
      expect.objectContaining({numResults: 1}),
    );
  });

  it('falls back from highlights to summary to text when building the snippet', async () => {
    const fakeClient = makeFakeClient(() =>
      Promise.resolve({
        results: [
          {
            id: '1',
            url: 'https://a.test',
            title: 'A',
            highlights: ['hi'],
          },
          {
            id: '2',
            url: 'https://b.test',
            title: 'B',
            summary: 'sum',
          },
          {
            id: '3',
            url: 'https://c.test',
            title: 'C',
            text: 'long body text '.repeat(50),
          },
          {
            id: '4',
            url: 'https://d.test',
            title: 'D',
          },
        ],
      }),
    );
    const tool = new ExaSearchTool({apiKey: 'fake-key'});
    injectClient(tool, fakeClient);

    const response = (await tool.runAsync({
      args: {query: 'test'},
      toolContext: {} as unknown as Context,
    })) as {results: Array<{snippet: string}>};

    expect(response.results[0].snippet).toEqual('hi');
    expect(response.results[1].snippet).toEqual('sum');
    expect(response.results[2].snippet.length).toBeLessThanOrEqual(500);
    expect(response.results[2].snippet.length).toBeGreaterThan(0);
    expect(response.results[3].snippet).toEqual('');
  });

  it('throws if query is missing or not a string', async () => {
    const tool = new ExaSearchTool({apiKey: 'fake-key'});
    injectClient(
      tool,
      makeFakeClient(() => Promise.resolve({results: []})),
    );

    await expect(
      tool.runAsync({
        args: {} as Record<string, unknown>,
        toolContext: {} as unknown as Context,
      }),
    ).rejects.toThrow(/non-empty `query`/);

    await expect(
      tool.runAsync({
        args: {query: 42 as unknown as string},
        toolContext: {} as unknown as Context,
      }),
    ).rejects.toThrow(/non-empty `query`/);
  });

  it('reads EXA_API_KEY from the environment when no apiKey is passed', () => {
    process.env['EXA_API_KEY'] = 'env-key';
    const tool = new ExaSearchTool();
    // getClient is private; invoke it indirectly via runAsync. Stub fetch by
    // replacing the client right after lazy construction.
    expect(() =>
      (tool as unknown as {getClient: () => unknown}).getClient(),
    ).not.toThrow();
  });
});
