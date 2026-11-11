/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Gemini, LlmRequest} from '@google/adk';
import {Modality} from '@google/genai';
import * as dotenv from 'dotenv';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// No existsSync guard: a missing .env is the normal CI state and dotenv
// reports it in the return value instead of throwing.
dotenv.config({
  path: fileURLToPath(new URL('.env', import.meta.url)),
  quiet: true,
});

// No sensible default for a project id, so unset means skip, not fail.
const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

describe.skipIf(!project)('Live Gemini Live Connection E2E', () => {
  it('should connect and stream responses from Gemini Live using Vertex AI', async () => {
    const llm = new Gemini({
      model: 'gemini-live-2.5-flash-native-audio',
      vertexai: true,
      project,
      location,
    });

    const request: LlmRequest = {
      model: 'gemini-live-2.5-flash-native-audio',
      contents: [],
      liveConnectConfig: {
        responseModalities: [Modality.AUDIO],
        outputAudioTranscription: {},
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

    while (true) {
      const next = await generator.next();
      if (next.done) {
        break;
      }
      const response = next.value;

      if (response.content?.parts) {
        for (const part of response.content.parts) {
          if (part.text) {
            accumulatedText += part.text;
          }
        }
      }
      if (response.outputTranscription?.text) {
        accumulatedText += response.outputTranscription.text;
      }
      if (response.turnComplete) {
        gotTurnComplete = true;
        break;
      }
    }

    expect(accumulatedText.length).toBeGreaterThan(0);
    expect(accumulatedText.toLowerCase()).toMatch(/4|four/);
    expect(gotTurnComplete).toBe(true);

    await connection.close();
  }, 30000);

  it('should support multi-turn conversations over the same live connection', async () => {
    const llm = new Gemini({
      model: 'gemini-live-2.5-flash-native-audio',
      vertexai: true,
      project,
      location,
    });

    const request: LlmRequest = {
      model: 'gemini-live-2.5-flash-native-audio',
      contents: [],
      liveConnectConfig: {
        responseModalities: [Modality.AUDIO],
        outputAudioTranscription: {},
      },
      config: {
        systemInstruction: 'You are a helpful assistant.',
      },
      toolsDict: {},
    };

    const connection = await llm.connect(request);
    expect(connection).toBeDefined();

    const generator = connection.receive();

    // Turn 1: Tell model our name
    await connection.sendContent({
      parts: [{text: 'Hello Gemini! My name is Alice.'}],
    });

    // Consume until turnComplete
    while (true) {
      const next = await generator.next();
      if (next.done) {
        break;
      }
      const response = next.value;
      if (response.turnComplete) {
        break;
      }
    }

    // Turn 2: Ask model what our name is
    await connection.sendContent({
      parts: [{text: 'Can you tell me what my name is?'}],
    });

    let accumulatedText = '';
    let gotTurnComplete = false;
    while (true) {
      const next = await generator.next();
      if (next.done) {
        break;
      }
      const response = next.value;
      if (response.content?.parts) {
        for (const part of response.content.parts) {
          if (part.text) {
            accumulatedText += part.text;
          }
        }
      }
      if (response.outputTranscription?.text) {
        accumulatedText += response.outputTranscription.text;
      }
      if (response.turnComplete) {
        gotTurnComplete = true;
        break;
      }
    }

    expect(accumulatedText.toLowerCase()).toContain('alice');
    expect(gotTurnComplete).toBe(true);

    await connection.close();
  }, 45000);

  // Note: Gemini 3.1 Live is currently in private preview and requires explicit project allowlisting on Vertex AI (yields 1008 Policy Violation otherwise).
  it.skip('should connect and stream responses from Gemini 3.1 Live using Vertex AI', async () => {
    const llm = new Gemini({
      model: 'gemini-3.1-flash-live-preview-04-2026',
      vertexai: true,
      project,
      location,
    });

    const request: LlmRequest = {
      model: 'gemini-3.1-flash-live-preview-04-2026',
      contents: [],
      liveConnectConfig: {
        responseModalities: [Modality.AUDIO],
        outputAudioTranscription: {},
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
      parts: [{text: 'Hello Gemini 3.1! What is 2 + 2?'}],
    });

    // Consume events
    let accumulatedText = '';
    let gotTurnComplete = false;

    while (true) {
      const next = await generator.next();
      if (next.done) {
        break;
      }
      const response = next.value;

      if (response.content?.parts) {
        for (const part of response.content.parts) {
          if (part.text) {
            accumulatedText += part.text;
          }
        }
      }
      if (response.outputTranscription?.text) {
        accumulatedText += response.outputTranscription.text;
      }
      if (response.turnComplete) {
        gotTurnComplete = true;
        break;
      }
    }

    expect(accumulatedText.length).toBeGreaterThan(0);
    expect(accumulatedText.toLowerCase()).toMatch(/4|four/);
    expect(gotTurnComplete).toBe(true);

    await connection.close();
  }, 30000);
});
