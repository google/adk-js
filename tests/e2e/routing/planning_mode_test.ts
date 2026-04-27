/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionTool, InMemoryRunner, LlmAgent, RoutedAgent} from '@google/adk';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const envPath = path.resolve(__dirname, '.env');
const envExists = fs.existsSync(envPath);

if (envExists) {
  dotenv.config({path: envPath});
}

const hasAKey =
  !!process.env.GEMINI_API_KEY ||
  !!process.env.GOOGLE_GENAI_API_KEY ||
  !!process.env.GOOGLE_CLOUD_PROJECT;

describe.skipIf(!hasAKey)('E2e Planning Mode with RoutedAgent', () => {
  // Global flag for planning mode
  let planningMode = false;

  // Tools
  const readFileTool = new FunctionTool({
    name: 'read_file',
    description: 'Reads content from a local file.',
    parameters: z.object({
      filePath: z.string().describe('The path to the file to read.'),
    }),
    execute: async ({filePath}: {filePath: string}) => {
      return fs.readFileSync(filePath, 'utf-8');
    },
  });

  const writeFileTool = new FunctionTool({
    name: 'write_file',
    description: 'Writes content to a local file.',
    parameters: z.object({
      filePath: z.string().describe('The path to the file to write to.'),
      content: z.string().describe('The content to write.'),
    }),
    execute: async ({
      filePath,
      content,
    }: {
      filePath: string;
      content: string;
    }) => {
      fs.writeFileSync(filePath, content);
      return `Successfully wrote to ${filePath}`;
    },
  });

  // Agents
  const basicAgent = new LlmAgent({
    name: 'basic_agent',
    model: 'gemini-3-flash-preview',
    description: 'Basic agent with read/write file tools.',
    instruction:
      'You are a basic assistant. Use the tools provided to answer questions.',
    tools: [readFileTool, writeFileTool],
  });

  const advancedAgent = new LlmAgent({
    name: 'advanced_agent',
    model: 'gemini-3.1-pro-preview',
    description: 'Advanced agent with read-only file tool.',
    instruction:
      'You are a planning expert. Plan carefully and think systematically.',
    tools: [readFileTool],
  });

  const agents = {
    'basic': basicAgent,
    'advanced': advancedAgent,
  };

  const router = async () => {
    return planningMode ? 'advanced' : 'basic';
  };

  const routedAgent = new RoutedAgent({
    name: 'test-routed-agent',
    agents,
    router,
  });

  it('should route to basic Agent when planningMode is false', async () => {
    planningMode = false;
    const runner = new InMemoryRunner({
      agent: routedAgent,
      appName: 'planning_mode_test',
    });
    const session = await runner.sessionService.createSession({
      appName: 'planning_mode_test',
      userId: 'test_user',
    });

    const responseGen = runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Say "Basic Mode"'}]},
    });

    let responseText = '';
    for await (const response of responseGen) {
      if (response.content?.parts?.[0]?.text) {
        responseText += response.content.parts[0].text;
      }
    }
    expect(responseText).toBeTruthy();
  }, 30000);

  it('should route to advanced Agent when planningMode is true', async () => {
    planningMode = true;
    const runner = new InMemoryRunner({
      agent: routedAgent,
      appName: 'planning_mode_test',
    });
    const session = await runner.sessionService.createSession({
      appName: 'planning_mode_test',
      userId: 'test_user',
    });

    const responseGen = runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Say "Advanced Mode"'}]},
    });

    let responseText = '';
    for await (const response of responseGen) {
      if (response.content?.parts?.[0]?.text) {
        responseText += response.content.parts[0].text;
      }
    }
    expect(responseText).toBeTruthy();
  }, 30000);
});
