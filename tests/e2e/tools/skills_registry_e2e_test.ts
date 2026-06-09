/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GCPSkillRegistry,
  InMemoryRunner,
  LlmAgent,
  SkillToolset,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {fileURLToPath} from 'url';
import {describe, expect, it} from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('E2E Live GCP Skills Registry', () => {
  const envPath = path.resolve(__dirname, '../../.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({path: envPath});
  }

  // Live E2E runs require an actual GCP project and a target skill name in the registry
  const hasLiveCredentials =
    !!process.env.GOOGLE_CLOUD_PROJECT && !!process.env.GCP_LIVE_SKILL_NAME;

  it.skipIf(!hasLiveCredentials)(
    'performs live operations against the remote GCP Skill Registry',
    async () => {
      const projectId = process.env.GOOGLE_CLOUD_PROJECT!;
      const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
      const skillName = process.env.GCP_LIVE_SKILL_NAME!;

      const registry = new GCPSkillRegistry({
        projectId,
        location,
      });

      // 1. Fetch remote skill directly from registry
      const skill = await registry.getSkill(skillName);
      expect(skill).toBeDefined();
      expect(skill.frontmatter).toBeDefined();
      expect(skill.frontmatter.name).toBeDefined();
      expect(typeof skill.instructions).toBe('string');

      // 2. Perform search if search query is provided
      if (process.env.GCP_LIVE_SKILL_SEARCH_QUERY) {
        const results = await registry.searchSkills(
          process.env.GCP_LIVE_SKILL_SEARCH_QUERY,
        );
        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBeGreaterThan(0);
        const found = results.some((r) => r.name.includes(skillName));
        expect(found).toBe(true);
      }

      // 3. Integrate with SkillToolset and run a multi-turn agent flow to load the skill
      const toolset = new SkillToolset([], {registry});
      const agent = new LlmAgent({
        name: 'e2e_skills_agent',
        description: 'An agent that resolves skills remotely.',
        tools: [toolset],
        model: 'gemini-2.5-flash',
      });

      const runner = new InMemoryRunner({
        agent,
        appName: 'e2e_skills_test',
      });

      const session = await runner.sessionService.createSession({
        appName: 'e2e_skills_test',
        userId: 'test_user',
      });

      // Execute a prompt asking the agent to load the remote skill.
      // This will force the LLM to request the `load_skill` tool, which fetches from the registry.
      const prompt = `Load the skill named "${skillName}" and summarize its purpose.`;

      let finalResponse = '';
      for await (const event of runner.runAsync({
        userId: 'test_user',
        sessionId: session.id,
        newMessage: createUserContent(prompt),
      })) {
        if (
          event.author === 'e2e_skills_agent' &&
          event.content?.parts?.[0]?.text
        ) {
          finalResponse += event.content.parts[0].text;
        }
      }

      expect(finalResponse.length).toBeGreaterThan(0);
    },
    90000, // E2E remote runs can take time
  );
});
