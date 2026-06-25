/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionTool, Gemini, InMemoryRunner, LlmAgent} from '@google/adk';
import {createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const hasAKey =
  !!process.env.GEMINI_API_KEY ||
  !!process.env.GOOGLE_GENAI_API_KEY ||
  !!process.env.GOOGLE_CLOUD_PROJECT ||
  !!process.env.GCP_PROJECT;

describe.skipIf(!hasAKey)('Manual Callback Validation E2E', () => {
  it('should throw validation error when beforeToolCallback returns invalid data', async () => {
    const schemaTool = new FunctionTool({
      name: 'schemaTool',
      description: 'a tool that returns a string result',
      parameters: z.object({}),
      outputSchema: z.object({
        result: z.string(),
      }),
      execute: async () => ({result: 'ok'}),
    });

    const project = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
    const location =
      process.env.GCP_LOCATION ||
      process.env.GOOGLE_CLOUD_LOCATION ||
      'us-central1';

    const llm = new Gemini({
      model: 'gemini-2.5-flash',
      vertexai: true,
      project,
      location,
    });

    const agent = new LlmAgent({
      name: 'validation_agent',
      instruction: 'Call schemaTool and report the result.',
      model: llm,
      tools: [schemaTool],
      beforeToolCallback: async () => {
        // Return invalid data (missing 'result' field, or wrong type)
        return {wrong_field: 123};
      },
    });

    const runner = new InMemoryRunner({
      agent,
      appName: 'manual_validation_test',
    });

    const session = await runner.sessionService.createSession({
      appName: 'manual_validation_test',
      userId: 'test_user',
    });

    const generator = runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('Call the schemaTool.'),
    });

    const events = [];
    for await (const event of generator) {
      events.push(event);
    }

    const errorEvent = events.find((e) => e.errorCode);
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.errorMessage).toContain(
      'Validation failed for beforeToolCallback for tool schemaTool',
    );
  }, 30000);
});
