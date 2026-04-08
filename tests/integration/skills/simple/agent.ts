/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  FunctionTool,
  LlmAgent,
  loadSkillFromDir,
  LogLevel,
  RunAsyncToolRequest,
  setLogLevel,
  Skill,
  SkillToolset,
  UnsafeLocalCodeExecutor,
} from '@google/adk';
import {FunctionDeclaration} from '@google/genai';
import * as path from 'node:path';

setLogLevel(LogLevel.ERROR);

class GetTimezoneTool extends BaseTool {
  constructor() {
    super({
      name: 'get_timezone',
      description: 'Returns the timezone for a given location.',
    });
  }

  _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parametersJsonSchema: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'The location to get the timezone for.',
          },
        },
        required: ['location'],
      },
    };
  }

  async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    return `The timezone for ${request.args['location']} is UTC+00:00.`;
  }
}

const getWindSpeedTool = new FunctionTool({
  name: 'get_wind_speed',
  description: 'Returns the wind speed for a given location.',
  execute: (location: string) => `The wind speed in ${location} is 10 mph.`,
});

const greetingSkill: Skill = {
  name: 'greeting-skill',
  description:
    'A friendly greeting skill that can say hello to a specific person.',
  frontmatter: {
    name: 'greeting-skill',
    description:
      'A friendly greeting skill that can say hello to a specific person.',
    metadata: {'adk_additional_tools': ['get_timezone']},
  },
  instructions:
    "Step 1: Read the 'references/hello_world.txt' file to understand how to greet the user. Step 2: Return a greeting based on the reference.",
  resources: {
    references: {
      'hello_world.txt': 'Hello! 👋👋👋 So glad to have you here! ✨✨✨',
      'example.md': 'This is an example reference.',
    },
    assets: {},
    scripts: {},
  },
};

const weatherSkill = await loadSkillFromDir(
  path.join(__dirname, 'weather-skill'),
);

const mySkillToolset = new SkillToolset([greetingSkill, weatherSkill], {
  additionalTools: [new GetTimezoneTool(), getWindSpeedTool],
  codeExecutor: new UnsafeLocalCodeExecutor(),
});

export const rootAgent = new LlmAgent({
  model: 'gemini-2.5-flash',
  name: 'skill_user_agent',
  description: 'An agent that can use specialized skills.',
  tools: [mySkillToolset],
});
