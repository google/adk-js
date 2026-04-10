import {
  getFunctionCalls,
  listSkillsInDir,
  LlmAgent,
  SkillToolset,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {
  createRunner,
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../../test_case_utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Skills Integration Tests', () => {
  it('should load skills from folder and use them in agent', async () => {
    const skillsDir = path.resolve(__dirname, '../skills');
    const skillsMap = await listSkillsInDir(skillsDir);
    const skills = Object.values(skillsMap);

    expect(skills.length).toBeGreaterThanOrEqual(2);
    expect(skills.map((s) => s.frontmatter.name)).toContain('gws-calendar');
    expect(skills.map((s) => s.frontmatter.name)).toContain('internal-comms');

    const toolset = new SkillToolset(skills);

    const agent = new LlmAgent({
      model: 'gemini-2.5-flash',
      name: 'test_skills_agent',
      description: 'An agent to test skills.',
      tools: [toolset],
    });

    // Mock LLM responses for 3 turns
    const mockResponses: RawGenerateContentResponse[] = [
      // Turn 1: List skills
      {
        candidates: [
          {
            content: {
              parts: [{functionCall: {name: 'list_skills', args: {}, id: '1'}}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [{text: 'I have gws-calendar and internal-comms.'}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
      // Turn 2: Load skill
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'load_skill',
                    args: {name: 'gws-calendar'},
                    id: '2',
                  },
                },
              ],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [{text: 'Loaded gws-calendar.'}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
      // Turn 3: Access resource
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'load_skill_resource',
                    args: {
                      skill_name: 'internal-comms',
                      path: 'references/3p-updates.md',
                    },
                    id: '3',
                  },
                },
              ],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [{text: 'Here is the content of 3p-updates.'}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    agent.model = new GeminiWithMockResponses(mockResponses);

    const runner = await createRunner(agent);

    // Run Turn 1
    let foundListSkillsCall = false;
    for await (const event of runner.run('What skills do you have?')) {
      const functionCalls = getFunctionCalls(event);
      if (functionCalls.some((call) => call.name === 'list_skills')) {
        foundListSkillsCall = true;
      }
    }
    expect(foundListSkillsCall).toBe(true);

    // Run Turn 2
    let foundLoadSkillCall = false;
    for await (const event of runner.run('Load the gws-calendar skill.')) {
      const functionCalls = getFunctionCalls(event);
      if (functionCalls.some((call) => call.name === 'load_skill')) {
        foundLoadSkillCall = true;
      }
    }
    expect(foundLoadSkillCall).toBe(true);

    // Run Turn 3
    let foundLoadResourceCall = false;
    for await (const event of runner.run(
      'Show me the 3p updates guideline from internal-comms.',
    )) {
      const functionCalls = getFunctionCalls(event);
      if (functionCalls.some((call) => call.name === 'load_skill_resource')) {
        foundLoadResourceCall = true;
      }
    }
    expect(foundLoadResourceCall).toBe(true);
  });
});
