/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  PluginManager,
  createSession,
} from '@google/adk';
import {ExaSearchTool} from '@google/adk-integrations';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

describe('ExaSearchTool', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const run = (
    args: Record<string, unknown>,
    tool = new ExaSearchTool(),
    abortSignal?: AbortSignal,
  ) =>
    tool.runAsync({
      args,
      toolContext: new Context({
        invocationContext: new InvocationContext({
          invocationId: 'invocation',
          session: createSession({id: 'session', appName: 'test'}),
          pluginManager: new PluginManager(),
          abortSignal,
        }),
      }),
    });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('EXA_API_KEY', 'test-environment-key');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('declares current options and keeps contents developer-configured', () => {
    const parameters = new ExaSearchTool()._getDeclaration().parameters;
    expect(parameters?.required).toEqual(['query']);
    expect(parameters?.properties?.['type']?.enum).toEqual([
      'auto',
      'lite',
      'deep-lite',
      'deep',
      'instant',
      'fast',
      'deep-reasoning',
    ]);
    expect(parameters?.properties?.['category']?.enum).toEqual([
      'company',
      'publication',
      'news',
      'personal site',
      'financial report',
      'people',
    ]);
    for (const field of ['contents', 'includeText', 'excludeText']) {
      expect(parameters?.properties).not.toHaveProperty(field);
    }
  });

  it('uses the environment key and requests bounded highlights by default', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        results: [
          {
            id: 'example',
            title: 'Example',
            url: 'https://example.com',
            highlights: ['Evidence'],
          },
        ],
      }),
    );
    expect(await run({query: '  example  '})).toEqual({
      results: [
        {
          id: 'example',
          title: 'Example',
          url: 'https://example.com',
          highlights: ['Evidence'],
          snippet: 'Evidence',
        },
      ],
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.exa.ai/search');
    expect(options).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'test-environment-key',
        'x-exa-integration': 'adk-js',
      },
    });
    expect(JSON.parse(String(options?.body))).toEqual({
      query: 'example',
      type: 'auto',
      numResults: 5,
      contents: {text: false, highlights: {maxCharacters: 500}},
    });
  });

  it('applies developer contents and bounds oversized provider results', async () => {
    const long = 'x'.repeat(3000);
    const result = {text: long, summary: long, highlights: Array(5).fill(long)};
    fetchMock.mockResolvedValue(
      Response.json({results: Array(12).fill(result)}),
    );
    const response = await run(
      {
        query: 'example',
        numResults: 100,
        type: 'deep-lite',
        category: 'publication',
        includeDomains: ['example.com'],
        startPublishedDate: '2026-01-01T00:00:00Z',
        contents: {text: false},
        includeText: ['ignored'],
      },
      new ExaSearchTool({
        apiKey: 'explicit-test-key',
        contents: {text: true, highlights: true, summary: true},
      }),
    );
    const options = fetchMock.mock.calls[0][1];
    expect(new Headers(options?.headers).get('x-api-key')).toBe(
      'explicit-test-key',
    );
    expect(JSON.parse(String(options?.body))).toEqual({
      query: 'example',
      numResults: 10,
      type: 'deep-lite',
      category: 'publication',
      includeDomains: ['example.com'],
      startPublishedDate: '2026-01-01T00:00:00Z',
      contents: {
        text: {maxCharacters: 1000},
        highlights: {maxCharacters: 500},
        summary: true,
      },
    });
    expect(response).toHaveProperty('results.length', 10);
    expect(response).toHaveProperty('results.0.text.length', 1000);
    expect(response).toHaveProperty('results.0.summary.length', 500);
    expect(response).toHaveProperty('results.0.highlights.length', 3);
    expect(response).toHaveProperty('results.0.highlights.0.length', 500);
    expect(response).toHaveProperty('results.0.snippet.length', 500);
  });

  it('uses configured search defaults and falls back to summary or text', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        results: [
          {url: 'https://example.com/a', summary: 'Summary'},
          {url: 'https://example.com/b', text: 'Page text'},
        ],
      }),
    );
    const tool = new ExaSearchTool({
      type: 'deep-lite',
      category: 'news',
      numResults: 2,
    });

    expect(await run({query: 'example'}, tool)).toMatchObject({
      results: [{snippet: 'Summary'}, {snippet: 'Page text'}],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      type: 'deep-lite',
      category: 'news',
      numResults: 2,
    });
  });

  it.each([
    [{}, 'exa_search requires a non-empty query string.'],
    [{query: '  '}, 'exa_search requires a non-empty query string.'],
    [{query: 42}, 'exa_search requires a non-empty query string.'],
    [{query: 'x', type: 'neural'}, 'Unsupported Exa search type or category.'],
    [
      {query: 'x', category: 'company', startPublishedDate: '2026-01-01'},
      'Company and people searches do not support date filters.',
    ],
    [
      {query: 'x', category: 'people', endPublishedDate: '2026-01-01'},
      'Company and people searches do not support date filters.',
    ],
    [
      {query: 'x', category: 'people', excludeDomains: ['example.com']},
      'People searches do not support excludeDomains.',
    ],
  ])('returns a fixed validation error for %j', async (args, error) => {
    expect(await run(args)).toEqual({error});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates filters against the configured default category', async () => {
    const tool = new ExaSearchTool({category: 'people'});
    expect(
      await run({query: 'x', excludeDomains: ['example.com']}, tool),
    ).toEqual({
      error: 'People searches do not support excludeDomains.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a summary request in lite mode before fetching', async () => {
    const tool = new ExaSearchTool({contents: {summary: true}});
    expect(await run({query: 'x', type: 'lite'}, tool)).toEqual({
      error: 'Lite search does not support summaries. Use auto instead.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports missing credentials without fetching', async () => {
    vi.stubEnv('EXA_API_KEY', undefined);
    expect(await run({query: 'x'})).toEqual({
      error: 'Set EXA_API_KEY or pass apiKey to ExaSearchTool.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 429, 500])(
    'returns a fixed error for HTTP %i',
    async (status) => {
      fetchMock.mockResolvedValue(new Response('provider detail', {status}));
      expect(await run({query: 'x'})).toEqual({error: 'Exa search failed.'});
    },
  );

  it('handles network errors and invalid response bodies', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('network detail'))
      .mockResolvedValueOnce(new Response('invalid JSON'))
      .mockResolvedValueOnce(Response.json({results: null}));
    for (let i = 0; i < 3; i++) {
      expect(await run({query: 'x'})).toEqual({error: 'Exa search failed.'});
    }
  });

  it('skips fetch when the invocation is already cancelled', async () => {
    const signal = AbortSignal.abort();
    expect(await run({query: 'x'}, undefined, signal)).toEqual({
      error: 'Exa search was cancelled.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts an in-flight fetch when the invocation is cancelled', async () => {
    fetchMock.mockImplementation((_url, init) => waitForAbort(init?.signal));
    const caller = new AbortController();
    const pending = run({query: 'x'}, undefined, caller.signal);
    caller.abort(new Error('private cancellation reason'));
    expect(await pending).toEqual({error: 'Exa search was cancelled.'});
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('keeps the timeout active while reading the response body', async () => {
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(deadline.signal);
    const json = vi.fn(() => waitForAbort(deadline.signal));
    const response = Response.json({});
    vi.spyOn(response, 'json').mockImplementation(json);
    fetchMock.mockResolvedValue(response);

    const pending = run({query: 'x'});
    await Promise.resolve();
    expect(json).toHaveBeenCalledOnce();
    deadline.abort(new DOMException('deadline', 'TimeoutError'));
    expect(await pending).toEqual({error: 'Exa search timed out.'});
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(deadline.signal);
  });
});

function waitForAbort(signal?: AbortSignal | null): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) {
      reject(new Error('Missing fetch signal'));
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), {once: true});
  });
}
