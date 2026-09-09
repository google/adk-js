/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTransferLlmRequestProcessor,
  BaseAgent,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const AGENT_TRANSFER_LLM_REQUEST_PROCESSOR =
  new AgentTransferLlmRequestProcessor();

class MockRootAgent extends BaseAgent {
  constructor(
    name: string,
    description: string = '',
    subAgents: BaseAgent[] = [],
  ) {
    super({name, description, subAgents});
  }
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
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

describe('AgentTransferLlmRequestProcessor', () => {
  it('should do nothing if agent is not an LlmAgent', async () => {
    const agent = new MockRootAgent('test_agent');
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    expect(llmRequest.contents).toHaveLength(0);
    expect(llmRequest.toolsDict['transfer_to_agent']).toBeUndefined();
  });

  it('should do nothing if LlmAgent has no transfer targets', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    expect(llmRequest.contents).toHaveLength(0);
  });

  it('should append instructions and register tool when sub-agents exist', async () => {
    const subAgent = new LlmAgent({
      name: 'sub_agent',
      model: 'gemini-2.5-flash',
      description: 'Answers sub questions',
    });
    const agent = new LlmAgent({
      name: 'root_agent',
      model: 'gemini-2.5-flash',
      subAgents: [subAgent],
    });

    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    // Verify instructions appended
    expect(llmRequest.config?.systemInstruction).toContain(
      'You have a list of other agents to transfer to',
    );
    expect(llmRequest.config?.systemInstruction).toContain(
      'Agent name: sub_agent',
    );

    // Verify tool registered
    expect(llmRequest.toolsDict['transfer_to_agent']).toBeDefined();
  });

  it('should respect disallowTransferToParent', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      disallowTransferToParent: true,
    });
    new LlmAgent({
      name: 'parent_agent',
      model: 'gemini-2.5-flash',
      subAgents: [agent],
    });

    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    // Should not include parent agent if disallowTransferToParent is true and no other targets
    expect(llmRequest.contents).toHaveLength(0);
  });

  it('should include parent agent if allowed', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      disallowTransferToParent: false,
    });
    new LlmAgent({
      name: 'parent_agent',
      model: 'gemini-2.5-flash',
      description: 'Parent agent',
      subAgents: [agent],
    });

    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    expect(llmRequest.config?.systemInstruction).toContain(
      'Agent name: parent_agent',
    );
  });

  it('should include peer agents if allowed', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
      disallowTransferToPeers: false,
    });
    const peerAgent = new LlmAgent({
      name: 'peer_agent',
      model: 'gemini-2.5-flash',
      description: 'Peer agent',
    });
    new LlmAgent({
      name: 'parent_agent',
      model: 'gemini-2.5-flash',
      subAgents: [agent, peerAgent],
    });

    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    expect(llmRequest.config?.systemInstruction).toContain(
      'Agent name: peer_agent',
    );
  });

  it('should execute transfer_to_agent tool successfully', async () => {
    const subAgent = new LlmAgent({
      name: 'sub_agent',
      model: 'gemini-2.5-flash',
      description: 'Answers sub questions',
    });
    const agent = new LlmAgent({
      name: 'root_agent',
      model: 'gemini-2.5-flash',
      subAgents: [subAgent],
    });

    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    const tool = llmRequest.toolsDict['transfer_to_agent'];
    expect(tool).toBeDefined();

    const toolContext = new Context({invocationContext});
    const result = await tool.runAsync({
      args: {agent_name: 'sub_agent'},
      toolContext,
    });

    expect(result).toEqual('Transfer queued');
    expect(toolContext.actions.transferToAgent).toEqual('sub_agent');
  });

  it('declares agent_name as an enum of the reachable agents', async () => {
    const agent = new LlmAgent({
      name: 'root_agent',
      model: 'gemini-2.5-flash',
      subAgents: [
        new LlmAgent({name: 'sub_a', model: 'gemini-2.5-flash'}),
        new LlmAgent({name: 'sub_b', model: 'gemini-2.5-flash'}),
      ],
    });

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      createMockInvocationContext(agent),
      llmRequest,
    )) {
      // Do nothing
    }

    const declaration = (
      llmRequest.config?.tools as Array<{
        functionDeclarations?: Array<{
          name?: string;
          parameters?: {properties?: Record<string, {enum?: string[]}>};
        }>;
      }>
    )?.[0];
    const transfer = declaration?.functionDeclarations?.find(
      (d) => d.name === 'transfer_to_agent',
    );

    // `agent_name`, not `agentName`: this is the wire format adk-python uses,
    // and it is what ends up in persisted events.
    expect(transfer?.parameters?.properties?.['agent_name']?.enum).toEqual([
      'sub_a',
      'sub_b',
    ]);
  });

  it('rejects a transfer to an agent that is not reachable', async () => {
    const agent = new LlmAgent({
      name: 'root_agent',
      model: 'gemini-2.5-flash',
      subAgents: [new LlmAgent({name: 'sub_agent', model: 'gemini-2.5-flash'})],
    });

    const invocationContext = createMockInvocationContext(agent);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    for await (const _ of AGENT_TRANSFER_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // Do nothing
    }

    const toolContext = new Context({invocationContext});
    // A hallucinated target must not reach `transferToAgent`. The throw is
    // caught by the function-call runner and handed back to the model as a
    // tool error, so the run continues and the model can pick a real agent.
    await expect(
      llmRequest.toolsDict['transfer_to_agent'].runAsync({
        args: {agent_name: 'no_such_agent'},
        toolContext,
      }),
    ).rejects.toThrow();
    expect(toolContext.actions.transferToAgent).toBeUndefined();
  });
});
