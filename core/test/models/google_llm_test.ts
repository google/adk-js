/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import 'jasmine';

import {Gemini, GeminiParams} from '@google/adk';

import {version} from '../../src/version.js';

class TestGemini extends Gemini {
  constructor(params: GeminiParams) {
    super(params);
  }
  getTrackingHeaders(): Record<string, string> {
    return this.trackingHeaders;
  }
}

describe('GoogleLlm', () => {
  it('should set tracking headers correctly when GOOGLE_CLOUD_AGENT_ENGINE_ID is not set',
     () => {
       const llm = new TestGemini({apiKey: 'test-key'});
       const headers = llm.getTrackingHeaders();
       const expectedValue =
           `google-adk/${version} gl-typescript/${process.version}`;
       expect(headers['x-goog-api-client']).toEqual(expectedValue);
       expect(headers['user-agent']).toEqual(expectedValue);
     });

  it('should set tracking headers correctly when GOOGLE_CLOUD_AGENT_ENGINE_ID is set',
     () => {
       process.env['GOOGLE_CLOUD_AGENT_ENGINE_ID'] = 'test-engine';
       const llm = new TestGemini({apiKey: 'test-key'});
       const headers = llm.getTrackingHeaders();
       const expectedValue = `google-adk/${
           version}+remote_reasoning_engine gl-typescript/${process.version}`;
       expect(headers['x-goog-api-client']).toEqual(expectedValue);
       expect(headers['user-agent']).toEqual(expectedValue);
     });
});
