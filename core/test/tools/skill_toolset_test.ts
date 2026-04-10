/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  InvocationContext,
  ListSkillsTool,
  LlmRequest,
  LoadSkillResourceTool,
  LoadSkillTool,
  ReadonlyContext,
  Skill,
  SkillToolset,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

describe('skill_toolset', () => {
  const mockSkill: Skill = {
    frontmatter: {
      name: 'test-skill',
      description: 'A test skill',
    },
    instructions: 'Test instructions',
    resources: {
      references: {
        'doc.md': 'Doc content',
      },
      assets: {
        'image.png': Buffer.from('fake image data'),
      },
      scripts: {
        'run.sh': {src: 'echo hello'},
      },
    },
  };

  function createMockContext(agentName = 'test-agent') {
    return new Context({
      invocationContext: {
        session: {state: {}},
        agent: {name: agentName},
      } as unknown as InvocationContext,
    });
  }

  describe('ListSkillsTool', () => {
    it('lists available skills', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const tool = new ListSkillsTool(toolset);
      const result = await tool.runAsync({
        args: {},
        toolContext: createMockContext(),
      });
      expect(result).toContain('<name>test-skill</name>');
    });
  });

  describe('LoadSkillTool', () => {
    it('loads skill instructions and updates state', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const tool = new LoadSkillTool(toolset);

      const toolContext = createMockContext('test-agent');

      const result = await tool.runAsync({
        args: {name: 'test-skill'},
        toolContext,
      });

      expect(result).toEqual({
        skill_name: 'test-skill',
        instructions: 'Test instructions',
        frontmatter: mockSkill.frontmatter,
        resources: mockSkill.resources,
      });

      expect(toolContext.state.get('_adk_activated_skill_test-agent')).toEqual([
        'test-skill',
      ]);
    });

    it('returns error if skill not found', async () => {
      const toolset = new SkillToolset([]);
      const tool = new LoadSkillTool(toolset);
      const result = await tool.runAsync({
        args: {name: 'unknown-skill'},
        toolContext: createMockContext(),
      });
      expect(result).toEqual({
        error: "Skill 'unknown-skill' not found.",
        error_code: 'SKILL_NOT_FOUND',
      });
    });
  });

  describe('LoadSkillResourceTool', () => {
    it('loads text resource', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const tool = new LoadSkillResourceTool(toolset);
      const result = await tool.runAsync({
        args: {skill_name: 'test-skill', path: 'references/doc.md'},
        toolContext: createMockContext(),
      });
      expect(result).toEqual({
        skill_name: 'test-skill',
        path: 'references/doc.md',
        content: 'Doc content',
      });
    });

    it('loads script resource', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const tool = new LoadSkillResourceTool(toolset);
      const result = await tool.runAsync({
        args: {skill_name: 'test-skill', path: 'scripts/run.sh'},
        toolContext: createMockContext(),
      });
      expect(result).toEqual({
        skill_name: 'test-skill',
        path: 'scripts/run.sh',
        content: 'echo hello',
      });
    });

    it('handles binary files by returning status', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const tool = new LoadSkillResourceTool(toolset);
      const result = await tool.runAsync({
        args: {skill_name: 'test-skill', path: 'assets/image.png'},
        toolContext: createMockContext(),
      });
      expect(result).toEqual({
        skill_name: 'test-skill',
        path: 'assets/image.png',
        status:
          'Binary file detected. The content has been injected into the conversation history for you to analyze.',
      });
    });

    it('returns error on invalid path', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const tool = new LoadSkillResourceTool(toolset);
      const result = await tool.runAsync({
        args: {skill_name: 'test-skill', path: 'invalid/path.md'},
        toolContext: createMockContext(),
      });
      expect(result).toEqual({
        error: "Path must start with 'references/', 'assets/', or 'scripts/'.",
        error_code: 'INVALID_RESOURCE_PATH',
      });
    });

    it('returns error if resource not found', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const tool = new LoadSkillResourceTool(toolset);
      const result = await tool.runAsync({
        args: {skill_name: 'test-skill', path: 'references/nonexistent.md'},
        toolContext: createMockContext(),
      });
      expect(result).toEqual({
        error:
          "Resource 'references/nonexistent.md' not found in skill 'test-skill'.",
        error_code: 'RESOURCE_NOT_FOUND',
      });
    });

    it('injects binary content in processLlmRequest', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const tool = new LoadSkillResourceTool(toolset);

      const llmRequest: LlmRequest = {
        contents: [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'load_skill_resource',
                  response: {
                    skill_name: 'test-skill',
                    path: 'assets/image.png',
                    status:
                      'Binary file detected. The content has been injected into the conversation history for you to analyze.',
                  },
                },
              },
            ],
          },
        ],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await tool.processLlmRequest({
        toolContext: createMockContext(),
        llmRequest,
      });

      expect(llmRequest.contents.length).toBe(2);
      expect(llmRequest.contents[1].role).toBe('user');
      expect(llmRequest.contents[1].parts?.[1]?.inlineData?.data).toBe(
        Buffer.from('fake image data').toString('base64'),
      );
      expect(llmRequest.contents[1]?.parts?.[1].inlineData?.mimeType).toBe(
        'image/png',
      );
    });

    it('uses default mime type for unknown extension in processLlmRequest', async () => {
      const mockSkillWithUnknownExt: Skill = {
        frontmatter: {name: 'test-skill', description: 'desc'},
        instructions: 'inst',
        resources: {
          assets: {
            'file.unknown': Buffer.from('data'),
          },
        },
      };
      const toolset = new SkillToolset([mockSkillWithUnknownExt]);
      const tool = new LoadSkillResourceTool(toolset);

      const llmRequest: LlmRequest = {
        contents: [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'load_skill_resource',
                  response: {
                    skill_name: 'test-skill',
                    path: 'assets/file.unknown',
                    status:
                      'Binary file detected. The content has been injected into the conversation history for you to analyze.',
                  },
                },
              },
            ],
          },
        ],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await tool.processLlmRequest({
        toolContext: createMockContext(),
        llmRequest,
      });

      expect(llmRequest.contents[1]?.parts?.[1]?.inlineData?.mimeType).toBe(
        'application/octet-stream',
      );
    });
  });

  describe('SkillToolset', () => {
    it('provides default tools', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const tools = await toolset.getTools();
      expect(tools.map((t) => t.name)).toContain('list_skills');
      expect(tools.map((t) => t.name)).toContain('load_skill');
      expect(tools.map((t) => t.name)).toContain('load_skill_resource');
    });

    it('returns default tools only when no context provided', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const tools = await toolset.getTools();
      expect(tools.length).toBe(3);
      expect(tools.map((t) => t.name)).toEqual([
        'list_skills',
        'load_skill',
        'load_skill_resource',
      ]);
    });

    it('returns default tools only when no skills activated', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const context = createMockContext();
      const tools = await toolset.getTools(context);
      expect(tools.length).toBe(3);
    });

    it('appends instructions to LLM request', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const llmRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await toolset.processLlmRequest(createMockContext(), llmRequest);

      expect(llmRequest.config?.systemInstruction).toContain(
        "You can use specialized 'skills'",
      );
      expect(llmRequest.config?.systemInstruction).toContain(
        '<name>test-skill</name>',
      );
    });

    it('resolves additional tools when skill is activated', async () => {
      class DummyTool extends BaseTool {
        constructor() {
          super({name: 'dummy_tool', description: 'dummy'});
        }
        _getDeclaration() {
          return {name: 'dummy_tool', description: 'dummy'};
        }
        async runAsync() {
          return 'dummy';
        }
      }
      const dummyTool = new DummyTool();

      const skillWithTools: Skill = {
        frontmatter: {
          name: 'skill-with-tools',
          description: 'desc',
          metadata: {
            adk_additional_tools: ['dummy_tool'],
          },
        },
        instructions: 'instructions',
      };

      const toolset = new SkillToolset([skillWithTools], {
        additionalTools: [dummyTool],
      });

      const mockState = {
        get: vi.fn().mockReturnValue(['skill-with-tools']),
      };

      const context = {
        agentName: 'test-agent',
        state: mockState,
      } as unknown as ReadonlyContext;

      const tools = await toolset.getTools(context);
      expect(tools.map((t) => t.name)).toContain('dummy_tool');
    });
  });
});
