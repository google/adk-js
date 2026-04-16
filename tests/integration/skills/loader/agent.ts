/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent, SkillToolset, loadAllSkillsInDir} from '@google/adk';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillsDir = path.resolve(__dirname, '../skills');
const skills = await loadAllSkillsInDir(skillsDir);

export const rootAgent = new LlmAgent({
  name: 'test_skills_agent',
  description: 'An agent to test skills.',
  model: 'gemini-2.5-flash',
  tools: [new SkillToolset(skills)],
});
