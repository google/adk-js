/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmRequest, URL_CONTEXT, UrlContextTool} from '@google/adk';
import {Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';

function makeRequest(model?: string, tools: Tool[] = []): LlmRequest {
  return {
    model,
    config: {tools},
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  } as unknown as LlmRequest;
}

describe('UrlContextTool', () => {
  describe('processLlmRequest', () => {
    it('returns early when model is not set', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest(undefined);
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config?.tools).toEqual([]);
    });

    it('adds urlContext for Gemini 2+ model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-2.0-flash');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('adds urlContext for Gemini 2.5 model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-2.5-pro');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('adds urlContext for path-based Gemini 2+ model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest(
        'projects/test-proj/locations/us-central1/publishers/google/models/gemini-2.0-flash-001',
      );
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('appends urlContext when Gemini 2+ model already has other tools', async () => {
      const tool = new UrlContextTool();
      const existingTool: Tool = {
        functionDeclarations: [{name: 'test_function', description: 'test'}],
      };
      const req = makeRequest('gemini-2.0-flash', [existingTool]);
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([existingTool, {urlContext: {}}]);
    });

    it('throws for Gemini 1.x model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-1.5-pro');
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: {} as never,
        }),
      ).rejects.toThrow(
        'URL context tool requires Gemini 2 or above, but got gemini-1.5-pro',
      );
    });

    it('throws for path-based Gemini 1.x model', async () => {
      const tool = new UrlContextTool();
      const pathModel =
        'projects/test-proj/locations/us-central1/publishers/google/models/gemini-1.5-flash-001';
      const req = makeRequest(pathModel);
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: {} as never,
        }),
      ).rejects.toThrow(
        `URL context tool requires Gemini 2 or above, but got ${pathModel}`,
      );
    });

    it('throws for unsupported (non-Gemini) model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gpt-4');
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: {} as never,
        }),
      ).rejects.toThrow('URL context tool is not supported for model gpt-4');
    });

    it('throws for path-based non-Gemini model', async () => {
      const tool = new UrlContextTool();
      const nonGeminiPath =
        'projects/test-proj/locations/us-central1/publishers/google/models/claude-3-sonnet';
      const req = makeRequest(nonGeminiPath);
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: {} as never,
        }),
      ).rejects.toThrow(
        `URL context tool is not supported for model ${nonGeminiPath}`,
      );
    });

    it.each([
      'my-gemini-2.0-model',
      'custom-gemini-2.5-flash',
      'projects/test-proj/locations/us-central1/publishers/gemini/models/claude-3-sonnet',
    ])(
      'throws for model name %s containing gemini not at the start',
      async (model) => {
        const tool = new UrlContextTool();
        const req = makeRequest(model);
        await expect(
          tool.processLlmRequest({
            llmRequest: req,
            toolContext: {} as never,
          }),
        ).rejects.toThrow(
          `URL context tool is not supported for model ${model}`,
        );
      },
    );

    it('initializes config.tools when config is absent', async () => {
      const tool = new UrlContextTool();
      const req: LlmRequest = {
        model: 'gemini-2.0-flash',
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      } as unknown as LlmRequest;
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });
  });

  it('has a global instance URL_CONTEXT', () => {
    expect(URL_CONTEXT).toBeInstanceOf(UrlContextTool);
  });
});
