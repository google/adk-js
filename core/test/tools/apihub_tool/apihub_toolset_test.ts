/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  APIHubToolset,
  BaseAPIHubClient,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  logger,
  PluginManager,
  tokenToSchemeCredential,
} from '@google/adk';
import {YAMLException} from 'js-yaml';
import {afterEach, describe, expect, it, vi} from 'vitest';

const MOCK_SPEC = `
openapi: 3.0.0
info:
  version: 1.0.0
  title: Mock API
  description: Mock API Description
servers:
  - url: https://api.example.com
paths:
  /test:
    get:
      summary: Test GET endpoint
      operationId: testGet
      responses:
        '200':
          description: Successful response
`;

const NO_TITLE_SPEC = `
openapi: 3.0.0
info:
  version: 1.0.0
paths:
  /empty_desc_test:
    delete:
      summary: Test DELETE endpoint
      operationId: emptyDescTest
      responses:
        '200':
          description: Successful response
`;

const NO_DESCRIPTION_SPEC = `
openapi: 3.0.0
info:
  version: 1.0.0
  title: Empty Description API
paths:
  /empty_desc_test:
    delete:
      summary: Test DELETE endpoint
      operationId: emptyDescTest
      responses:
        '200':
          description: Successful response
`;

function mockClient(spec: string) {
  const getSpecContent = vi.fn(async (_path: string) => spec);
  const client: BaseAPIHubClient = {getSpecContent};
  return {client, getSpecContent};
}

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'invocation-1',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'session-1', appName: 'test_app'}),
      pluginManager: new PluginManager(),
    }),
  });
}

describe('APIHubToolset experimental warning', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs an experimental warning once when constructed', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const {client} = mockClient(MOCK_SPEC);

    new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: client,
      lazyLoadSpec: true,
    });
    new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: client,
      lazyLoadSpec: true,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'Class APIHubToolset is experimental and may change in the future.',
    );
  });
});

describe('APIHubToolset', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('builds tools and fills the name and description from the spec', async () => {
    const {client, getSpecContent} = mockClient(MOCK_SPEC);
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: client,
    });

    const tools = await toolset.getTools();

    expect(getSpecContent).toHaveBeenCalledWith('test_resource');
    expect(toolset.name).toBe('mock_api');
    expect(toolset.description).toBe('Mock API Description');
    expect(toolset.apihubResourceName).toBe('test_resource');
    expect(toolset.lazyLoadSpec).toBe(false);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('test_get');
    expect(await toolset.getTool('test_get')).toBeDefined();
  });

  it('returns undefined for a tool the spec does not define', async () => {
    const {client} = mockClient(MOCK_SPEC);
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: client,
    });

    expect(await toolset.getTool('missing_tool')).toBeUndefined();
  });

  it('fetches the spec only on first use when loading lazily', async () => {
    const {client, getSpecContent} = mockClient(MOCK_SPEC);
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: client,
      lazyLoadSpec: true,
    });

    expect(toolset.lazyLoadSpec).toBe(true);
    expect(getSpecContent).not.toHaveBeenCalled();

    const tools = await toolset.getTools();

    expect(getSpecContent).toHaveBeenCalledTimes(1);
    expect(tools).toHaveLength(1);
    expect(await toolset.getTool('test_get')).toBe(tools[0]);
    expect(getSpecContent).toHaveBeenCalledTimes(1);
  });

  it('names the toolset unnamed when the spec has no title', async () => {
    const {client} = mockClient(NO_TITLE_SPEC);
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: client,
    });

    await toolset.getTools();

    expect(toolset.name).toBe('unnamed');
  });

  it('leaves the description empty when the spec has none', async () => {
    const {client} = mockClient(NO_DESCRIPTION_SPEC);
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: client,
    });

    await toolset.getTools();

    expect(toolset.name).toBe('empty_description_api');
    expect(toolset.description).toBe('');
  });

  it('keeps an explicit name and description', async () => {
    const {client} = mockClient(MOCK_SPEC);
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: client,
      name: 'my_toolset',
      description: 'My description',
    });

    await toolset.getTools();

    expect(toolset.name).toBe('my_toolset');
    expect(toolset.description).toBe('My description');
  });

  it('applies the auth scheme and credential to every tool', async () => {
    const [authScheme, authCredential] = tokenToSchemeCredential(
      'apikey',
      'header',
      'X-API-Key',
      'secret-key',
    );
    const {client} = mockClient(MOCK_SPEC);
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: client,
      authScheme,
      authCredential,
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {get: () => 'application/json'},
      json: async () => ({}),
      text: async () => '{}',
    });
    globalThis.fetch = fetchMock;

    const tools = await toolset.getTools();
    expect(tools).toHaveLength(1);
    const tool = await toolset.getTool('test_get');
    await tool!.runAsync({args: {}, toolContext: createToolContext()});

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/test',
      expect.objectContaining({
        headers: expect.objectContaining({'X-API-Key': 'secret-key'}),
      }),
    );
  });

  it('returns no tools for an empty spec when loading lazily', async () => {
    const {client} = mockClient('');
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: client,
      lazyLoadSpec: true,
    });

    expect(await toolset.getTools()).toEqual([]);
    expect(await toolset.getTool('test_get')).toBeUndefined();
  });

  it('rejects with a YAMLException for invalid YAML', async () => {
    const {client} = mockClient('{invalid yaml');
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: client,
    });

    await expect(toolset.getTools()).rejects.toBeInstanceOf(YAMLException);
  });

  it('fetches the spec once, at construction, when loading eagerly', async () => {
    const {client, getSpecContent} = mockClient(MOCK_SPEC);
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: client,
    });

    expect(getSpecContent).toHaveBeenCalledTimes(1);

    await toolset.getTools();
    await toolset.getTool('test_get');

    expect(getSpecContent).toHaveBeenCalledTimes(1);
  });

  it('reports an eager fetch failure from getTools without an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const failure = new Error('API Hub is unavailable');
      const client: BaseAPIHubClient = {
        getSpecContent: vi.fn().mockRejectedValue(failure),
      };
      const toolset = new APIHubToolset({
        apihubResourceName: 'test_resource',
        apihubClient: client,
      });

      // Give Node a chance to report the rejection before anything awaits it.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).not.toHaveBeenCalled();
      await expect(toolset.getTools()).rejects.toBe(failure);
      await expect(toolset.getTool('test_get')).rejects.toBe(failure);
      expect(client.getSpecContent).toHaveBeenCalledTimes(1);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('fetches again after a lazy fetch fails', async () => {
    const failure = new Error('API Hub is unavailable');
    const getSpecContent = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(MOCK_SPEC);
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: {getSpecContent},
      lazyLoadSpec: true,
    });

    await expect(toolset.getTools()).rejects.toBe(failure);
    expect(await toolset.getTools()).toHaveLength(1);
    expect(getSpecContent).toHaveBeenCalledTimes(2);
  });

  it('closes without error', async () => {
    const {client} = mockClient(MOCK_SPEC);
    const toolset = new APIHubToolset({
      apihubResourceName: 'test_resource',
      apihubClient: client,
      lazyLoadSpec: true,
    });

    await expect(toolset.close()).resolves.toBeUndefined();
  });
});
