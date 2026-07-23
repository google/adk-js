/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ENTERPRISE_WEB_SEARCH,
  EnterpriseWebSearchTool,
  LlmRequest,
} from '@google/adk';
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

describe('EnterpriseWebSearchTool', () => {
  describe('processLlmRequest', () => {
    it('returns early when model is not set', async () => {
      const tool = new EnterpriseWebSearchTool();
      const req = makeRequest(undefined);
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config?.tools).toEqual([]);
    });

    it('adds enterpriseWebSearch for Gemini 2+ model', async () => {
      const tool = new EnterpriseWebSearchTool();
      const req = makeRequest('gemini-2.0-flash');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([{enterpriseWebSearch: {}}]);
    });

    it('adds enterpriseWebSearch for path-form Gemini 2+ model', async () => {
      const tool = new EnterpriseWebSearchTool();
      const req = makeRequest(
        'projects/test-project/locations/global/publishers/google/models/gemini-2.5-flash',
      );
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([{enterpriseWebSearch: {}}]);
    });

    it('initializes config.tools when config is absent', async () => {
      const tool = new EnterpriseWebSearchTool();
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

      expect(req.config!.tools).toEqual([{enterpriseWebSearch: {}}]);
    });

    it('adds enterpriseWebSearch for Gemini 1.x model with no other tools', async () => {
      const tool = new EnterpriseWebSearchTool();
      const req = makeRequest('gemini-1.5-pro');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([{enterpriseWebSearch: {}}]);
    });

    it('throws when Gemini 1.x model already has other tools', async () => {
      const tool = new EnterpriseWebSearchTool();
      const req = makeRequest('gemini-1.5-flash', [{googleSearch: {}}]);
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: {} as never,
        }),
      ).rejects.toThrow(
        'Enterprise Web Search tool cannot be used with other tools in Gemini 1.x.',
      );
    });

    it('throws for unsupported (non-Gemini) model', async () => {
      const tool = new EnterpriseWebSearchTool();
      const req = makeRequest('gpt-4o');
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: {} as never,
        }),
      ).rejects.toThrow(
        'Enterprise Web Search tool is not supported for model gpt-4o',
      );
    });

    it('adds enterpriseWebSearch for non-Gemini model when check is disabled', async () => {
      const tool = new EnterpriseWebSearchTool();
      const req = makeRequest('internal-model-v1');

      const originalValue = process.env.ADK_DISABLE_GEMINI_MODEL_ID_CHECK;
      process.env.ADK_DISABLE_GEMINI_MODEL_ID_CHECK = 'true';

      try {
        await tool.processLlmRequest({
          llmRequest: req,
          toolContext: {} as never,
        });
        expect(req.config!.tools).toEqual([{enterpriseWebSearch: {}}]);
      } finally {
        if (originalValue === undefined) {
          delete process.env.ADK_DISABLE_GEMINI_MODEL_ID_CHECK;
        } else {
          process.env.ADK_DISABLE_GEMINI_MODEL_ID_CHECK = originalValue;
        }
      }
    });

    it('runAsync returns resolved promise', async () => {
      const tool = new EnterpriseWebSearchTool();
      await expect(tool.runAsync()).resolves.toBeUndefined();
    });
  });

  it('has a global instance ENTERPRISE_WEB_SEARCH', () => {
    expect(ENTERPRISE_WEB_SEARCH).toBeInstanceOf(EnterpriseWebSearchTool);
  });
});
