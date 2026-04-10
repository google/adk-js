/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlugin,
  BaseTool,
  Context,
  InMemoryRunner,
  LlmAgent,
  LOAD_ARTIFACTS,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';

class FilterPlugin extends BasePlugin {
  constructor() {
    super('filter_plugin');
  }

  override async beforeToolSelection(params: {
    callbackContext: Context;
    tools: Readonly<Record<string, BaseTool>>;
  }) {
    const filtered: Record<string, BaseTool> = {};
    for (const [name, tool] of Object.entries(params.tools)) {
      if (name !== LOAD_ARTIFACTS.name) {
        filtered[name] = tool;
      }
    }
    return filtered;
  }
}

describe('E2E beforeToolSelection', () => {
  const envPath = path.resolve(__dirname, '.env');
  const envExists = fs.existsSync(envPath);

  if (envExists) {
    dotenv.config({path: envPath});
  }

  const hasAKey =
    !!process.env.GEMINI_API_KEY ||
    !!process.env.GOOGLE_GENAI_API_KEY ||
    !!process.env.GOOGLE_CLOUD_PROJECT;

  it.skipIf(!hasAKey)(
    'should filter out LOAD_ARTIFACTS tool and fail to answer',
    async () => {
      const filterPlugin = new FilterPlugin();
      const agent = new LlmAgent({
        name: 'e2e_filter_agent',
        description: 'An agent that reads artifacts.',
        instruction:
          'You have tools to load artifacts. Use them to read artifacts if the user asks about them, and give a short answer based solely on the artifact content.',
        model: 'gemini-2.5-flash',
        tools: [LOAD_ARTIFACTS],
      });

      const runner = new InMemoryRunner({
        agent,
        appName: 'e2e_tool_test',
        plugins: [filterPlugin],
      });
      const session = await runner.sessionService.createSession({
        appName: 'e2e_tool_test',
        userId: 'test_user',
      });

      // Provide an artifact
      const csvBytes = Buffer.from(
        'name,age\nAlice,12345\nBob,25\n',
        'utf8',
      ).toString('base64');
      await runner.artifactService!.saveArtifact({
        appName: 'e2e_tool_test',
        userId: 'test_user',
        sessionId: session.id,
        filename: 'people.csv',
        artifact: {
          inlineData: {
            data: csvBytes,
            mimeType: 'application/csv',
          },
        },
      });

      let finalResponse = '';
      for await (const event of runner.runAsync({
        userId: 'test_user',
        sessionId: session.id,
        newMessage: createUserContent(
          'What is the age of Alice in people.csv?',
        ),
      })) {
        if (
          event.author === 'e2e_filter_agent' &&
          event.content?.parts?.[0]?.text
        ) {
          finalResponse += event.content.parts[0].text;
        }
      }

      // Check the output
      // Since the tool was filtered out, the agent should NOT be able to answer '12345'.
      expect(finalResponse.toLowerCase()).not.toContain('12345');
    },
    30000,
  );

  it.skipIf(!hasAKey)(
    'should NOT filter out LOAD_ARTIFACTS tool when plugin returns undefined',
    async () => {
      class NoOpPlugin extends BasePlugin {
        constructor() {
          super('noop_plugin');
        }
        override async beforeToolSelection() {
          return undefined;
        }
      }

      const agent = new LlmAgent({
        name: 'e2e_noop_agent',
        description: 'An agent that reads artifacts.',
        instruction:
          'You have tools to load artifacts. Use them to read artifacts if the user asks about them, and give a short answer based solely on the artifact content.',
        model: 'gemini-2.5-flash',
        tools: [LOAD_ARTIFACTS],
      });

      const runner = new InMemoryRunner({
        agent,
        appName: 'e2e_tool_test',
        plugins: [new NoOpPlugin()],
      });
      const session = await runner.sessionService.createSession({
        appName: 'e2e_tool_test',
        userId: 'test_user',
      });

      // Provide an artifact
      const csvBytes = Buffer.from(
        'name,age\nAlice,12345\nBob,25\n',
        'utf8',
      ).toString('base64');
      await runner.artifactService!.saveArtifact({
        appName: 'e2e_tool_test',
        userId: 'test_user',
        sessionId: session.id,
        filename: 'people.csv',
        artifact: {
          inlineData: {
            data: csvBytes,
            mimeType: 'application/csv',
          },
        },
      });

      let finalResponse = '';
      for await (const event of runner.runAsync({
        userId: 'test_user',
        sessionId: session.id,
        newMessage: createUserContent(
          'What is the age of Alice in people.csv?',
        ),
      })) {
        if (
          event.author === 'e2e_noop_agent' &&
          event.content?.parts?.[0]?.text
        ) {
          finalResponse += event.content.parts[0].text;
        }
      }

      // Check the output
      expect(finalResponse.toLowerCase()).toContain('12345');
    },
    30000,
  );
});
