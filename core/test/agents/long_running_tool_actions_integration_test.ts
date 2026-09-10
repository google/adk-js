/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  BaseLlm,
  BaseLlmConnection,
  Event,
  getFunctionCalls,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  LongRunningFunctionTool,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const AUTH_CONFIG: AuthConfig = {
  authScheme: {type: 'apiKey', name: 'X-API-Key', in: 'header'},
  credentialKey: 'job-api-key',
};

/** A model that always asks for the `startJob` tool. */
class StartJobLlm extends BaseLlm {
  constructor() {
    super({model: 'start-job-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield {
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'startJob', args: {}, id: 'call_1'}}],
      },
    };
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

async function runAgentWithTool(tool: LongRunningFunctionTool<undefined>) {
  const runner = new InMemoryRunner({
    agent: new LlmAgent({
      name: 'job_agent',
      model: new StartJobLlm(),
      tools: [tool],
    }),
    appName: 'test_app',
  });
  const session = await runner.sessionService.createSession({
    appName: 'test_app',
    userId: 'user_1',
  });

  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'user_1',
    sessionId: session.id,
    newMessage: {parts: [{text: 'start the job'}]},
  })) {
    events.push(event);
  }

  return {events, runner, sessionId: session.id};
}

describe('long running tool actions integration', () => {
  it('persists the state delta of a long running tool that returns nothing', async () => {
    const startJob = new LongRunningFunctionTool({
      name: 'startJob',
      description: 'starts a background job',
      execute: async (_args, toolContext) => {
        toolContext!.state.set('pendingJob', 'job-123');
        return undefined;
      },
    });

    const {events, runner, sessionId} = await runAgentWithTool(startJob);

    const session = await runner.sessionService.getSession({
      appName: 'test_app',
      userId: 'user_1',
      sessionId,
    });
    expect(session!.state['pendingJob']).toBe('job-123');

    const actionsEvent = events[events.length - 1];
    expect(actionsEvent.content).toBeUndefined();
    expect(actionsEvent.actions.stateDelta).toEqual({pendingJob: 'job-123'});
  });

  it('surfaces the credential request of a long running tool that returns nothing', async () => {
    const startJob = new LongRunningFunctionTool({
      name: 'startJob',
      description: 'starts a background job',
      execute: async (_args, toolContext) => {
        toolContext!.requestCredential(AUTH_CONFIG);
        return undefined;
      },
    });

    const {events} = await runAgentWithTool(startJob);

    const authCalls = events.flatMap((event) =>
      getFunctionCalls(event).filter(
        (call) => call.name === 'adk_request_credential',
      ),
    );
    expect(authCalls.length).toBe(1);
    expect(authCalls[0].args!['function_call_id']).toBe('call_1');
  });
});
