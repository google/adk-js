/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BuiltInCodeExecutor, LlmRequest} from '@google/adk';

describe('BuiltInCodeExecutor', () => {
  let executor: BuiltInCodeExecutor;

  beforeEach(() => {
    executor = new BuiltInCodeExecutor();
  });

  it('executeCode should return dummy values', async () => {
    const result = await executor.executeCode({} as any);
    expect(result).toEqual({
      stdout: '',
      stderr: '',
      outputFiles: [],
    });
  });

  it('processLlmRequest should throw error if model is not provided', () => {
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    expect(() => executor.processLlmRequest(llmRequest))
        .toThrowError(
            'Gemini code execution tool is not supported for model undefined');
  });

  it('processLlmRequest should not throw error if model is valid', () => {
    const llmRequest: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    expect(() => executor.processLlmRequest(llmRequest)).not.toThrow();
    expect(llmRequest.config?.tools).toEqual([{codeExecution: {}}]);
  });

  it('processLlmRequest should throw error if model is invalid', () => {
    const llmRequest: LlmRequest = {
      model: 'invalid-model',
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    expect(() => executor.processLlmRequest(llmRequest))
        .toThrowError(
            'Gemini code execution tool is not supported for model invalid-model');
  });
});
