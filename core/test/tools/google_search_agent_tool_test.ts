/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  BaseLlm,
  BaseLlmConnection,
  Context,
  createEvent,
  createGoogleSearchAgent,
  createSession,
  GOOGLE_SEARCH,
  GoogleSearchAgentTool,
  GoogleSearchTool,
  InvocationContext,
  isLlmAgent,
  LlmAgent,
  LlmResponse,
  PluginManager,
  Runner,
  State,
} from '@google/adk';
import {GroundingMetadata} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';

vi.mock('../../src/runner/runner.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/runner/runner.js')>();
  return {
    ...actual,
    Runner: vi.fn().mockImplementation((config) => ({
      appName: config?.appName,
      sessionService: config?.sessionService,
      runAsync: vi.fn(),
    })),
  };
});

/** A minimal concrete BaseLlm used to verify model pass-through. */
class FakeLlm extends BaseLlm {
  // eslint-disable-next-line require-yield
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    throw new Error('not implemented');
  }

  connect(): Promise<BaseLlmConnection> {
    throw new Error('not implemented');
  }
}

describe('createGoogleSearchAgent', () => {
  it('returns an LlmAgent named google_search_agent', () => {
    const agent = createGoogleSearchAgent('gemini-2.0-flash');

    expect(isLlmAgent(agent)).toBe(true);
    expect(agent).toBeInstanceOf(LlmAgent);
    expect(agent.name).toBe('google_search_agent');
  });

  it('passes a string model straight through', () => {
    const agent = createGoogleSearchAgent('gemini-2.0-flash');

    expect(agent.model).toBe('gemini-2.0-flash');
  });

  it('passes a BaseLlm instance straight through', () => {
    const llm = new FakeLlm({model: 'gemini-2.0-flash'});
    const agent = createGoogleSearchAgent(llm);

    expect(agent.model).toBe(llm);
  });

  it('uses the exact Python description string', () => {
    const agent = createGoogleSearchAgent('gemini-2.0-flash');

    expect(agent.description).toBe(
      'An agent for performing Google search using the `google_search` tool',
    );
  });

  it('has an instruction guiding the specialized search agent', () => {
    const agent = createGoogleSearchAgent('gemini-2.0-flash');

    expect(agent.instruction).toContain('specialized Google search agent');
    expect(agent.instruction).toContain('google_search');
  });

  it('wires up exactly the google_search built-in tool', () => {
    const agent = createGoogleSearchAgent('gemini-2.0-flash');

    expect(agent.tools).toHaveLength(1);
    expect(agent.tools[0]).toBe(GOOGLE_SEARCH);
    expect(agent.tools[0]).toBeInstanceOf(GoogleSearchTool);
  });
});

describe('GoogleSearchAgentTool', () => {
  it('is an AgentTool whose name mirrors the wrapped agent', () => {
    const agent = createGoogleSearchAgent('gemini-2.0-flash');
    const tool = new GoogleSearchAgentTool(agent);

    expect(tool).toBeInstanceOf(AgentTool);
    expect(tool.name).toBe('google_search_agent');
    expect(tool.name).toBe(agent.name);
  });

  it('propagates the sub-agent grounding metadata to the parent state', async () => {
    const agent = createGoogleSearchAgent('gemini-2.0-flash');
    const tool = new GoogleSearchAgentTool(agent);

    const session = createSession({
      id: 'parent-session',
      appName: 'google_search_agent',
      userId: 'parent-user',
    });

    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent,
      session,
      pluginManager: new PluginManager([]),
    });

    const toolContext = new Context({invocationContext});

    const groundingMetadata: GroundingMetadata = {
      webSearchQueries: ['adk grounding'],
    };

    const mockRunAsync = async function* () {
      yield createEvent({
        author: 'google_search_agent',
        content: {role: 'model', parts: [{text: 'the answer'}]},
        groundingMetadata,
      });
    };

    vi.mocked(Runner).mockImplementation(
      (config) =>
        ({
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync: mockRunAsync,
        }) as unknown as Runner,
    );

    const result = await tool.runAsync({
      args: {request: 'search please'},
      toolContext,
    });

    expect(result).toBe('the answer');
    expect(
      toolContext.state.get(`${State.TEMP_PREFIX}_adk_grounding_metadata`),
    ).toBe(groundingMetadata);
  });
});
