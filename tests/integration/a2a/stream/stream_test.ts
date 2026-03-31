/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event as AdkEvent, InMemoryRunner, RemoteA2AAgent} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {AdkTsApiServer} from '../../test_api_server.js';

const TEST_TIMEOUT = 30000;

describe('A2A: RemoteAgent Streaming', () => {
  let server: AdkTsApiServer;

  beforeAll(async () => {
    server = new AdkTsApiServer({
      agentsDir: path.join(__dirname, 'test_agents'),
      a2a: true,
      startFailureTimeout: TEST_TIMEOUT,
    });
    await server.start();
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await server.stop();
  });

  it('Gemini Success', async () => {
    const modelTextChunk1 = 'Hello, ';
    const modelTextChunk2 = 'I am ';
    const modelTextChunk3 = 'a streaming agent!';
    const remoteAgent = new RemoteA2AAgent({
      name: 'streaming_success',
      agentCard: `${server.url}/a2a/streaming_success/`,
    });

    const runner = new InMemoryRunner({agent: remoteAgent, appName: 'caller'});
    const session = await runner.sessionService.createSession({
      appName: 'caller',
      userId: 'caller-user',
    });

    const events: AdkEvent[] = [];
    for await (const ev of runner.runAsync({
      userId: 'caller-user',
      sessionId: session.id,
      newMessage: createUserContent('Speak'),
    })) {
      events.push(ev);
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    const textChunks = events.map((ev) => ev.content?.parts?.[0]?.text || '');
    expect(textChunks).toEqual([
      modelTextChunk1,
      modelTextChunk2,
      modelTextChunk3,
    ]);
  });

  it('Gemini Error', async () => {
    const errorMessage = 'Mid-stream connection failure!';
    const remoteAgent = new RemoteA2AAgent({
      name: 'streaming_error',
      agentCard: `${server.url}/a2a/streaming_error/`,
    });

    const runner = new InMemoryRunner({agent: remoteAgent, appName: 'caller'});
    const session = await runner.sessionService.createSession({
      appName: 'caller',
      userId: 'caller-user',
    });

    const events: AdkEvent[] = [];
    for await (const ev of runner.runAsync({
      userId: 'caller-user',
      sessionId: session.id,
      newMessage: createUserContent('Speak'),
    })) {
      events.push(ev);
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    const finalEvent = events[events.length - 1];
    expect(finalEvent.errorMessage).toContain(
      'Agent run failed: ' + errorMessage,
    );
  });
});
