/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai';
import {Sessions} from '@google-cloud/vertexai/build/src/genai/sessions.js';
import {
  AgentTool,
  LlmAgent,
  Runner,
  VertexAiMemoryBankService,
  VertexAiSessionService,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

const TEST_PROJECT_ID = 'test-project';
const TEST_LOCATION = 'us-west1';
// VertexAiSessionService.getReasoningEngineId requires a digits-only engine id.
const TEST_AGENT_ENGINE_ID = '123456789';
const TEST_APP_NAME = `projects/${TEST_PROJECT_ID}/locations/${TEST_LOCATION}/reasoningEngines/${TEST_AGENT_ENGINE_ID}`;

describe('AgentTool (Vertex AI)', () => {
  it('propagates state changes from sub-agent to parent session (VertexAI)', async () => {
    const mockSubAgentResponses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              parts: [{text: 'Today is Tuesday'}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    const mockParentAgentResponses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'subAgent',
                    args: {request: 'what day is today'},
                    id: 'adk-mock-call-1',
                  },
                },
              ],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [{text: 'The subAgent says it is Tuesday.'}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    const subAgentModel = new GeminiWithMockResponses(mockSubAgentResponses);
    const subAgent = new LlmAgent({
      model: subAgentModel,
      name: 'subAgent',
      description: 'subAgent',
      instruction: 'answer what day is today',
      outputKey: 'subAgentOutput',
    });

    const mainAgentModel = new GeminiWithMockResponses(
      mockParentAgentResponses,
    );
    const mainAgent = new LlmAgent({
      model: mainAgentModel,
      name: 'mainAgent',
      description: 'MainAgent',
      instruction: 'testing you must use subAgent to answer',
      tools: [new AgentTool({agent: subAgent})],
    });

    const sessionStateStore: Record<string, Record<string, unknown>> = {};
    const eventsStore: unknown[] = [];

    const mockClient = {
      createInternal: async (req: {
        config?: {sessionState?: Record<string, unknown>};
      }) => {
        const id = 'mock-session-id';
        sessionStateStore[id] = req.config?.sessionState || {};
        return {
          name: 'operations/mock-operation',
        };
      },
      getSessionOperationInternal: async (_req: unknown) => {
        const id = 'mock-session-id';
        return {
          done: true,
          response: {
            name: `${TEST_APP_NAME}/sessions/${id}`,
            sessionState: sessionStateStore[id],
            updateTime: new Date().toISOString(),
          },
        };
      },
      get: async (req: {name: string}) => {
        const id = req.name.split('/').pop() ?? '';
        return {
          userId: 'TestUser',
          sessionState: {
            ...sessionStateStore[id],
            subAgentOutput: 'Today is Tuesday',
          },
          updateTime: new Date().toISOString(),
        };
      },
      events: {
        append: async (req: {
          name: string;
          config?: {actions?: {stateDelta?: Record<string, unknown>}};
        }) => {
          const id = req.name.split('/').pop() ?? '';
          eventsStore.push(req);
          if (req.config?.actions?.stateDelta) {
            sessionStateStore[id] = {
              ...sessionStateStore[id],
              ...req.config.actions.stateDelta,
            };
          }
          return {};
        },
        listInternal: async (_req: unknown) => {
          return {
            sessionEvents: eventsStore,
          };
        },
      },
      agentEnginesInternal: {
        memories: {
          createInternal: vi.fn().mockResolvedValue({done: true}),
          generateInternal: vi.fn().mockResolvedValue({done: true}),
          retrieveInternal: vi.fn().mockResolvedValue({retrievedMemories: []}),
        },
      },
    };

    const sessionService = new VertexAiSessionService({
      projectId: TEST_PROJECT_ID,
      location: TEST_LOCATION,
      sessions: mockClient as unknown as Sessions,
    });
    const memoryService = new VertexAiMemoryBankService({
      agentEngineId: TEST_AGENT_ENGINE_ID,
      client: mockClient as unknown as Client,
    });

    const createdSession = await sessionService.createSession({
      appName: TEST_APP_NAME,
      userId: 'TestUser',
      state: {initialStateKey: 'contexto inicial'},
    });

    const runner = new Runner({
      appName: TEST_APP_NAME,
      agent: mainAgent,
      sessionService,
      memoryService,
    });

    const runOptions = {
      userId: 'TestUser',
      sessionId: createdSession.id,
      newMessage: {
        role: 'user',
        parts: [{text: 'What day is today?'}],
      },
    };

    for await (const _event of runner.runAsync(runOptions)) {
      // Consume events
    }

    const session = await sessionService.getSession({
      appName: TEST_APP_NAME,
      userId: 'TestUser',
      sessionId: createdSession.id,
    });

    expect(session).toBeDefined();
    expect(session!.state['initialStateKey']).toBe('contexto inicial');
    expect(session!.state['subAgentOutput']).toBe('Today is Tuesday');
  });
});
