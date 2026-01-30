/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlugin,
  Event,
  Gemini,
  InMemoryRunner,
  isLlmAgent,
  LlmAgent,
  LlmAgentConfig,
} from '@google/adk';
import {
  Candidate,
  createUserContent,
  GenerateContentResponse,
  GoogleGenAI,
  UsageMetadata,
} from '@google/genai';
import {expect} from 'vitest';

/**
 * Represents a raw generate content response.
 */
export interface RawGenerateContentResponse {
  candidates?: Candidate[];
  usageMetadata?: UsageMetadata;
}

/**
 * Represents a turn in a test case.
 */
export interface TestCaseTurn {
  userPrompt: string;
  expectedEvents: Event[];
}

/**
 * Represents a test case for an agent.
 */
export interface TestCase {
  agent: LlmAgent | LlmAgentConfig;
  turns: TestCaseTurn[];
  modelResponses: RawGenerateContentResponse[];
}

function toGenerateContentResponse(
  raw: RawGenerateContentResponse,
): GenerateContentResponse {
  const response = new GenerateContentResponse();
  response.candidates = raw.candidates;
  response.usageMetadata = raw.usageMetadata;

  return response;
}

class MockModels {
  private responseIndex = 0;

  constructor(private readonly responses: GenerateContentResponse[]) {}

  async generateContent(_req: unknown): Promise<GenerateContentResponse> {
    return this.getNextResponse();
  }

  async generateContentStream(
    _req: unknown,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const response = this.getNextResponse();
    // Use an IIFE to create the async generator
    return (async function* () {
      yield response;
    })();
  }

  private getNextResponse(): GenerateContentResponse {
    if (this.responseIndex >= this.responses.length) {
      throw new Error(
        `No more recorded responses available. Requested ${
          this.responseIndex + 1
        }, but only have ${this.responses.length}.`,
      );
    }
    return this.responses[this.responseIndex++];
  }
}

class MockGenAIClient {
  public models: MockModels;
  public vertexai = false;

  constructor(responses: GenerateContentResponse[]) {
    this.models = new MockModels(responses);
  }
}

/**
 * A mock implementation of Gemini that returns predefined responses.
 */
export class GeminiWithMockResponses extends Gemini {
  private readonly _mockClient: MockGenAIClient;

  constructor(responses: RawGenerateContentResponse[]) {
    super({apiKey: 'test-key'});
    this._mockClient = new MockGenAIClient(
      responses.map(toGenerateContentResponse),
    );
  }

  override get apiClient(): GoogleGenAI {
    return this._mockClient as unknown as GoogleGenAI;
  }
}

/**
 * Creates a runner for the given agent.
 * @param agent The agent to create a runner for.
 * @returns A runner for the given agent.
 */
export async function createRunner(
  agent: LlmAgent,
  plugins: BasePlugin[] = [],
) {
  const userId = 'test_user';
  const appName = agent.name;
  const runner = new InMemoryRunner({agent: agent, appName, plugins});
  const session = await runner.sessionService.createSession({
    appName,
    userId,
  });

  return {
    run(prompt: string): AsyncGenerator<Event, void, undefined> {
      return runner.runAsync({
        userId,
        sessionId: session.id,
        newMessage: createUserContent(prompt),
      });
    },
  };
}

const ADK_EVENT_ID_REGEX = /^[a-zA-Z0-9]{8}$/;
const INVOCATION_ID_REGEX =
  /^e-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Runs the given test case.
 * @param testCase The test case to run.
 */
export async function runTestCase(testCase: TestCase) {
  const agent = isLlmAgent(testCase.agent)
    ? testCase.agent
    : new LlmAgent(testCase.agent);
  agent.model = new GeminiWithMockResponses(testCase.modelResponses);
  const runner = await createRunner(agent);

  for (const turn of testCase.turns) {
    let eventIndex = 0;

    for await (const event of runner.run(turn.userPrompt)) {
      expect(eventIndex < turn.expectedEvents.length).toBe(true);

      const expectedEvent = turn.expectedEvents[eventIndex];

      // Validate random fields.
      expect(event.id).toMatch(ADK_EVENT_ID_REGEX);
      expect(event.invocationId).toMatch(INVOCATION_ID_REGEX);
      expect(event.timestamp).toBeGreaterThan(0);

      // Prune random fields from expected event.
      delete (expectedEvent as {id?: string}).id;
      delete (expectedEvent as {invocationId?: string}).invocationId;
      delete (expectedEvent as {timestamp?: number}).timestamp;

      expect(event).toMatchObject(expectedEvent);

      eventIndex++;
    }
  }
}
