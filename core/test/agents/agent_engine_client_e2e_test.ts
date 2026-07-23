/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, it} from 'vitest';
import {AgentEngineClient} from '../../src/agents/agent_engine_client.js';

describe('AgentEngineClient E2E', () => {
  it.skipIf(!process.env.AGENT_ENGINE_ID)('should run e2e query', async () => {
    const project = process.env.GOOGLE_CLOUD_PROJECT || 'test-project';
    const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
    const reasoningEngineId = process.env.AGENT_ENGINE_ID;

    if (!reasoningEngineId) return;

    const client = new AgentEngineClient({
      project,
      location,
      reasoningEngineId,
    });

    console.log('--- Testing Query ---');
    const qRes = await client.query({message: 'Hello, what can you do?'});
    console.log('Query Response:', qRes);

    console.log('--- Testing Stream Query ---');
    for await (const chunk of client.streamQuery({message: 'Hello'})) {
      console.log('Chunk:', chunk);
    }
  });
});
