/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  LlmRequest,
  LlmResponse,
  isBaseLlm,
  runWithClientLabel,
  version,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class TestLlm extends BaseLlm {
  constructor() {
    super({model: 'test-llm'});
  }
  generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    throw new Error('Not implemented');
  }
  connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Not implemented');
  }
  getTrackingHeaders(): Record<string, string> {
    return this.trackingHeaders;
  }
}

class FakeLlm {
  private readonly model: string = 'fake-llm';

  generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    throw new Error('Not implemented');
  }
  connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Not implemented');
  }
}

describe('BaseLlm', () => {
  it('should set tracking headers correctly when GOOGLE_CLOUD_AGENT_ENGINE_ID is not set', () => {
    delete process.env['GOOGLE_CLOUD_AGENT_ENGINE_ID'];
    const llm = new TestLlm();
    const headers = llm.getTrackingHeaders();
    const expectedValue = `google-adk/${version} gl-typescript/${process.version}`;
    expect(headers['x-goog-api-client']).toEqual(expectedValue);
    expect(headers['user-agent']).toEqual(expectedValue);
  });

  it('should set tracking headers correctly when GOOGLE_CLOUD_AGENT_ENGINE_ID is set', () => {
    process.env['GOOGLE_CLOUD_AGENT_ENGINE_ID'] = 'test-engine';
    const llm = new TestLlm();
    const headers = llm.getTrackingHeaders();
    const expectedValue = `google-adk/${
      version
    }+remote_reasoning_engine gl-typescript/${process.version}`;
    expect(headers['x-goog-api-client']).toEqual(expectedValue);
    expect(headers['user-agent']).toEqual(expectedValue);
  });

  it('should include context client label in tracking headers when run within runWithClientLabel', () => {
    const llm = new TestLlm();
    const customLabel = 'my-custom-label';
    runWithClientLabel(customLabel, () => {
      const headers = llm.getTrackingHeaders();
      expect(headers['x-goog-api-client']).toContain(customLabel);
      expect(headers['user-agent']).toContain(customLabel);
    });
  });

  describe('maybeAppendUserContent', () => {
    it('should append a user prompt when contents is empty', () => {
      const llm = new TestLlm();
      const llmRequest: LlmRequest = {
        contents: [],
        liveConnectConfig: {},
        toolsDict: {},
      };

      llm.maybeAppendUserContent(llmRequest);

      expect(llmRequest.contents).toEqual([
        {
          role: 'user',
          parts: [
            {
              text: 'Handle the requests as specified in the System Instruction.',
            },
          ],
        },
      ]);
    });

    it('should append a continuation user prompt when contents has no user message', () => {
      const llm = new TestLlm();
      const llmRequest: LlmRequest = {
        contents: [
          {
            role: 'developer',
            parts: [{text: 'Test prompt'}],
          },
        ],
        liveConnectConfig: {},
        toolsDict: {},
      };

      llm.maybeAppendUserContent(llmRequest);

      expect(llmRequest.contents).toHaveLength(2);
      expect(llmRequest.contents[1]).toEqual({
        role: 'user',
        parts: [
          {
            text: 'Continue processing previous requests as instructed. Exit or provide a summary if no more outputs are needed.',
          },
        ],
      });
    });

    it('should not append user content when the last message is from user', () => {
      const llm = new TestLlm();
      const llmRequest: LlmRequest = {
        contents: [
          {
            role: 'user',
            parts: [{text: 'user prompt'}],
          },
        ],
        liveConnectConfig: {},
        toolsDict: {},
      };

      llm.maybeAppendUserContent(llmRequest);

      expect(llmRequest.contents).toHaveLength(1);
      expect(llmRequest.contents[0]).toEqual({
        role: 'user',
        parts: [{text: 'user prompt'}],
      });
    });

    it('should append a continuation user prompt when user content is not the last message', () => {
      const llm = new TestLlm();
      const llmRequest: LlmRequest = {
        contents: [
          {
            role: 'model',
            parts: [{text: 'model prompt'}],
          },
          {
            role: 'user',
            parts: [{text: 'user prompt'}],
          },
          {
            role: 'model',
            parts: [{text: 'model prompt'}],
          },
        ],
        liveConnectConfig: {},
        toolsDict: {},
      };

      llm.maybeAppendUserContent(llmRequest);

      expect(llmRequest.contents).toHaveLength(4);
      expect(llmRequest.contents[3]).toEqual({
        role: 'user',
        parts: [
          {
            text: 'Continue processing previous requests as instructed. Exit or provide a summary if no more outputs are needed.',
          },
        ],
      });
    });
  });
});

describe('isBaseLlm', () => {
  it('should return true for BaseLlm', () => {
    const llm = new TestLlm();
    expect(isBaseLlm(llm)).toBe(true);
  });

  it('should return false for non-BaseLlm', () => {
    expect(isBaseLlm(123)).toBe(false);
  });

  it('should return false for null', () => {
    expect(
      isBaseLlm({
        model: 'test-llm',
      }),
    ).toBe(false);
  });

  it('should return false for FakeLlm instance (not extending BaseLlm)', () => {
    expect(isBaseLlm(new FakeLlm())).toBe(false);
  });
});
