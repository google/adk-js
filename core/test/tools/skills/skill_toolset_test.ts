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

    describe('SkillToolset close', () => {
      const remoteSkill: Skill = {
        frontmatter: {
          name: 'remote-skill',
          description: 'A remote skill',
        },
        instructions: 'Remote instructions',
      };

      it('awaits the registry close exactly once', async () => {
        const registry = {
          getSkill: vi.fn(),
          searchSkills: vi.fn(),
          close: vi.fn().mockResolvedValue(undefined),
        };
        const toolset = new SkillToolset([mockSkill], {registry});

        await toolset.close();

        expect(registry.close).toHaveBeenCalledTimes(1);
        expect(registry.close).toHaveBeenCalledWith();
      });

      it('does not resolve until the registry close settles', async () => {
        let releaseClose: () => void = () => {};
        const registry = {
          getSkill: vi.fn(),
          searchSkills: vi.fn(),
          close: vi.fn(
            () =>
              new Promise<void>((resolve) => {
                releaseClose = resolve;
              }),
          ),
        };
        const toolset = new SkillToolset([mockSkill], {registry});

        let settled = false;
        const closing = toolset.close().then(() => {
          settled = true;
        });

        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);

        releaseClose();
        await closing;
        expect(settled).toBe(true);
      });

      it('closes cleanly when the registry has no close method', async () => {
        const registry = {getSkill: vi.fn(), searchSkills: vi.fn()};
        const toolset = new SkillToolset([mockSkill], {registry});

        await expect(toolset.close()).resolves.toBeUndefined();
      });

      it('closes cleanly when there is no registry', async () => {
        const toolset = new SkillToolset([mockSkill]);

        await expect(toolset.close()).resolves.toBeUndefined();
      });

      it('clears the fetched-skill cache even when the registry close rejects', async () => {
        const registry = {
          getSkill: vi.fn().mockResolvedValue(remoteSkill),
          searchSkills: vi.fn(),
          close: vi.fn().mockRejectedValue(new Error('close failed')),
        };
        const toolset = new SkillToolset([mockSkill], {registry});

        await toolset.getOrFetchSkill('remote-skill', 'inv-1');
        expect(registry.getSkill).toHaveBeenCalledTimes(1);

        await expect(toolset.close()).rejects.toThrow('close failed');

        await toolset.getOrFetchSkill('remote-skill', 'inv-1');
        expect(registry.getSkill).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('script output directory', () => {
    it('creates one private temp directory and reuses it', async () => {
      const toolset = new SkillToolset([mockSkill]);
      const dir = await toolset.getScriptOutputDir();

      try {
        // Collision suffixing (`out_2.txt`) is only coherent if repeated calls
        // land in the same directory.
        expect(await toolset.getScriptOutputDir()).toBe(dir);
        expect(path.dirname(dir)).toBe(os.tmpdir());
        expect(dir).not.toBe(process.cwd());
      } finally {
        await fs.rm(dir, {recursive: true, force: true});
      }
    });

    it('creates a configured directory that does not exist yet', async () => {
      const parent = await fs.mkdtemp(
        path.join(os.tmpdir(), 'skill_toolset_test_'),
      );
      const configuredDir = path.join(parent, 'nested', 'output');

      try {
        const toolset = new SkillToolset([mockSkill], {
          scriptOutputDir: configuredDir,
        });

        expect(await toolset.getScriptOutputDir()).toBe(configuredDir);
        await fs.access(configuredDir);
      } finally {
        await fs.rm(parent, {recursive: true, force: true});
      }
    });

    it('resolves a relative configured directory to an absolute path', async () => {
      // materializeFiles resolves output names against this directory, so a
      // relative value must be pinned to an absolute path rather than left to
      // follow the process working directory.
      const absoluteDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'skill_toolset_test_'),
      );

      try {
        const toolset = new SkillToolset([mockSkill], {
          scriptOutputDir: path.relative(process.cwd(), absoluteDir),
        });

        expect(await toolset.getScriptOutputDir()).toBe(absoluteDir);
      } finally {
        await fs.rm(absoluteDir, {recursive: true, force: true});
      }
    });
  });
});
