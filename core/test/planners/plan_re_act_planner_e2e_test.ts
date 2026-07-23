/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  createSession,
  Event,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PlanReActPlanner,
  PluginManager,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  FINAL_ANSWER_TAG,
  PLANNING_TAG,
} from '../../src/planners/plan_re_act_planner.js';

/**
 * A local, hermetic LLM that records the request it receives and echoes back a
 * fixed set of response parts. No mocking library is used; this is a real
 * BaseLlm implementation exercised through the full agent pipeline.
 */
class CapturingEchoLlm extends BaseLlm {
  capturedRequest?: LlmRequest;

  constructor(private readonly responseParts: Part[]) {
    super({model: 'echo-model'});
  }

  override async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.capturedRequest = request;
    yield {content: {role: 'model', parts: this.responseParts}};
  }

  override connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('connect is not supported by CapturingEchoLlm');
  }
}

describe('PlanReActPlanner end-to-end through the LlmAgent pipeline', () => {
  it('injects the planning instruction and post-processes the response', async () => {
    const model = new CapturingEchoLlm([
      {text: `${PLANNING_TAG} Look up the answer.`},
      {text: `Reasoning done ${FINAL_ANSWER_TAG} The result is 42.`},
    ]);
    const agent = new LlmAgent({
      name: 'planner_agent',
      model,
      instruction: 'Base instruction',
      planner: new PlanReActPlanner(),
    });

    const invocationContext = new InvocationContext({
      invocationId: 'inv_e2e',
      agent,
      session: createSession({
        id: 'sess_e2e',
        events: [],
        appName: 'test-app',
        userId: 'test-user',
      }),
      userContent: {role: 'user', parts: [{text: 'What is the answer?'}]},
      pluginManager: new PluginManager([]),
    });

    const events: Event[] = [];
    for await (const event of agent.runAsync(invocationContext)) {
      events.push(event);
    }

    // The planning instruction (and the base instruction) reached the model.
    expect(model.capturedRequest?.config?.systemInstruction).toContain(
      PLANNING_TAG,
    );
    expect(model.capturedRequest?.config?.systemInstruction).toContain(
      'Base instruction',
    );

    // The response was post-processed: planning + reasoning parts marked as
    // thoughts, and the final answer split into its own non-thought part.
    const finalEvent = events[events.length - 1];
    const parts = finalEvent.content?.parts ?? [];
    const planningPart = parts.find((p) => p.text?.startsWith(PLANNING_TAG));
    const finalAnswerPart = parts.find((p) => p.text === ' The result is 42.');

    expect(planningPart?.thought).toBe(true);
    expect(finalAnswerPart).toBeDefined();
    expect(finalAnswerPart?.thought).toBeUndefined();
  });
});
