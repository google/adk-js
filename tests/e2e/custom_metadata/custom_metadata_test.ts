/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Agent, Gemini, InMemoryRunner} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {fileURLToPath} from 'url';
import {describe, expect, it} from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try to load .env from tests/e2e or root
const envPaths = [
  path.resolve(__dirname, '../.env'),
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '.env'),
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({path: envPath});
    break;
  }
}

const hasAKey =
  !!process.env.GEMINI_API_KEY ||
  !!process.env.GOOGLE_GENAI_API_KEY ||
  !!process.env.GOOGLE_CLOUD_PROJECT;

describe.skipIf(!hasAKey)('E2e customMetadata Support', () => {
  it('should propagate customMetadata through a real run and attach to user event', async () => {
    const model = new Gemini({model: 'gemini-2.5-flash'});
    const agent = new Agent({
      name: 'custom_metadata_agent',
      model,
      instructions: 'You are a helpful assistant. Reply shortly.',
    });

    const runner = new InMemoryRunner({
      agent,
      appName: 'e2e_custom_metadata_test',
    });

    const customMetadata = {
      source: 'e2e-test',
      priority: 'high',
      nested: {
        key: 'value',
      },
    };

    const session = await runner.sessionService.createSession({
      appName: 'e2e_custom_metadata_test',
      userId: 'e2e_user',
    });

    const responseGen = runner.runAsync({
      userId: 'e2e_user',
      sessionId: session.id,
      newMessage: createUserContent('Hello, who are you?'),
      customMetadata,
    });

    // Drain the generator
    const events = [];
    for await (const event of responseGen) {
      events.push(event);
    }

    // Retrieve the session and check events
    const updatedSession = await runner.sessionService.getSession({
      appName: 'e2e_custom_metadata_test',
      userId: 'e2e_user',
      sessionId: session.id,
    });

    expect(updatedSession).not.toBeNull();
    // We expect at least:
    // 1. User message event (with customMetadata)
    // 2. Model response event(s)
    expect(updatedSession!.events.length).toBeGreaterThanOrEqual(2);

    const userEvent = updatedSession!.events.find((e) => e.author === 'user');
    expect(userEvent).toBeDefined();
    expect(userEvent!.customMetadata).toEqual(customMetadata);
  }, 30000); // 30s timeout
});
