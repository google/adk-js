/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GOOGLE_MAPS_GROUNDING,
  GoogleMapsGroundingTool,
  LlmRequest,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function makeRequest(model?: string, tools = []): LlmRequest {
  return {
    model,
    config: {tools},
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  } as unknown as LlmRequest;
}

describe('GoogleMapsGroundingTool', () => {
  describe('processLlmRequest', () => {
    it('returns early when model is not set', async () => {
      const tool = new GoogleMapsGroundingTool();
      const req = makeRequest(undefined);
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config?.tools).toEqual([]);
    });

    it('throws for Gemini 1.x model', async () => {
      const tool = new GoogleMapsGroundingTool();
      const req = makeRequest('gemini-1.5-pro');
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: {} as never,
        }),
      ).rejects.toThrow(
        'Google Maps grounding tool cannot be used with Gemini 1.x models.',
      );
    });

    it('adds googleMaps for Gemini 2+ model', async () => {
      const tool = new GoogleMapsGroundingTool();
      const req = makeRequest('gemini-2.0-flash');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([{googleMaps: {}}]);
    });

    it('throws for unsupported (non-Gemini) model', async () => {
      const tool = new GoogleMapsGroundingTool();
      const req = makeRequest('gpt-4');
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: {} as never,
        }),
      ).rejects.toThrow('Google maps tool is not supported for model gpt-4');
    });

    it('initializes config.tools when config is absent', async () => {
      const tool = new GoogleMapsGroundingTool();
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

      expect(req.config!.tools).toEqual([{googleMaps: {}}]);
    });

    it('adds googleMaps for non-Gemini model when check is disabled', async () => {
      const tool = new GoogleMapsGroundingTool();
      const req = makeRequest('gpt-4');

      const originalValue = process.env.ADK_DISABLE_GEMINI_MODEL_ID_CHECK;
      process.env.ADK_DISABLE_GEMINI_MODEL_ID_CHECK = 'true';

      try {
        await tool.processLlmRequest({
          llmRequest: req,
          toolContext: {} as never,
        });
        expect(req.config!.tools).toEqual([{googleMaps: {}}]);
      } finally {
        if (originalValue === undefined) {
          delete process.env.ADK_DISABLE_GEMINI_MODEL_ID_CHECK;
        } else {
          process.env.ADK_DISABLE_GEMINI_MODEL_ID_CHECK = originalValue;
        }
      }
    });

    it('runAsync returns resolved promise', async () => {
      const tool = new GoogleMapsGroundingTool();
      await expect(tool.runAsync()).resolves.toBeUndefined();
    });
  });

  it('has a global instance GOOGLE_MAPS_GROUNDING', () => {
    expect(GOOGLE_MAPS_GROUNDING).toBeInstanceOf(GoogleMapsGroundingTool);
  });
});
