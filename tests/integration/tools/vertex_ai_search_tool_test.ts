/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Gemini, LlmAgent, LlmRequest, VertexAiSearchTool} from '@google/adk';
import {GenerateContentResponse, GoogleGenAI} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {createRunner} from '../test_case_utils.js';

interface TestTool {
  retrieval?: {
    vertexAiSearch?: {
      datastore?: string;
      dataStoreSpecs?: Array<{dataStore?: string}>;
      engine?: string;
      filter?: string;
      maxResults?: number;
    };
  };
}

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

describe('VertexAiSearchTool Integration', () => {
  it('adds vertexAiSearch config to the LLM request during execution', async () => {
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
    const searchTool = new VertexAiSearchTool({
      dataStoreId: 'projects/p/locations/l/collections/c/dataStores/ds',
    });

    const agent = new LlmAgent({
      model: spyModel,
      name: 'searchAgent',
      description: 'Agent with search tool',
      instruction: 'Search for something',
      tools: [searchTool],
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
    expect(
      (
        spyModel.spyClient.models.lastRequest!.config
          ?.tools?.[0] as unknown as TestTool
      ).retrieval?.vertexAiSearch,
    ).toEqual({
      datastore: 'projects/p/locations/l/collections/c/dataStores/ds',
      dataStoreSpecs: undefined,
      engine: undefined,
      filter: undefined,
      maxResults: undefined,
    });
  });
});
