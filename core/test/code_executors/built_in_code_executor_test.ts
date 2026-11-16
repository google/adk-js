/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ExecuteCodeParams} from '@google/adk';
import {BuiltInCodeExecutor, LlmRequest} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

describe('BuiltInCodeExecutor', () => {
  let executor: BuiltInCodeExecutor;

  beforeEach(() => {
    executor = new BuiltInCodeExecutor();
  });

  it('executeCode should return dummy values', async () => {
    const result = await executor.executeCode(
      {} as unknown as ExecuteCodeParams,
    );
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
    expect(() => executor.processLlmRequest(llmRequest)).toThrowError(
      'Gemini code execution tool is not supported for model undefined',
    );
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

  it('processLlmRequest should accept a full Vertex AI model resource name', () => {
    const llmRequest: LlmRequest = {
      model:
        'projects/my-project/locations/us-central1/publishers/google/models/gemini-2.0-flash-001',
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
    expect(() => executor.processLlmRequest(llmRequest)).toThrowError(
      'Gemini code execution tool is not supported for model invalid-model',
    );
  });

  it('processLlmRequest should initialize tools when config exists without tools', () => {
    const llmRequest: LlmRequest = {
      model: 'gemini-2.5-flash',
      config: {},
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    executor.processLlmRequest(llmRequest);

    expect(llmRequest.config?.tools).toEqual([{codeExecution: {}}]);
  });

  it('processLlmRequest should append codeExecution when config.tools is empty', () => {
    const llmRequest: LlmRequest = {
      model: 'gemini-2.5-flash',
      config: {tools: []},
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    executor.processLlmRequest(llmRequest);

    expect(llmRequest.config?.tools).toEqual([{codeExecution: {}}]);
  });

  it('processLlmRequest should preserve existing tools when appending codeExecution', () => {
    const existingTool = {
      functionDeclarations: [
        {name: 'lookup_order', description: 'Looks up an order by ID.'},
      ],
    };
    const llmRequest: LlmRequest = {
      model: 'gemini-2.5-flash',
      config: {tools: [existingTool]},
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    executor.processLlmRequest(llmRequest);

    expect(llmRequest.config?.tools).toEqual([
      existingTool,
      {codeExecution: {}},
    ]);
  });
});
