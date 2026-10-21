/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  createSession,
  FunctionTool,
  Gemini,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {INSTRUCTIONS_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/instructions_llm_request_processor.js';

const VERTEX_ENV_VAR = 'GOOGLE_GENAI_USE_VERTEXAI';

const OUTPUT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {answer: {type: Type.STRING}},
};

const SET_MODEL_RESPONSE_INSTRUCTION =
  'To output the final result, you must call the "set_model_response" function with the appropriate values. Do not output anything else.';

class MockRootAgent extends BaseAgent {
  constructor(name: string, subAgents: BaseAgent[] = []) {
    super({name, subAgents});
  }

  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

/**
 * A model instance is used rather than a model name so that `canonicalModel`
 * resolves without credentials.
 */
class MockLlm extends BaseLlm {
  async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {}

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('connect is not exercised by these tests');
  }
}

function createMockInvocationContext(agent: BaseAgent): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

describe('InstructionsLlmRequestProcessor', () => {
  it('should append local static instructions for Single LlmAgent', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      instruction: 'Local instruction static',
    });

    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INSTRUCTIONS_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.config?.systemInstruction).toBe(
      'Local instruction static',
    );
  });

  it('should append local static instructions when root agent is NOT an LlmAgent', async () => {
    const llmSubAgent = new LlmAgent({
      name: 'llm_sub_agent',
      model: 'gemini-2.5-flash',
      instruction: 'Local instruction nested',
    });

    new MockRootAgent('root_agent', [llmSubAgent]);
    const invocationContext = createMockInvocationContext(llmSubAgent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INSTRUCTIONS_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.config?.systemInstruction).toBe(
      'Local instruction nested',
    );
  });

  it('should append local dynamic instructions when root agent is NOT an LlmAgent', async () => {
    const dynamicInstruction = (_context: ReadonlyContext) => {
      return 'Dynamic instruction output';
    };

    const llmSubAgent = new LlmAgent({
      name: 'llm_sub_agent_dynamic',
      model: 'gemini-2.5-flash',
      instruction: dynamicInstruction,
    });
    new MockRootAgent('root_agent', [llmSubAgent]);

    const invocationContext = createMockInvocationContext(llmSubAgent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INSTRUCTIONS_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.config?.systemInstruction).toBe(
      'Dynamic instruction output',
    );
  });

  it('should append both global and local instructions when root agent IS an LlmAgent', async () => {
    const llmSubAgent = new LlmAgent({
      name: 'llm_sub_agent',
      model: 'gemini-2.5-flash',
      instruction: 'Local instruction',
    });
    new LlmAgent({
      name: 'root_llm_agent',
      model: 'gemini-2.5-flash',
      globalInstruction: 'Global instruction',
      subAgents: [llmSubAgent],
    });

    const invocationContext = createMockInvocationContext(llmSubAgent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of INSTRUCTIONS_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.config?.systemInstruction).toContain(
      'Global instruction',
    );
    expect(llmRequest.config?.systemInstruction).toContain('Local instruction');
    expect(llmRequest.config?.systemInstruction).toBe(
      'Global instruction\n\nLocal instruction',
    );
  });

  describe('set_model_response instruction', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function runWithOutputSchema(options: {
      model: string | BaseLlm;
      withTools: boolean;
    }): Promise<LlmRequest> {
      const agent = new LlmAgent({
        name: 'test_agent',
        model:
          typeof options.model === 'string'
            ? new MockLlm({model: options.model})
            : options.model,
        instruction: 'Base instruction',
        outputSchema: OUTPUT_SCHEMA,
        tools: options.withTools
          ? [
              new FunctionTool({
                name: 'some_tool',
                description: 'A test tool',
                execute: () => 'result',
              }),
            ]
          : [],
      });

      const llmRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      };

      for await (const _ of INSTRUCTIONS_LLM_REQUEST_PROCESSOR.runAsync(
        createMockInvocationContext(agent),
        llmRequest,
      )) {
        // intentionally empty
      }

      return llmRequest;
    }

    it('should append set_model_response instruction when outputSchema and tools are present', async () => {
      vi.stubEnv(VERTEX_ENV_VAR, undefined);

      const llmRequest = await runWithOutputSchema({
        model: 'gemini-2.5-flash',
        withTools: true,
      });

      expect(llmRequest.config?.systemInstruction).toContain(
        SET_MODEL_RESPONSE_INSTRUCTION,
      );
    });

    it('should not append set_model_response instruction on Vertex AI with a Gemini 2.0+ model', async () => {
      vi.stubEnv(VERTEX_ENV_VAR, 'true');

      const llmRequest = await runWithOutputSchema({
        model: 'gemini-2.5-flash',
        withTools: true,
      });

      expect(llmRequest.config?.systemInstruction).not.toContain(
        'set_model_response',
      );
      expect(llmRequest.config?.systemInstruction).toContain(
        'Base instruction',
      );
    });

    it('should not append set_model_response instruction for a Gemini({ vertexai: true }) 2.0+ instance when env var is unset', async () => {
      vi.stubEnv(VERTEX_ENV_VAR, undefined);

      const llmRequest = await runWithOutputSchema({
        model: new Gemini({
          model: 'gemini-2.5-flash',
          vertexai: true,
          project: 'test-project',
          location: 'us-central1',
        }),
        withTools: true,
      });

      expect(llmRequest.config?.systemInstruction).not.toContain(
        'set_model_response',
      );
      expect(llmRequest.config?.systemInstruction).toContain(
        'Base instruction',
      );
    });

    it('should append set_model_response instruction for a Gemini({ vertexai: false }) instance even when env var is true', async () => {
      vi.stubEnv(VERTEX_ENV_VAR, 'true');

      const llmRequest = await runWithOutputSchema({
        model: new Gemini({
          model: 'gemini-2.5-flash',
          vertexai: false,
          apiKey: 'test-key',
        }),
        withTools: true,
      });

      expect(llmRequest.config?.systemInstruction).toContain(
        SET_MODEL_RESPONSE_INSTRUCTION,
      );
    });

    it('should append set_model_response instruction on Vertex AI with a pre-2.0 model', async () => {
      vi.stubEnv(VERTEX_ENV_VAR, 'true');

      const llmRequest = await runWithOutputSchema({
        model: 'gemini-1.5-pro',
        withTools: true,
      });

      expect(llmRequest.config?.systemInstruction).toContain(
        SET_MODEL_RESPONSE_INSTRUCTION,
      );
    });

    it('should not append set_model_response instruction when there are no tools', async () => {
      vi.stubEnv(VERTEX_ENV_VAR, 'true');

      const llmRequest = await runWithOutputSchema({
        model: 'gemini-2.5-flash',
        withTools: false,
      });

      expect(llmRequest.config?.systemInstruction).not.toContain(
        'set_model_response',
      );
    });
  });

  describe('state injection and instruction providers', () => {
    function createContextWithState(
      agent: BaseAgent,
      state: Record<string, unknown>,
    ): InvocationContext {
      return new InvocationContext({
        invocationId: 'test_id',
        agent,
        session: createSession({
          id: 'test_id',
          events: [],
          appName: 'test_app',
          userId: 'test_user',
          state,
        }),
        pluginManager: new PluginManager([]),
      });
    }

    it('test_build_system_instruction', async () => {
      const request: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        config: {systemInstruction: ''},
        toolsDict: {},
        liveConnectConfig: {},
      };
      const agent = new LlmAgent({
        model: 'gemini-2.5-flash',
        name: 'agent',
        instruction:
          'Use the echo_info tool to echo { customerId }, ' +
          '{{customer_int  }, {  non-identifier-float}}, ' +
          "{'key1': 'value1'} and {{'key2': 'value2'}}.",
      });
      const invocationContext = createContextWithState(agent, {
        customerId: '1234567890',
        customer_int: 30,
      });

      for await (const _ of INSTRUCTIONS_LLM_REQUEST_PROCESSOR.runAsync(
        invocationContext,
        request,
      )) {
        // intentionally empty
      }

      expect(request.config?.systemInstruction).toBe(
        'Use the echo_info tool to echo 1234567890, 30, ' +
          "{  non-identifier-float}}, {'key1': 'value1'} and {{'key2': 'value2'}}.",
      );
    });

    it('test_function_system_instruction', async () => {
      const buildFunctionInstruction = (readonlyContext: ReadonlyContext) =>
        'This is the function agent instruction for invocation:' +
        ' provider template intact { customerId }' +
        ' provider template intact { customer_int }' +
        ` ${readonlyContext.invocationId}.`;

      const request: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        config: {systemInstruction: ''},
        toolsDict: {},
        liveConnectConfig: {},
      };
      const agent = new LlmAgent({
        model: 'gemini-2.5-flash',
        name: 'agent',
        instruction: buildFunctionInstruction,
      });
      const invocationContext = createContextWithState(agent, {
        customerId: '1234567890',
        customer_int: 30,
      });

      for await (const _ of INSTRUCTIONS_LLM_REQUEST_PROCESSOR.runAsync(
        invocationContext,
        request,
      )) {
        // intentionally empty
      }

      expect(request.config?.systemInstruction).toBe(
        'This is the function agent instruction for invocation:' +
          ' provider template intact { customerId }' +
          ' provider template intact { customer_int }' +
          ' test_id.',
      );
    });

    it('test_async_function_system_instruction', async () => {
      const buildFunctionInstruction = async (
        readonlyContext: ReadonlyContext,
      ) =>
        'This is the function agent instruction for invocation:' +
        ' provider template intact { customerId }' +
        ' provider template intact { customer_int }' +
        ` ${readonlyContext.invocationId}.`;

      const request: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        config: {systemInstruction: ''},
        toolsDict: {},
        liveConnectConfig: {},
      };
      const agent = new LlmAgent({
        model: 'gemini-2.5-flash',
        name: 'agent',
        instruction: buildFunctionInstruction,
      });
      const invocationContext = createContextWithState(agent, {
        customerId: '1234567890',
        customer_int: 30,
      });

      for await (const _ of INSTRUCTIONS_LLM_REQUEST_PROCESSOR.runAsync(
        invocationContext,
        request,
      )) {
        // intentionally empty
      }

      expect(request.config?.systemInstruction).toBe(
        'This is the function agent instruction for invocation:' +
          ' provider template intact { customerId }' +
          ' provider template intact { customer_int }' +
          ' test_id.',
      );
    });

    it('test_global_system_instruction', async () => {
      const subAgent = new LlmAgent({
        model: 'gemini-2.5-flash',
        name: 'sub_agent',
        instruction: 'This is the sub agent instruction.',
      });
      new LlmAgent({
        model: 'gemini-2.5-flash',
        name: 'root_agent',
        globalInstruction: 'This is the global instruction.',
        subAgents: [subAgent],
      });
      const request: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        config: {systemInstruction: ''},
        toolsDict: {},
        liveConnectConfig: {},
      };
      const invocationContext = createContextWithState(subAgent, {
        customerId: '1234567890',
        customer_int: 30,
      });

      for await (const _ of INSTRUCTIONS_LLM_REQUEST_PROCESSOR.runAsync(
        invocationContext,
        request,
      )) {
        // intentionally empty
      }

      expect(request.config?.systemInstruction).toBe(
        'This is the global instruction.\n\nThis is the sub agent instruction.',
      );
    });

    it('test_function_global_system_instruction', async () => {
      const subAgentSi = (_readonlyContext: ReadonlyContext) =>
        'This is the sub agent instruction.';
      const rootAgentGi = (_readonlyContext: ReadonlyContext) =>
        'This is the global instruction.';

      const subAgent = new LlmAgent({
        model: 'gemini-2.5-flash',
        name: 'sub_agent',
        instruction: subAgentSi,
      });
      new LlmAgent({
        model: 'gemini-2.5-flash',
        name: 'root_agent',
        globalInstruction: rootAgentGi,
        subAgents: [subAgent],
      });
      const request: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        config: {systemInstruction: ''},
        toolsDict: {},
        liveConnectConfig: {},
      };
      const invocationContext = createContextWithState(subAgent, {
        customerId: '1234567890',
        customer_int: 30,
      });

      for await (const _ of INSTRUCTIONS_LLM_REQUEST_PROCESSOR.runAsync(
        invocationContext,
        request,
      )) {
        // intentionally empty
      }

      expect(request.config?.systemInstruction).toBe(
        'This is the global instruction.\n\nThis is the sub agent instruction.',
      );
    });

    it('test_async_function_global_system_instruction', async () => {
      const subAgentSi = async (_readonlyContext: ReadonlyContext) =>
        'This is the sub agent instruction.';
      const rootAgentGi = async (_readonlyContext: ReadonlyContext) =>
        'This is the global instruction.';

      const subAgent = new LlmAgent({
        model: 'gemini-2.5-flash',
        name: 'sub_agent',
        instruction: subAgentSi,
      });
      new LlmAgent({
        model: 'gemini-2.5-flash',
        name: 'root_agent',
        globalInstruction: rootAgentGi,
        subAgents: [subAgent],
      });
      const request: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        config: {systemInstruction: ''},
        toolsDict: {},
        liveConnectConfig: {},
      };
      const invocationContext = createContextWithState(subAgent, {
        customerId: '1234567890',
        customer_int: 30,
      });

      for await (const _ of INSTRUCTIONS_LLM_REQUEST_PROCESSOR.runAsync(
        invocationContext,
        request,
      )) {
        // intentionally empty
      }

      expect(request.config?.systemInstruction).toBe(
        'This is the global instruction.\n\nThis is the sub agent instruction.',
      );
    });

    it('does not inject session state into sync or async globalInstruction providers', async () => {
      const subAgent = new LlmAgent({
        model: 'gemini-2.5-flash',
        name: 'sub_agent',
        instruction: 'Local { customerId }',
      });
      new LlmAgent({
        model: 'gemini-2.5-flash',
        name: 'root_agent',
        globalInstruction: async (readonlyContext: ReadonlyContext) =>
          `Global template intact { customerId } ${readonlyContext.invocationId}`,
        subAgents: [subAgent],
      });
      const request: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        config: {systemInstruction: ''},
        toolsDict: {},
        liveConnectConfig: {},
      };
      const invocationContext = createContextWithState(subAgent, {
        customerId: '1234567890',
      });

      for await (const _ of INSTRUCTIONS_LLM_REQUEST_PROCESSOR.runAsync(
        invocationContext,
        request,
      )) {
        // intentionally empty
      }

      expect(request.config?.systemInstruction).toBe(
        'Global template intact { customerId } test_id\n\nLocal 1234567890',
      );
    });

    it('test_build_system_instruction_with_namespace', async () => {
      const request: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        config: {systemInstruction: ''},
        toolsDict: {},
        liveConnectConfig: {},
      };
      const agent = new LlmAgent({
        model: 'gemini-2.5-flash',
        name: 'agent',
        instruction:
          'Use the echo_info tool to echo { customerId }, {app:key}, {user:key}, {a:key}.',
      });
      const invocationContext = createContextWithState(agent, {
        customerId: '1234567890',
        'app:key': 'app_value',
        'user:key': 'user_value',
      });

      for await (const _ of INSTRUCTIONS_LLM_REQUEST_PROCESSOR.runAsync(
        invocationContext,
        request,
      )) {
        // intentionally empty
      }

      expect(request.config?.systemInstruction).toBe(
        'Use the echo_info tool to echo 1234567890, app_value, user_value, {a:key}.',
      );
    });
  });
});
