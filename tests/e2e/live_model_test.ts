/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Gemini, LlmRequest} from '@google/adk';
import {describe, expect, it} from 'vitest';

const isCI = process.env.CI === 'true';

describe.skipIf(isCI)('Live Gemini Live Connection E2E', () => {
  const project =
    process.env.GCP_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    'placeholder-project';
  const location = process.env.GCP_LOCATION || 'us-central1';

  it('should connect and stream responses from Gemini Live using Vertex AI', async () => {
    console.log(
      `Connecting to Live API using project: ${project}, location: ${location}`,
    );
    const llm = new Gemini({
      model: 'gemini-2.5-flash',
      vertexai: true,
      project,
      location,
    });

    const request: LlmRequest = {
      model: 'gemini-2.5-flash',
      liveConnectConfig: {
        responseModalities: ['text'],
      },
      config: {
        systemInstruction:
          'You are a helpful assistant. Answer concisely in one sentence.',
      },
      toolsDict: {},
    };

    const connection = await llm.connect(request);
    expect(connection).toBeDefined();

    const generator = connection.receive();

    // Send a message to the live model
    await connection.sendContent({
      parts: [{text: 'Hello Gemini Live! What is 2 + 2?'}],
    });

    // Consume events
    let accumulatedText = '';
    let gotTurnComplete = false;

    for (let i = 0; i < 20; i++) {
      const next = await generator.next();
      if (next.done) {
        break;
      }
      const response = next.value;
      console.log('Received response event:', JSON.stringify(response));

      if (response.content?.parts) {
        for (const part of response.content.parts) {
          if (part.text) {
            accumulatedText += part.text;
          }
        }
      }
      if (response.turnComplete) {
        gotTurnComplete = true;
        break;
      }
    }

    console.log('Accumulated text response:', accumulatedText);
    expect(accumulatedText.length).toBeGreaterThan(0);
    expect(accumulatedText).toContain('4');
    expect(gotTurnComplete).toBe(true);

    await connection.close();
  }, 30000);
});
