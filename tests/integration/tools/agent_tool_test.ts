/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  FunctionTool,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

describe('AgentTool', () => {
  it('propagates state changes from sub-agent to parent session', async () => {
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
      // Consume the events.
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

  it('forwards saved artifacts from sub-agent to parent session artifact service without appName or sessionId parameters', async () => {
    const saveArtifactTool = new FunctionTool({
      name: 'saveArtifactTool',
      description: 'Saves text to an artifact.',
      parameters: z.object({
        filename: z.string(),
        text: z.string(),
      }),
      execute: async ({filename, text}, toolContext) => {
        // `FunctionTool` types the tool context as optional, but the runner
        // always supplies it. Narrow explicitly so a missing context fails the
        // test loudly rather than being papered over by a bare `!`.
        expect(
          toolContext,
          'saveArtifactTool did not receive a tool context',
        ).toBeDefined();
        await toolContext!.saveArtifact(filename, {text});
        return `Saved ${filename}`;
      },
    });

    const mockSubAgentResponses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'saveArtifactTool',
                    args: {filename: 'test.txt', text: 'Hello Artifact'},
                    id: 'sub-call-1',
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
              parts: [{text: 'Artifact has been saved.'}],
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
                    args: {request: 'save an artifact'},
                    id: 'parent-call-1',
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
              parts: [{text: 'Sub-agent completed saving.'}],
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
      description: 'subAgent that saves artifacts',
      instruction: 'save an artifact when requested',
      tools: [saveArtifactTool],
    });

    const mainAgentModel = new GeminiWithMockResponses(
      mockParentAgentResponses,
    );
    const mainAgent = new LlmAgent({
      model: mainAgentModel,
      name: 'mainAgent',
      description: 'MainAgent',
      instruction: 'call subagent to save artifact',
      tools: [new AgentTool({agent: subAgent})],
    });

    const sessionService = new InMemorySessionService();
    const memoryService = new InMemoryMemoryService();
    const artifactService = new InMemoryArtifactService();

    await sessionService.createSession({
      appName: 'ADKTest',
      userId: 'TestUser',
      sessionId: '1',
    });

    const runner = new Runner({
      appName: 'ADKTest',
      agent: mainAgent,
      sessionService,
      memoryService,
      artifactService,
    });

    const runOptions = {
      userId: 'TestUser',
      sessionId: '1',
      newMessage: {
        role: 'user',
        parts: [{text: 'Please save an artifact'}],
      },
    };

    for await (const _event of runner.runAsync(runOptions)) {
      // Consume events
    }

    const loadedPart = await artifactService.loadArtifact({
      appName: 'ADKTest',
      userId: 'TestUser',
      sessionId: '1',
      filename: 'test.txt',
    });

    expect(loadedPart).toBeDefined();
    expect(loadedPart!.text).toBe('Hello Artifact');
  });

  // reference: test_update_artifacts
  it('shares artifacts bidirectionally between root agent and tool agent via callbacks', async () => {
    const mockToolAgentResponses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              parts: [{text: 'Tool agent finished'}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    const mockRootAgentResponses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'toolAgent',
                    args: {request: 'run tool agent'},
                    id: 'root-call-1',
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
              parts: [{text: 'All done.'}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    const toolAgent = new LlmAgent({
      name: 'toolAgent',
      model: new GeminiWithMockResponses(mockToolAgentResponses),
      description: 'A tool agent that updates artifacts.',
      beforeAgentCallback: async (ctx) => {
        const artifact1 = await ctx.loadArtifact('artifact_1');
        await ctx.saveArtifact('artifact_2', {
          text: `${artifact1?.text ?? ''} 2`,
        });
        return undefined;
      },
    });

    const rootAgent = new LlmAgent({
      name: 'rootAgent',
      model: new GeminiWithMockResponses(mockRootAgentResponses),
      description: 'Root agent invoking tool agent.',
      tools: [new AgentTool({agent: toolAgent})],
      beforeAgentCallback: async (ctx) => {
        await ctx.saveArtifact('artifact_1', {text: 'test'});
        return undefined;
      },
      afterAgentCallback: async (ctx) => {
        const artifact2 = await ctx.loadArtifact('artifact_2');
        await ctx.saveArtifact('artifact_3', {
          text: `${artifact2?.text ?? ''} 3`,
        });
        return undefined;
      },
    });

    const sessionService = new InMemorySessionService();
    const memoryService = new InMemoryMemoryService();
    const artifactService = new InMemoryArtifactService();

    await sessionService.createSession({
      appName: 'ADKTest',
      userId: 'TestUser',
      sessionId: '1',
    });

    const runner = new Runner({
      appName: 'ADKTest',
      agent: rootAgent,
      sessionService,
      memoryService,
      artifactService,
    });

    for await (const _event of runner.runAsync({
      userId: 'TestUser',
      sessionId: '1',
      newMessage: {
        role: 'user',
        parts: [{text: 'Start'}],
      },
    })) {
      // Consume events
    }

    const part1 = await artifactService.loadArtifact({
      appName: 'ADKTest',
      userId: 'TestUser',
      sessionId: '1',
      filename: 'artifact_1',
    });
    const part2 = await artifactService.loadArtifact({
      appName: 'ADKTest',
      userId: 'TestUser',
      sessionId: '1',
      filename: 'artifact_2',
    });
    const part3 = await artifactService.loadArtifact({
      appName: 'ADKTest',
      userId: 'TestUser',
      sessionId: '1',
      filename: 'artifact_3',
    });

    expect(part1?.text).toBe('test');
    expect(part2?.text).toBe('test 2');
    expect(part3?.text).toBe('test 2 3');
  });
});
