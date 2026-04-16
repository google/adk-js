/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event} from '@google/adk';
import {
  BaseAgent,
  BasePlugin,
  Gemini,
  InMemoryRunner,
  isLlmAgent,
} from '@google/adk';
import type {Candidate, UsageMetadata} from '@google/genai';
import {
  createUserContent,
  GenerateContentResponse,
  GoogleGenAI,
} from '@google/genai';
import {ChildProcessWithoutNullStreams} from 'node:child_process';
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
  agent: BaseAgent;
  turns: TestCaseTurn[];
  modelResponses?: RawGenerateContentResponse[];
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
  private readonly responses: GenerateContentResponse[];

  constructor(responses: GenerateContentResponse[]) {
    this.responses = responses;
  }

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
  agent: BaseAgent,
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

const IGNORE_FIELDS = [
  'id',
  'invocationId',
  'timestamp',
  'customMetadata.a2a:response.taskId',
  'customMetadata.a2a:response.contextId',
  'customMetadata.a2a:response.artifact.artifactId',
  'customMetadata.a2a:response.metadata.adk_invocation_id',
  'customMetadata.a2a:response.metadata.adk_session_id',
  'customMetadata.a2a:response.metadata.adk_user_id',
];

/**
 * Deletes fields from an object based on dot-separated paths.
 * @param obj The object to modify.
 * @param paths The paths of the fields to delete (e.g., 'a.b.c').
 */
export function deleteFields(obj: Record<string, unknown>, paths: string[]) {
  if (!obj || typeof obj !== 'object') return;

  for (const path of paths) {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current || typeof current !== 'object') {
        break;
      }
      current = current[parts[i]] as Record<string, unknown>;
    }
    const lastPart = parts[parts.length - 1];
    if (current && typeof current === 'object' && lastPart in current) {
      delete current[lastPart];
    }
  }
}

/**
 * Recursively normalizes CRLF (\r\n) to LF (\n) in all string properties of an object.
 */
export function normalizeLineEndings(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\r\n/g, '\n');
  }
  if (Array.isArray(obj)) {
    return obj.map(normalizeLineEndings);
  }
  if (obj !== null && typeof obj === 'object') {
    const normalizedObj: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      normalizedObj[key] = normalizeLineEndings(value);
    }
    return normalizedObj;
  }
  return obj;
}

/**
 * Runs the given test case.
 * @param testCase The test case to run.
 */
export async function runTestCase(testCase: TestCase) {
  if (isLlmAgent(testCase.agent)) {
    testCase.agent.model = new GeminiWithMockResponses(
      testCase.modelResponses ?? [],
    );
  }
  const runner = await createRunner(testCase.agent);

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
      deleteFields(
        expectedEvent as unknown as Record<string, unknown>,
        IGNORE_FIELDS,
      );

      const normalizedActual = normalizeLineEndings(event);
      const normalizedExpected = normalizeLineEndings(expectedEvent);

      expect(normalizedActual).toMatchObject(
        normalizedExpected as Record<string, unknown>,
      );

      eventIndex++;
    }
  }
}

/**
 * Base class for test servers.
 */
export abstract class BaseTestServer {
  host: string;
  port: number;
  url: string;
  protected serverProcess?: ChildProcessWithoutNullStreams;

  constructor(host: string, port?: number) {
    this.host = host;
    this.port = port || BaseTestServer.getRandomPort();
    this.url = `http://${this.host}:${this.port}`;
  }

  static getRandomPort(): number {
    return 40000 + Math.floor(Math.random() * 10000);
  }

  protected async startProcess({
    spawnProcess,
    startMessage,
    successLogMessage,
    serverName,
    timeoutMs,
  }: {
    spawnProcess: () => ChildProcessWithoutNullStreams;
    startMessage: string;
    successLogMessage: string;
    serverName: string;
    timeoutMs: number;
  }): Promise<void> {
    this.serverProcess = spawnProcess();

    await new Promise<void>((resolve, reject) => {
      let started = false;
      this.serverProcess!.stdout.on('data', (data) => {
        const message = data.toString();
        if (message.includes(startMessage)) {
          started = true;
          console.log(successLogMessage);
          resolve();
        }
      });

      this.serverProcess!.stderr.on('data', (data) => {
        console.error(`${serverName} Stderr: ${data.toString()}`);
      });

      this.serverProcess!.on('error', (error) => {
        console.error(`${serverName} Error: ${error.message}`);

        reject(
          new Error(
            `Failed to start ${serverName.toLowerCase()}: ${error.message}`,
          ),
        );
      });

      this.serverProcess!.on('exit', (code) => {
        console.error(`${serverName} exited with code ${code}`);

        if (!started) {
          reject(
            new Error(`${serverName} exited prematurely with code ${code}`),
          );
        }
      });

      setTimeout(() => {
        if (!started) {
          reject(
            new Error(
              `Timeout waiting for ${serverName.toLowerCase()} to start.`,
            ),
          );
        }
      }, timeoutMs);
    });
  }

  async stop(): Promise<void> {
    if (this.serverProcess) {
      this.serverProcess.kill('SIGINT');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
