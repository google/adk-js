/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Gemini,
  GoogleMapsGroundingTool,
  LlmAgent,
  LlmRequest,
} from '@google/adk';
import {GenerateContentResponse, GoogleGenAI} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {createRunner} from '../test_case_utils.js';

class SpyMockModels {
  lastRequest?: LlmRequest;
  private response: GenerateContentResponse;

  constructor(response: GenerateContentResponse) {
    this.response = response;
  }

  async generateContent(req: LlmRequest): Promise<GenerateContentResponse> {
    this.lastRequest = req;
    return this.response;
  }
}

class SpyMockGenAIClient {
  public models: SpyMockModels;
  public vertexai = false;

  constructor(response: GenerateContentResponse) {
    this.models = new SpyMockModels(response);
  }
}

class SpyGemini extends Gemini {
  public spyClient: SpyMockGenAIClient;

  constructor(response: GenerateContentResponse) {
    super({apiKey: 'test-key'});
    this.spyClient = new SpyMockGenAIClient(response);
  }

  override get apiClient(): GoogleGenAI {
    return this.spyClient as unknown as GoogleGenAI;
  }
}

describe('GoogleMapsGroundingTool Integration', () => {
  it('adds googleMaps config to the LLM request during execution', async () => {
    const mockResponse = new GenerateContentResponse();
    mockResponse.candidates = [
      {
        content: {
          parts: [{text: 'Mock response'}],
          role: 'model',
        },
      },
    ];

    const spyModel = new SpyGemini(mockResponse);
    const mapsTool = new GoogleMapsGroundingTool();

    const agent = new LlmAgent({
      model: spyModel,
      name: 'mapsAgent',
      description: 'Agent with maps tool',
      instruction: 'Search for something on maps',
      tools: [mapsTool],
    });

    const {run} = await createRunner(agent);

    // Run the agent
    for await (const _event of run('Find info about X')) {
      // Consume events
    }

    // Verify the request captured by the spy model
    expect(spyModel.spyClient.models.lastRequest).toBeDefined();
    expect(spyModel.spyClient.models.lastRequest!.config?.tools).toHaveLength(
      1,
    );
    expect(spyModel.spyClient.models.lastRequest!.config?.tools?.[0]).toEqual({
      googleMaps: {},
    });
  });
});
