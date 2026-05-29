/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentRegistry, InMemoryRunner, LlmAgent} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';

describe('E2E Live Agent Registry', () => {
  const envPath = path.resolve(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({path: envPath});
  }

  // A true live, unmocked run requires an actual GCP project and active MCP Server resource ID
  const hasLiveCredentials =
    !!process.env.GOOGLE_CLOUD_PROJECT &&
    !!process.env.GCP_LIVE_MCP_SERVER_RESOURCE;

  it.skipIf(!hasLiveCredentials)(
    'performs a completely unmocked live connection to GCP Agent Registry and invokes remote tools via Gemini',
    async () => {
      const registry = new AgentRegistry({
        projectId: process.env.GOOGLE_CLOUD_PROJECT!,
        location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
      });

      // 1. Fully unmocked REST call to Google Cloud Agent Registry and Tool binding
      const toolset = await registry.getMcpToolset(
        process.env.GCP_LIVE_MCP_SERVER_RESOURCE!,
      );
      expect(toolset).toBeDefined();

      const agent = new LlmAgent({
        name: 'e2e_registry_agent',
        description: 'An agent that executes live GCP MCP tools.',
        instruction:
          'You are connected to live GCP server tools. Use them to check the user requested status.',
        model: 'gemini-2.5-flash',
        tools: [toolset],
      });

      const runner = new InMemoryRunner({
        agent,
        appName: 'e2e_registry_test',
      });
      const session = await runner.sessionService.createSession({
        appName: 'e2e_registry_test',
        userId: 'test_user',
      });

      let finalResponse = '';
      for await (const event of runner.runAsync({
        userId: 'test_user',
        sessionId: session.id,
        newMessage: createUserContent('Check system connection status'),
      })) {
        if (
          event.author === 'e2e_registry_agent' &&
          event.content?.parts?.[0]?.text
        ) {
          finalResponse += event.content.parts[0].text;
        }
      }

      expect(finalResponse.length).toBeGreaterThan(0);
    },
    60000,
  );
});
