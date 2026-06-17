/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InMemoryRunner,
  LlmAgent,
  Skill,
  SkillRegistry,
  SkillToolset,
  UnsafeLocalCodeExecutor,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {GeminiWithMockResponses} from '../test_case_utils.js';

class MockSkillRegistry implements SkillRegistry {
  private skillsMap = new Map<string, Skill>();

  registerSkill(name: string, skill: Skill) {
    this.skillsMap.set(name, skill);
  }

  async getSkill(name: string): Promise<Skill | undefined> {
    return this.skillsMap.get(name);
  }

  async searchSkills(
    query: string,
  ): Promise<Array<{name: string; description: string}>> {
    const results: Array<{name: string; description: string}> = [];
    for (const [name, skill] of this.skillsMap.entries()) {
      if (
        name.includes(query) ||
        skill.frontmatter.description?.includes(query)
      ) {
        results.push({
          name,
          description: skill.frontmatter.description || '',
        });
      }
    }
    return results;
  }
}

describe('Skills Registry Integration', () => {
  const remoteMathSkill: Skill = {
    frontmatter: {
      name: 'remote-math-skill',
      description: 'A registry skill that handles math operations.',
    },
    instructions: 'When asked to solve math, double the number.',
    resources: {
      references: {
        'formulas.txt': 'Double of X is 2*X',
      },
      scripts: {
        'double.js': {
          src: 'const args = process.argv; const val = parseInt(args[args.indexOf("--val") + 1]); console.log(val * 2);',
        },
      },
    },
  };

  const remotePhysicsSkill: Skill = {
    frontmatter: {
      name: 'remote-physics-skill',
      description: 'A registry skill for physics.',
    },
    instructions: 'Force = mass * acceleration.',
  };

  it('should search skills from registry, load a remote skill, and execute its scripts', async () => {
    const registry = new MockSkillRegistry();
    registry.registerSkill('remote-math-skill', remoteMathSkill);
    registry.registerSkill('remote-physics-skill', remotePhysicsSkill);

    const toolset = new SkillToolset([], {
      registry,
      codeExecutor: new UnsafeLocalCodeExecutor(),
    });

    const agent = new LlmAgent({
      name: 'skills_agent',
      description: 'An agent that uses skills.',
      tools: [toolset],
    });

    agent.model = new GeminiWithMockResponses([
      // Turn 1: Model response requests search_skills
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'search_skills',
                    args: {query: 'math'},
                  },
                },
              ],
            },
          },
        ],
      },
      // Turn 2: Model response requests load_skill
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'load_skill',
                    args: {name: 'remote-math-skill'},
                  },
                },
              ],
            },
          },
        ],
      },
      // Turn 3: Model response requests load_skill_resource
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'load_skill_resource',
                    args: {
                      skill_name: 'remote-math-skill',
                      path: 'references/formulas.txt',
                    },
                  },
                },
              ],
            },
          },
        ],
      },
      // Turn 4: Model response requests run_skill_script
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'run_skill_script',
                    args: {
                      skill_name: 'remote-math-skill',
                      script_path: 'scripts/double.js',
                      args: {
                        val: 21,
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
      // Turn 5: Model final response
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'The result is 42.'}],
            },
          },
        ],
      },
    ]);

    const runner = new InMemoryRunner({
      agent,
      appName: 'test_skills_app',
    });

    const session = await runner.sessionService.createSession({
      appName: 'test_skills_app',
      userId: 'test_user',
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('Help me solve some math.'),
    })) {
      events.push(event);
    }

    // Verify search_skills tool execution
    const searchCallEvent = events.find(
      (e) => e.content?.parts?.[0]?.functionCall?.name === 'search_skills',
    );
    expect(searchCallEvent).toBeDefined();

    const searchResponseEvent = events.find(
      (e) => e.content?.parts?.[0]?.functionResponse?.name === 'search_skills',
    );
    expect(searchResponseEvent).toBeDefined();
    expect(
      searchResponseEvent.content.parts[0].functionResponse.response,
    ).toEqual({
      results: [
        {
          name: 'remote-math-skill',
          description: 'A registry skill that handles math operations.',
        },
      ],
    });

    // Verify load_skill tool execution
    const loadCallEvent = events.find(
      (e) => e.content?.parts?.[0]?.functionCall?.name === 'load_skill',
    );
    expect(loadCallEvent).toBeDefined();

    const loadResponseEvent = events.find(
      (e) => e.content?.parts?.[0]?.functionResponse?.name === 'load_skill',
    );
    expect(loadResponseEvent).toBeDefined();
    expect(
      loadResponseEvent.content.parts[0].functionResponse.response.instructions,
    ).toBe('When asked to solve math, double the number.');

    // Verify load_skill_resource tool execution
    const resourceCallEvent = events.find(
      (e) =>
        e.content?.parts?.[0]?.functionCall?.name === 'load_skill_resource',
    );
    expect(resourceCallEvent).toBeDefined();

    const resourceResponseEvent = events.find(
      (e) =>
        e.content?.parts?.[0]?.functionResponse?.name === 'load_skill_resource',
    );
    expect(resourceResponseEvent).toBeDefined();
    expect(
      resourceResponseEvent.content.parts[0].functionResponse.response.content,
    ).toBe('Double of X is 2*X');

    // Verify run_skill_script tool execution
    const runCallEvent = events.find(
      (e) => e.content?.parts?.[0]?.functionCall?.name === 'run_skill_script',
    );
    expect(runCallEvent).toBeDefined();

    const runResponseEvent = events.find(
      (e) =>
        e.content?.parts?.[0]?.functionResponse?.name === 'run_skill_script',
    );
    expect(runResponseEvent).toBeDefined();
    expect(
      runResponseEvent.content.parts[0].functionResponse.response.stdout,
    ).toContain('42');
  });
});
