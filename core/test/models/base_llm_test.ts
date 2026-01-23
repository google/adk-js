/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseLlm, BaseLlmConnection, isBaseLlm, LlmRequest, LlmResponse} from '@google/adk';

import {version} from '../../src/version.js';

class TestLlm extends BaseLlm {
  constructor() {
    super({model: 'test-llm'});
  }
  generateContentAsync(
      llmRequest: LlmRequest,
      stream?: boolean,
      ): AsyncGenerator<LlmResponse, void> {
    throw new Error('Not implemented');
  }
  connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Not implemented');
  }
  getTrackingHeaders(): Record<string, string> {
    return this.trackingHeaders;
  }
}

class FakeLlm {
  private readonly model: string = 'fake-llm';

  generateContentAsync(
      llmRequest: LlmRequest,
      stream?: boolean,
      ): AsyncGenerator<LlmResponse, void> {
    throw new Error('Not implemented');
  }
  connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Not implemented');
  }
}

describe('BaseLlm', () => {
  it('should set tracking headers correctly when GOOGLE_CLOUD_AGENT_ENGINE_ID is not set',
     () => {
       delete process.env['GOOGLE_CLOUD_AGENT_ENGINE_ID'];
       const llm = new TestLlm();
       const headers = llm.getTrackingHeaders();
       const expectedValue =
           `google-adk/${version} gl-typescript/${process.version}`;
       expect(headers['x-goog-api-client']).toEqual(expectedValue);
       expect(headers['user-agent']).toEqual(expectedValue);
     });

  it('should set tracking headers correctly when GOOGLE_CLOUD_AGENT_ENGINE_ID is set',
     () => {
       process.env['GOOGLE_CLOUD_AGENT_ENGINE_ID'] = 'test-engine';
       const llm = new TestLlm();
       const headers = llm.getTrackingHeaders();
       const expectedValue = `google-adk/${
           version}+remote_reasoning_engine gl-typescript/${process.version}`;
       expect(headers['x-goog-api-client']).toEqual(expectedValue);
       expect(headers['user-agent']).toEqual(expectedValue);
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
    expect(isBaseLlm({
      model: 'test-llm',
    })).toBe(false);
  });

  it('should return false for FakeLlm instance (not extending BaseLlm)', () => {
    expect(isBaseLlm(new FakeLlm())).toBe(false);
  });
});
