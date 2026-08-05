/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  BaseToolset,
  Context,
  InvocationContext,
  LlmRequest,
  ReadonlyContext,
  Skill,
  SkillToolset,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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
      expect(tools.length).toBe(4);
      expect(tools.map((t) => t.name)).toEqual([
        'list_skills',
        'load_skill',
        'load_skill_resource',
        'run_skill_script',
      ]);
    });

    it('returns default tools only when no skills activated', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const context = createMockContext();
      const tools = await toolset.getTools(context);
      expect(tools.length).toBe(4);
    });

    it('does not expose the inline-script tool by default', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const tools = await toolset.getTools();
      expect(tools.map((t) => t.name)).not.toContain('run_skill_inline_script');
    });

    it('does not expose the inline-script tool when the flag is false', async () => {
      const toolset = new SkillToolset([mockSkill], {
        allowInlineScripts: false,
      });
      const tools = await toolset.getTools();
      expect(tools.map((t) => t.name)).not.toContain('run_skill_inline_script');
    });

    it('exposes the inline-script tool when allowInlineScripts is true', async () => {
      const toolset = new SkillToolset([mockSkill], {
        allowInlineScripts: true,
      });
      const tools = await toolset.getTools();
      expect(tools.map((t) => t.name)).toContain('run_skill_inline_script');
      expect(tools.length).toBe(5);
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

    it('throws error when duplicate BaseTool names are provided in additionalTools', async () => {
      class DummyTool extends BaseTool {
        constructor(name: string) {
          super({name, description: 'dummy'});
        }
        _getDeclaration() {
          return {name: this.name, description: 'dummy'};
        }
        async runAsync() {
          return 'dummy';
        }
      }
      const tool1 = new DummyTool('duplicate_tool');
      const tool2 = new DummyTool('duplicate_tool');

      const skillWithTools: Skill = {
        frontmatter: {
          name: 'skill-with-tools',
          description: 'desc',
          metadata: {
            adk_additional_tools: ['duplicate_tool'],
          },
        },
        instructions: 'instructions',
      };

      const toolset = new SkillToolset([skillWithTools], {
        additionalTools: [tool1, tool2],
      });

      const mockState = {
        get: vi.fn().mockReturnValue(['skill-with-tools']),
      };

      const context = {
        agentName: 'test-agent',
        state: mockState,
      } as unknown as ReadonlyContext;

      await expect(toolset.getTools(context)).rejects.toThrow(
        'Duplicate tool name: duplicate_tool',
      );
    });

    it('throws error when duplicate tool names are detected via BaseToolset in additionalTools', async () => {
      class DummyTool extends BaseTool {
        constructor(name: string) {
          super({name, description: 'dummy'});
        }
        _getDeclaration() {
          return {name: this.name, description: 'dummy'};
        }
        async runAsync() {
          return 'dummy';
        }
      }

      class DummyToolset extends BaseToolset {
        constructor(private mockTools: BaseTool[]) {
          super([]);
        }
        override async getTools() {
          return this.mockTools;
        }
        override async close() {}
      }

      const tool1 = new DummyTool('shared_name');
      const tool2 = new DummyTool('shared_name');
      const customToolset = new DummyToolset([tool2]);

      const skillWithTools: Skill = {
        frontmatter: {
          name: 'skill-with-tools',
          description: 'desc',
          metadata: {
            adk_additional_tools: ['shared_name'],
          },
        },
        instructions: 'instructions',
      };

      const toolset = new SkillToolset([skillWithTools], {
        additionalTools: [tool1, customToolset],
      });

      const mockState = {
        get: vi.fn().mockReturnValue(['skill-with-tools']),
      };

      const context = {
        agentName: 'test-agent',
        state: mockState,
      } as unknown as ReadonlyContext;

      await expect(toolset.getTools(context)).rejects.toThrow(
        'Duplicate tool name: shared_name',
      );
    });

    it('caches resolved tools and avoids recalculating candidateTools', async () => {
      class DummyTool extends BaseTool {
        constructor() {
          super({name: 'cached_tool', description: 'dummy'});
        }
        _getDeclaration() {
          return {name: 'cached_tool', description: 'dummy'};
        }
        async runAsync() {
          return 'dummy';
        }
      }

      const mockInnerGetTools = vi.fn().mockResolvedValue([new DummyTool()]);

      class SpyToolset extends BaseToolset {
        constructor() {
          super([]);
        }
        override getTools = mockInnerGetTools;
        override async close() {}
      }

      const spyToolset = new SpyToolset();

      const skillWithTools: Skill = {
        frontmatter: {
          name: 'skill-with-tools',
          description: 'desc',
          metadata: {
            adk_additional_tools: ['cached_tool'],
          },
        },
        instructions: 'instructions',
      };

      const toolset = new SkillToolset([skillWithTools], {
        additionalTools: [spyToolset],
      });

      const mockState = {
        get: vi.fn().mockReturnValue(['skill-with-tools']),
      };

      const context = {
        agentName: 'test-agent',
        state: mockState,
      } as unknown as ReadonlyContext;

      const tools1 = await toolset.getTools(context);
      expect(tools1.map((t) => t.name)).toContain('cached_tool');
      expect(mockInnerGetTools).toHaveBeenCalledTimes(1);

      const tools2 = await toolset.getTools(context);
      expect(tools2.map((t) => t.name)).toContain('cached_tool');
      expect(mockInnerGetTools).toHaveBeenCalledTimes(1);
    });
  });

  describe('script output directory', () => {
    it('reuses the same directory across calls', async () => {
      const toolset = new SkillToolset([mockSkill]);

      try {
        const first = await toolset.getScriptOutputDir();
        const second = await toolset.getScriptOutputDir();

        expect(second).toBe(first);
      } finally {
        await toolset.close();
      }
    });

    it('removes the private temp directory it created on close', async () => {
      // Script output can be sensitive, and a process building one toolset per
      // session would otherwise leave a directory of it per session behind.
      const toolset = new SkillToolset([mockSkill]);
      const dir = await toolset.getScriptOutputDir();
      expect(path.dirname(dir)).toBe(os.tmpdir());
      await fs.writeFile(path.join(dir, 'output.txt'), 'sensitive');

      await toolset.close();

      await expect(fs.access(dir)).rejects.toThrow();
    });

    it('keeps a caller-supplied directory on close', async () => {
      const configuredDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'skill_toolset_test_'),
      );

      try {
        const toolset = new SkillToolset([mockSkill], {
          scriptOutputDir: configuredDir,
        });
        expect(await toolset.getScriptOutputDir()).toBe(configuredDir);

        await toolset.close();

        await fs.access(configuredDir);
      } finally {
        await fs.rm(configuredDir, {recursive: true, force: true});
      }
    });

    it('creates a fresh directory when reused after close', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const first = await toolset.getScriptOutputDir();
      await toolset.close();

      const second = await toolset.getScriptOutputDir();

      try {
        expect(second).not.toBe(first);
        await fs.access(second);
      } finally {
        await toolset.close();
      }
    });

    it('does not fail closing a toolset that never produced output', async () => {
      const toolset = new SkillToolset([mockSkill]);

      await expect(toolset.close()).resolves.toBeUndefined();
    });
  });
});
