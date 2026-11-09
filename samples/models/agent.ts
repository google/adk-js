/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Models (`BaseLlm`, `LlmRequest`, `LlmResponse`, and `LLMRegistry`)
 * ../../docs/guides/models/index.md
 *
 * A `BaseAgent` that drives a model directly, without `LlmAgent`. For each
 * user message it builds an `LlmRequest`, adds a system instruction with
 * `appendInstructions`, creates the model with `LLMRegistry.newLlm`, and turns
 * each `LlmResponse` into an event with `createEvent`.
 *
 * The default model, `EchoLlm`, answers without a network call. It builds a
 * `GenerateContentResponse` that repeats the last user message, and converts
 * it with `createLlmResponse`, the same way a model backed by a real API does.
 *
 * `EchoLlm` registers the pattern `echo-v1|echo-v2`. The registry matches a
 * pattern against the whole model name, so `echo-v1` and `echo-v2` resolve to
 * `EchoLlm` and `echo-v10` does not.
 *
 * Run (offline, no API key):
 *   npm run build
 *   npm run sample -- samples/models/agent.ts
 * Try "Hello models".
 *
 * Set ADK_SAMPLE_MODEL to use another registered model instead, for example
 * ADK_SAMPLE_MODEL=gemini-flash-latest. That REQUIRES an API key. Set
 * GEMINI_API_KEY, then:
 *   ADK_SAMPLE_MODEL=gemini-flash-latest npm run sample -- samples/models/agent.ts
 */

import {
  appendInstructions,
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  createEvent,
  createLlmResponse,
  Event,
  InvocationContext,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {FinishReason, GenerateContentResponse} from '@google/genai';

class EchoLlm extends BaseLlm {
  static override readonly supportedModels = [/echo-v1|echo-v2/];

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const reply = `${this.model} heard: ${lastUserText(llmRequest)} (system instruction: ${systemInstructionLength(llmRequest)} characters)`;

    const response = new GenerateContentResponse();
    response.candidates = [
      {
        content: {role: 'model', parts: [{text: reply}]},
        finishReason: FinishReason.STOP,
      },
    ];
    yield createLlmResponse(response);
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(`Live connection is not supported for ${this.model}.`);
  }
}

function lastUserText(llmRequest: LlmRequest): string {
  const userContents = llmRequest.contents.filter(
    (content) => content.role === 'user',
  );
  const parts = userContents[userContents.length - 1]?.parts ?? [];
  const text = parts
    .map((part) => part.text ?? '')
    .join('')
    .trim();
  return text || '(nothing)';
}

function systemInstructionLength(llmRequest: LlmRequest): number {
  const systemInstruction = llmRequest.config?.systemInstruction;
  return typeof systemInstruction === 'string' ? systemInstruction.length : 0;
}

LLMRegistry.register(EchoLlm);

class ModelsShowcaseAgent extends BaseAgent {
  constructor(private readonly modelName: string) {
    super({
      name: 'models_showcase_agent',
      description: 'Sends the user message to a model resolved by name.',
    });
  }

  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const llmRequest: LlmRequest = {
      model: this.modelName,
      contents: ctx.userContent ? [ctx.userContent] : [],
      config: {},
      liveConnectConfig: {},
      toolsDict: {},
    };
    appendInstructions(llmRequest, [
      'Repeat what the user says.',
      'Keep the answer to one sentence.',
    ]);

    const llm = LLMRegistry.newLlm(this.modelName);
    for await (const llmResponse of llm.generateContentAsync(llmRequest)) {
      yield createEvent({
        ...llmResponse,
        invocationId: ctx.invocationId,
        author: this.name,
        branch: ctx.branch,
      });
    }
  }

  protected async *runLiveImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // The request and the model are the same in live mode; delegate rather
    // than duplicate them.
    yield* this.runAsyncImpl(ctx);
  }
}

export const rootAgent = new ModelsShowcaseAgent(
  process.env['ADK_SAMPLE_MODEL'] ?? 'echo-v1',
);
