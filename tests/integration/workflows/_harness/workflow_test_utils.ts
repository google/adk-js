/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event,
  InMemoryRunner,
  LlmAgent,
  LlmAgentConfig,
  Workflow,
} from '@google/adk';
import {Content, FinishReason} from '@google/genai';
import {
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../../test_case_utils.js';

/**
 * Builds a raw generate-content response that returns plain model text.
 */
export function textResponse(text: string): RawGenerateContentResponse {
  return {
    candidates: [
      {
        content: {role: 'model', parts: [{text}]},
        finishReason: FinishReason.STOP,
      },
    ],
  };
}

/**
 * Builds a raw generate-content response that returns a single function call.
 */
export function functionCallResponse(
  name: string,
  args: Record<string, unknown>,
  id?: string,
): RawGenerateContentResponse {
  return {
    candidates: [
      {
        content: {role: 'model', parts: [{functionCall: {name, args, id}}]},
        finishReason: FinishReason.STOP,
      },
    ],
  };
}

/**
 * Constructs an {@link LlmAgent} whose model returns the given canned responses
 * (loaded from a JSON fixture), so workflow integration tests are deterministic
 * without a live model.
 */
export function mockLlmAgent(
  config: Omit<LlmAgentConfig, 'model'>,
  responses: RawGenerateContentResponse[],
): LlmAgent {
  return new LlmAgent({
    ...config,
    model: new GeminiWithMockResponses(responses),
  });
}

/**
 * Creates a runner for a {@link Workflow}, driven as the root node, bound to a
 * single session so successive `run(...)` calls are additional turns (needed
 * for HITL resume). Accepts a text prompt or a full `Content` (e.g. a
 * function-response resume message).
 */
export async function createWorkflowRunner(
  workflow: Workflow,
): Promise<{run: (message: string | Content) => AsyncGenerator<Event>}> {
  const agent = workflow;
  const runner = new InMemoryRunner({agent, appName: agent.name});
  const session = await runner.sessionService.createSession({
    appName: agent.name,
    userId: 'u1',
  });
  return {
    run(message: string | Content): AsyncGenerator<Event> {
      const newMessage: Content =
        typeof message === 'string'
          ? {role: 'user', parts: [{text: message}]}
          : message;
      return runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage,
      });
    },
  };
}

/** Drains an event generator into an array. */
export async function collect(gen: AsyncGenerator<Event>): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

/** Runs a workflow for a single prompt and returns the emitted events. */
export async function runWorkflowOnce(
  workflow: Workflow,
  prompt: string,
): Promise<Event[]> {
  const {run} = await createWorkflowRunner(workflow);
  return collect(run(prompt));
}

/** Returns the last non-undefined `output` across a list of events. */
export function finalOutput(events: Event[]): unknown {
  let output: unknown;
  for (const event of events) {
    if (event.output !== undefined) {
      output = event.output;
    }
  }
  return output;
}
