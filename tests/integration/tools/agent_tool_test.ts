/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  InMemoryMemoryService,
  InMemorySessionService,
  LlmAgent,
  Runner,
  VertexAiSessionService,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

describe('AgentTool', () => {
  it('propagates state changes from sub-agent to parent session (InMemory)', async () => {
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

    const sessionService = new InMemorySessionService();
    const memoryService = new InMemoryMemoryService();

    await sessionService.createSession({
      appName: 'ADKTest',
      userId: 'TestUser',
      sessionId: '1',
      state: {initialStateKey: 'contexto inicial'},
    });

    const runner = new Runner({
      appName: 'ADKTest',
      agent: mainAgent,
      sessionService,
      memoryService,
    });

    const runOptions = {
      userId: 'TestUser',
      sessionId: '1',
      newMessage: {
        role: 'user',
        parts: [{text: 'What day is today?'}],
      },
    };

    for await (const _event of runner.runAsync(runOptions)) {
    }

    const session = await sessionService.getSession({
      appName: 'ADKTest',
      userId: 'TestUser',
      sessionId: '1',
    });

    expect(session).toBeDefined();
    expect(session!.state['initialStateKey']).toBe('contexto inicial');
    expect(session!.state['subAgentOutput']).toBe('Today is Tuesday');
  });

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

    const sessionStateStore: Record<string, any> = {};
    const eventsStore: any[] = [];

    const mockClient = {
      createInternal: async (req: any) => {
        const id = 'mock-session-id';
        sessionStateStore[id] = req.config?.sessionState || {};
        return {
          name: 'operations/mock-operation',
        };
      },
      getSessionOperationInternal: async (req: any) => {
        const id = 'mock-session-id';
        return {
          done: true,
          response: {
            name: `projects/1055446556895/locations/us-west1/reasoningEngines/9208858483368132608/sessions/${id}`,
            sessionState: sessionStateStore[id],
            updateTime: new Date().toISOString(),
          },
        };
      },
      get: async (req: any) => {
        const id = req.name.split('/').pop();
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
        append: async (req: any) => {
          const id = req.name.split('/').pop();
          eventsStore.push(req);
          if (req.config?.actions?.stateDelta) {
            sessionStateStore[id] = {
              ...sessionStateStore[id],
              ...req.config.actions.stateDelta,
            };
          }
          return {};
        },
        listInternal: async (req: any) => {
          return {
            sessionEvents: eventsStore,
          };
        },
      },
    };

    const sessionService = new VertexAiSessionService({
      projectId: 'amaad-martin-vertex-api',
      location: 'us-west1',
      client: mockClient as any,
    });
    const memoryService = new InMemoryMemoryService();

    const createdSession = await sessionService.createSession({
      appName: 'projects/1055446556895/locations/us-west1/reasoningEngines/9208858483368132608',
      userId: 'TestUser',
      state: {initialStateKey: 'contexto inicial'},
    });

    const runner = new Runner({
      appName: 'projects/1055446556895/locations/us-west1/reasoningEngines/9208858483368132608',
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
    }

    const session = await sessionService.getSession({
      appName: 'projects/1055446556895/locations/us-west1/reasoningEngines/9208858483368132608',
      userId: 'TestUser',
      sessionId: createdSession.id,
    });

    expect(session).toBeDefined();
    expect(session!.state['initialStateKey']).toBe('contexto inicial');
    expect(session!.state['subAgentOutput']).toBe('Today is Tuesday');
  });
});
