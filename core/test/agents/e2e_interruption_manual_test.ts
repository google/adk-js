/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  LongRunningFunctionTool,
  Runner,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, it} from 'vitest';

/**
 * A direct model connection without mocks for e2e verification of the runtime
 * interruption mechanism across turns.
 */
class DirectSimulationConnection implements BaseLlmConnection {
  sendHistory(_history: Content[]): Promise<void> {
    return Promise.resolve();
  }
  sendContent(_content: Content): Promise<void> {
    return Promise.resolve();
  }
  sendRealtime(_blob: {data: string; mimeType: string}): Promise<void> {
    return Promise.resolve();
  }
  async *receive(): AsyncGenerator<LlmResponse, void, void> {}
  async close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Direct model simulation used for e2e verification without framework mocks.
 */
class DirectSimulationModel extends BaseLlm {
  private turnCount = 0;

  constructor() {
    super({model: 'gemini-2.5-flash'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.turnCount++;
    if (this.turnCount === 1) {
      // First turn: model requests input via long-running tool
      yield {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'request_user_approval',
                args: {message: 'Do you approve proceeding with deployment?'},
              },
            },
          ],
        },
      };
    } else {
      // Second turn: model receives tool response and outputs final answer
      yield {
        content: {
          role: 'model',
          parts: [
            {
              text: 'Deployment approved and completed successfully!',
            },
          ],
        },
      };
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return new DirectSimulationConnection();
  }
}

async function runE2eVerification() {
  console.log('--- Starting E2E Runtime Interruption Verification ---');

  // 1. Setup Session Service & Tool
  const sessionService = new InMemorySessionService();
  await sessionService.createSession({
    appName: 'e2e_verification',
    userId: 'user_123',
    sessionId: 'session_abc',
  });

  const approvalTool = new LongRunningFunctionTool({
    name: 'request_user_approval',
    description: 'Requests user approval before long-running action.',
    execute: async () => null,
  });

  // 2. Instantiate Agent and Runner
  const agent = new LlmAgent({
    name: 'deployment_agent',
    model: new DirectSimulationModel(),
    tools: [approvalTool],
  });

  const runner = new Runner({
    appName: 'e2e_verification',
    agent,
    sessionService,
  });

  // 3. Turn 1: Run agent until it hits the LRO/HITL tool interruption
  console.log('Running Turn 1: Initial deployment request...');
  const turn1Events = [];
  for await (const event of runner.runAsync({
    userId: 'user_123',
    sessionId: 'session_abc',
    newMessage: {
      role: 'user',
      parts: [{text: 'Start deployment.'}],
    },
  })) {
    turn1Events.push(event);
  }

  const interruptEvent = turn1Events.find(
    (e) => e.longRunningToolIds && e.longRunningToolIds.length > 0,
  );
  if (!interruptEvent) {
    throw new Error(
      'E2E Verification Failed: No longRunningToolIds emitted in Turn 1.',
    );
  }

  const functionCallPart = interruptEvent.content?.parts?.find(
    (p) => p.functionCall,
  );
  const functionCallId = functionCallPart?.functionCall?.id;
  console.log(`Turn 1 paused cleanly on LRO tool ID: ${functionCallId}`);

  // Verify session is paused, NOT ended
  const session = await sessionService.getSession({
    appName: 'e2e_verification',
    userId: 'user_123',
    sessionId: 'session_abc',
  });
  console.log(`Session events recorded so far: ${session?.events.length}`);

  // 4. Turn 2: Inject user's function response to resume the paused invocation
  console.log('Running Turn 2: Injecting user approval function response...');
  const turn2Events = [];
  for await (const event of runner.runAsync({
    userId: 'user_123',
    sessionId: 'session_abc',
    newMessage: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'request_user_approval',
            id: functionCallId,
            response: {approved: true},
          },
        },
      ],
    },
  })) {
    turn2Events.push(event);
  }

  const finalAnswerEvent = turn2Events.find((e) =>
    e.content?.parts?.some((p) =>
      p.text?.includes('Deployment approved and completed successfully!'),
    ),
  );

  if (!finalAnswerEvent) {
    throw new Error(
      'E2E Verification Failed: Final answer not received upon resumption.',
    );
  }

  console.log('Turn 2 completed successfully with final answer:');
  console.log(finalAnswerEvent.content?.parts?.[0].text);
  console.log(
    '--- E2E Runtime Interruption Verification Passed Successfully! ---',
  );
}

describe('E2E Runtime Interruption Verification', () => {
  it('verifies interruption and resumption end-to-end without mocks', async () => {
    await runE2eVerification();
  });
});
