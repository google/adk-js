/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentEngineClient} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('AgentEngineClient E2E', () => {
  it.skipIf(!process.env.AGENT_ENGINE_ID)('should run e2e query', async () => {
    const project = process.env.GOOGLE_CLOUD_PROJECT || 'test-project';
    const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
    const reasoningEngineId = process.env.AGENT_ENGINE_ID!;

    const client = new AgentEngineClient({
      project,
      location,
      reasoningEngineId,
    });

    const qRes = await client.query({message: 'Hello, what can you do?'});
    expect(qRes).toBeDefined();

    const chunks: unknown[] = [];
    for await (const chunk of client.streamQuery({message: 'Hello'})) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
  });
});
