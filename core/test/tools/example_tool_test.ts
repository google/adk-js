/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';

import {
  BaseAgent,
  BaseExampleProvider,
  Context,
  createSession,
  Example,
  ExampleTool,
  InputValidationError,
  InvocationContext,
  LlmRequest,
  PluginManager,
} from '@google/adk';
import {Content} from '@google/genai';

const SIMPLE_EXAMPLE: Example = {
  input: {parts: [{text: 'What is 2+2?'}]},
  output: [{role: 'model', parts: [{text: '4'}]}],
};

const FUNCTION_CALL_EXAMPLE: Example = {
  input: {parts: [{text: 'Search for cats'}]},
  output: [
    {
      role: 'model',
      parts: [{functionCall: {name: 'search', args: {query: 'cats'}}}],
    },
    {role: 'model', parts: [{text: 'Found cats!'}]},
  ],
};

class FixedExampleProvider extends BaseExampleProvider {
  constructor(private readonly examples: Example[]) {
    super();
  }
  override async getExamples(_query: string): Promise<Example[]> {
    return this.examples;
  }
}

/**
 * Builds a `toolContext` stub exposing only the `userContent` used by
 * ExampleTool, cast to `Context` (mirrors `StubToolContext` in
 * `preload_memory_tool_test.ts`).
 */
function makeToolContext(userContent: unknown): Context {
  return {userContent} as unknown as Context;
}

function makeLlmRequest(model?: string): LlmRequest {
  return {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
    config: {},
    model,
  };
}

describe('ExampleTool', () => {
  it('appends few-shot instructions from a static list of examples', async () => {
    const tool = new ExampleTool([SIMPLE_EXAMPLE]);
    const toolContext = makeToolContext({
      role: 'user',
      parts: [{text: 'What is 2+2?'}],
    });
    const llmRequest = makeLlmRequest('gemini-2.0-flash');

    await tool.processLlmRequest({toolContext, llmRequest});

    const instruction = llmRequest.config?.systemInstruction;
    expect(instruction).toBeDefined();
    expect(instruction).toContain('<EXAMPLES>');
    expect(instruction).toContain('What is 2+2?');
    expect(instruction).toContain('4');
  });

  it('appends instructions from a BaseExampleProvider and threads the query', async () => {
    const provider = new FixedExampleProvider([SIMPLE_EXAMPLE]);
    const getExamplesSpy = vi.spyOn(provider, 'getExamples');
    const tool = new ExampleTool(provider);
    const toolContext = makeToolContext({
      role: 'user',
      parts: [{text: 'What is 2+2?'}],
    });
    const llmRequest = makeLlmRequest('gemini-2.0-flash');

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(getExamplesSpy).toHaveBeenCalledWith('What is 2+2?');
    expect(llmRequest.config?.systemInstruction).toContain('What is 2+2?');
  });

  it('forwards llmRequest.model to buildExampleSi (function-call fence style)', async () => {
    const tool = new ExampleTool([FUNCTION_CALL_EXAMPLE]);
    const toolContext = makeToolContext({
      role: 'user',
      parts: [{text: 'Search for cats'}],
    });
    const llmRequest = makeLlmRequest('gemini-1.5-pro');

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.systemInstruction).toContain('```tool_code');
  });

  it('is a no-op when userContent is undefined', async () => {
    const tool = new ExampleTool([SIMPLE_EXAMPLE]);
    const toolContext = makeToolContext(undefined);
    const llmRequest = makeLlmRequest('gemini-2.0-flash');

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('is a no-op when userContent has no parts', async () => {
    const tool = new ExampleTool([SIMPLE_EXAMPLE]);
    const toolContext = makeToolContext({role: 'user', parts: []});
    const llmRequest = makeLlmRequest('gemini-2.0-flash');

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('is a no-op when the first part has no text', async () => {
    const tool = new ExampleTool([SIMPLE_EXAMPLE]);
    const toolContext = makeToolContext({role: 'user', parts: [{}]});
    const llmRequest = makeLlmRequest('gemini-2.0-flash');

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('throws in runAsync because it is not meant to be called by the model', async () => {
    const tool = new ExampleTool([SIMPLE_EXAMPLE]);
    const toolContext = makeToolContext(undefined);

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'ExampleTool should not be called by model',
    );
  });

  it('is importable from @google/adk (public export)', () => {
    expect(new ExampleTool([])).toBeInstanceOf(ExampleTool);
  });
});

/**
 * Presents a deliberately malformed value as the declared constructor
 * parameter type. The constructor guards values that reach the SDK from
 * untyped JavaScript or from a configuration file, which a TypeScript call
 * site cannot express.
 */
function asExamplesArg(value: unknown): Example[] | BaseExampleProvider {
  return value as Example[] | BaseExampleProvider;
}

describe('ExampleTool construction validation', () => {
  it('rejects a list holding a malformed example', () => {
    expect(
      () => new ExampleTool(asExamplesArg([{input: {parts: [{text: 'q'}]}}])),
    ).toThrow(InputValidationError);
  });

  it('rejects a duck-typed provider', () => {
    expect(
      () =>
        new ExampleTool(asExamplesArg({getExamples: () => [SIMPLE_EXAMPLE]})),
    ).toThrow(InputValidationError);
  });

  it('rejects a fully-qualified provider name string', () => {
    expect(() => new ExampleTool(asExamplesArg('my.module.provider'))).toThrow(
      InputValidationError,
    );
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s rather than raising a TypeError later', (_label, value) => {
    expect(() => new ExampleTool(asExamplesArg(value))).toThrow(
      InputValidationError,
    );
  });

  it('keeps the provider reference the caller passed', () => {
    const provider = new FixedExampleProvider([SIMPLE_EXAMPLE]);

    expect(new ExampleTool(provider).examples).toBe(provider);
  });

  it('keeps the array reference the caller passed', () => {
    const examples = [SIMPLE_EXAMPLE];

    expect(new ExampleTool(examples).examples).toBe(examples);
  });
});

/**
 * Builds a real `Context` backed by a real `InvocationContext`/`Session` (no
 * stubs), so the tool is exercised against genuine ADK plumbing exactly as the
 * agent request loop invokes it (llm_agent.ts).
 */
function makeRealContext(userContent?: Content): Context {
  const session = createSession({id: 'test-session', appName: 'test-app'});
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent: {} as BaseAgent,
    session,
    pluginManager: new PluginManager([]),
    userContent,
  });
  return new Context({invocationContext});
}

describe('ExampleTool (end-to-end with real framework objects)', () => {
  it('appends the few-shot block when driven through a real Context', async () => {
    const tool = new ExampleTool([SIMPLE_EXAMPLE]);
    const toolContext = makeRealContext({
      role: 'user',
      parts: [{text: 'What is 2+2?'}],
    });
    const llmRequest = makeLlmRequest('gemini-2.0-flash');

    await tool.processLlmRequest({toolContext, llmRequest});

    const instruction = llmRequest.config?.systemInstruction;
    expect(instruction).toContain('<EXAMPLES>');
    expect(instruction).toContain('What is 2+2?');
    expect(instruction).toContain('4');
  });

  it('is a no-op when the real invocation has no user content', async () => {
    const tool = new ExampleTool([SIMPLE_EXAMPLE]);
    const toolContext = makeRealContext(undefined);
    const llmRequest = makeLlmRequest('gemini-2.0-flash');

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });
});
