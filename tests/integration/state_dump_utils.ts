/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event, LlmResponse} from '@google/adk';
import {
  BaseAgent,
  BasePlugin,
  Context,
  InMemoryRunner,
  LlmAgent,
} from '@google/adk';
import {GenerateContentResponse, createUserContent} from '@google/genai';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

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

function toGenAIResponse(response: LlmResponse): GenerateContentResponse {
  const result = new GenerateContentResponse();

  result.candidates = [
    {
      content: response.content,
      groundingMetadata: response.groundingMetadata,
      finishReason: response.finishReason,
    },
  ];
  result.usageMetadata = response.usageMetadata;

  return result;
}

/**
 * A plugin that captures all model responses.
 */
export class ModelEventCapturePlugin extends BasePlugin {
  private modelResponses: GenerateContentResponse[] = [];

  async afterModelCallback(params: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    this.modelResponses.push(toGenAIResponse(params.llmResponse));
    return params.llmResponse;
  }

  dump(fileName: string): Promise<void> {
    const modelResponses = this.modelResponses;
    this.modelResponses = [];

    return fs.writeFile(
      path.join(process.cwd(), fileName),
      JSON.stringify(modelResponses, null, 2),
    );
  }
}

/**
 * A plugin that captures all agent events.
 */
export class AgentEventCapturePlugin extends BasePlugin {
  private events: Event[] = [];

  async onEventCallback(params: {event: Event}): Promise<Event | undefined> {
    this.events.push(params.event);
    return params.event;
  }

  dump(fileName: string): Promise<void> {
    const events = this.events;
    this.events = [];

    return fs.writeFile(
      path.join(process.cwd(), fileName),
      JSON.stringify(events, null, 2),
    );
  }
}

/**
 * Runs the agent with the given prompt and plugins.
 */
export async function runAndCapture(
  agent: LlmAgent,
  prompt: string,
  {
    events,
    modelResponses,
  }: {
    events?: string | boolean;
    modelResponses?: string | boolean;
  },
) {
  const plugins: BasePlugin[] = [];
  if (events) {
    plugins.push(new AgentEventCapturePlugin('agent_events'));
  }
  if (modelResponses) {
    plugins.push(new ModelEventCapturePlugin('model_responses'));
  }
  const runner = await createRunner(agent, plugins);

  for await (const _e of runner.run(prompt)) {
    // Do nothing. The plugins will capture events and model responses.
  }

  for (const plugin of plugins) {
    if (plugin instanceof AgentEventCapturePlugin) {
      plugin.dump(
        typeof events === 'boolean' ? 'agent_events.json' : (events as string),
      );
    }
    if (plugin instanceof ModelEventCapturePlugin) {
      plugin.dump(
        typeof modelResponses === 'boolean'
          ? 'model_responses.json'
          : (modelResponses as string),
      );
    }
  }
}
